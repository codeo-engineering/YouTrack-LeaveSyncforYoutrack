/*
 * Async HTTP mock for the local preview servers: queues postAsync calls and hands the response to
 * the named async function, like YouTrack does after the scheduling transaction commits.
 * graphGet(url) returns { status, body } for one Microsoft Graph request (relative URL).
 */
module.exports = function makeAsyncHttp(graphGet) {
  const pending = [];
  let current = null;

  class Connection {
    constructor(base) { this.base = base; }
    basicAuth() { return this; }
    bearerAuth() { return this; }
    addHeader() { return this; }
    postAsync(uri, q, payload, handler) {
      let response;
      if (uri.endsWith('/oauth2/v2.0/token')) {
        response = { code: 200, isSuccess: true, body: JSON.stringify({ access_token: 't' }) };
      } else if (uri === '/$batch') {
        const responses = JSON.parse(payload).requests.map(r => Object.assign({ id: r.id }, graphGet(r.url)));
        response = { code: 200, isSuccess: true, body: JSON.stringify({ responses }) };
      } else {
        response = { code: 404, isSuccess: false, body: '{}' };
      }
      pending.push({ handler, response, stored: current || {} });
    }
  }

  /** Runs an endpoint handler, then every async function it scheduled. */
  function run(httpHandler, ctx, fn) {
    current = {};
    const stored = current;
    fn(Object.assign({}, ctx, { store: (k, v) => { stored[k] = v; }, load: () => null }));
    let guard = 0;
    while (pending.length && guard++ < 200) {
      const job = pending.shift();
      const next = {};
      current = next;
      httpHandler.asyncFunctions[job.handler](Object.assign({}, ctx, {
        response: job.response,
        store: (k, v) => { next[k] = v; },
        load: k => (k in job.stored ? job.stored[k] : null)
      }));
    }
    current = null;
  }

  return { Connection, run };
};

/* End-to-end test of the backend handlers with mocked YouTrack + Microsoft Graph. */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const APP = path.resolve(process.argv[2] || path.join(__dirname, '../app'));

// ---------- mocks ----------
const users = {};
function mkUser(login, name, email, admin) {
  users[login] = {
    login, visibleName: name, email, isBanned: false, extensionProperties: {},
    hasRole: r => !!admin && r === 'System Admin',
    isInGroup: () => false
  };
  return users[login];
}
const entitiesMock = {
  User: {
    findByLogin: l => users[l] || null,
    findUniqueByEmail: e => Object.values(users).find(u => u.email && u.email.toLowerCase() === String(e).toLowerCase()) || null,
    findByExtensionProperties: q => {
      const list = Object.values(users).filter(u => Object.keys(q).every(k => u.extensionProperties[k] === q[k]));
      return { forEach: f => list.forEach(f) };
    }
  }
};
const graphCalls = [];
const graphData = {
  reasons: [
    { id: 'TOR_off', displayName: 'Off', isActive: true },
    { id: 'TOR_sick', displayName: 'Sick Day', isActive: true }
  ],
  timesOff: [
    { id: 'T1', userId: 'aad-ayse', isStagedForDeletion: false, sharedTimeOff: { startDateTime: '2026-11-08T21:00:00Z', endDateTime: '2026-11-11T21:00:00Z', timeOffReasonId: 'TOR_off' } }, // Mon-Wed
    { id: 'T2', userId: 'aad-ayse', isStagedForDeletion: false, sharedTimeOff: { startDateTime: '2026-10-01T06:00:00Z', endDateTime: '2026-10-01T10:00:00Z', timeOffReasonId: 'TOR_sick' } },
    { id: 'T3', userId: 'aad-ayse', isStagedForDeletion: true, sharedTimeOff: { startDateTime: '2026-09-01T06:00:00Z', endDateTime: '2026-09-01T10:00:00Z', timeOffReasonId: 'TOR_off' } },
    { id: 'T4', userId: 'aad-ghost', isStagedForDeletion: false, sharedTimeOff: { startDateTime: '2026-11-02T06:00:00Z', endDateTime: '2026-11-02T10:00:00Z', timeOffReasonId: 'TOR_off' } }
  ],
  users: {
    'aad-ayse': { id: 'aad-ayse', displayName: 'Ayşe Yılmaz', mail: 'ayse@example.com' },
    'aad-ghost': { id: 'aad-ghost', displayName: 'Ghost User', mail: 'ghost@other.com' }
  }
};
// Async HTTP mock: calls are queued and their responses handed to the named async function,
// like YouTrack does after the scheduling transaction commits.
const pendingAsync = [];
let execution = null; // the execution that is currently running (handler or async function)
graphData.pageSize = 1000;
const graphFaults = []; // e.g. { url: /timesOff/, status: 429, times: 1 }
function graphGet(url) {
  const [p, qs] = url.split('?');
  const params = new URLSearchParams(qs || '');
  const fault = graphFaults.find(f => f.times > 0 && f.url.test(p));
  if (fault) { fault.times--; return { status: fault.status, body: { error: { code: 'TooManyRequests', message: 'Throttled. Try later.' } } }; }
  if (p.endsWith('/timeOffReasons')) return { status: 200, body: { value: graphData.reasons } };
  if (p.endsWith('/timesOff')) {
    const skip = +(params.get('$skiptoken') || 0);
    const page = graphData.timesOff.slice(skip, skip + graphData.pageSize);
    const body = { value: page };
    if (skip + graphData.pageSize < graphData.timesOff.length) {
      body['@odata.nextLink'] = 'https://graph.microsoft.com/v1.0' + p + '?$skiptoken=' + (skip + graphData.pageSize);
    }
    return { status: 200, body };
  }
  const m = /^\/users\/([^/?]+)$/.exec(p);
  if (m) {
    const u = graphData.users[decodeURIComponent(m[1])];
    return u ? { status: 200, body: u } : { status: 404, body: { error: { code: 'Request_ResourceNotFound', message: 'Not found.' } } };
  }
  return { status: 404, body: {} };
}
class Connection {
  constructor(base) { this.base = base; this.headers = {}; }
  basicAuth(u, p) { this.auth = ['basic', u, p]; return this; }
  bearerAuth(t) { this.auth = ['bearer', t]; return this; }
  addHeader(k, v) { this.headers[k] = v; return this; }
  postSync() { throw new Error('synchronous HTTP is not allowed'); }
  getSync() { throw new Error('synchronous HTTP is not allowed'); }
  postAsync(uri, q, payload, handler) {
    assert.ok(execution, 'async call outside an execution');
    assert.ok(!execution.scheduled, 'only one async call per execution');
    execution.scheduled = true;
    graphCalls.push(['POST', this.base + uri, payload, this.auth]);
    let response;
    if (uri.endsWith('/oauth2/v2.0/token')) {
      response = graphData.tokenFails
        ? { code: 401, isSuccess: false, body: JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' }) }
        : { code: 200, isSuccess: true, body: JSON.stringify({ access_token: 'tok', expires_in: 3599 }) };
    } else if (uri === '/$batch') {
      assert.deepStrictEqual(this.auth, ['bearer', 'tok']);
      const reqs = JSON.parse(payload).requests;
      assert.ok(reqs.length <= 20, 'batch limit');
      graphData.batchSizes = (graphData.batchSizes || []).concat(reqs.length);
      const responses = reqs.map(r => Object.assign({ id: r.id }, graphGet(r.url)));
      response = { code: 200, isSuccess: true, body: JSON.stringify({ responses }) };
    } else {
      response = { code: 404, isSuccess: false, body: '{}' };
    }
    pendingAsync.push({ handler, response, stored: execution.stored, chain: execution.chain + 1 });
  }
  getAsync() { throw new Error('not used'); }
}

/** Runs queued async functions until the chain ends, enforcing YouTrack's limits. */
function drainAsync(user) {
  let steps = 0;
  while (pendingAsync.length) {
    const job = pendingAsync.shift();
    assert.ok(job.chain <= 10, 'async chain longer than 10 steps');
    assert.ok(api.asyncFunctions[job.handler], 'async function ' + job.handler + ' is declared');
    const stored = {};
    execution = { scheduled: false, stored, chain: job.chain };
    api.asyncFunctions[job.handler]({
      currentUser: user, settings, globalStorage,
      response: job.response,
      store: (k, v) => { stored[k] = v; },
      load: k => (k in job.stored ? job.stored[k] : null)
    });
    execution = null;
    if (++steps > 200) throw new Error('runaway async chain');
  }
}

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '@jetbrains/youtrack-scripting-api/entities') return 'MOCK_ENTITIES';
  if (req === '@jetbrains/youtrack-scripting-api/http') return 'MOCK_HTTP';
  return origResolve.call(this, req, ...rest);
};
require.cache.MOCK_ENTITIES = { id: 'MOCK_ENTITIES', filename: 'MOCK_ENTITIES', loaded: true, exports: entitiesMock };
require.cache.MOCK_HTTP = { id: 'MOCK_HTTP', filename: 'MOCK_HTTP', loaded: true, exports: { Connection } };

const api = require(path.join(APP, 'api.js')).httpHandler;
const globalStorage = { extensionProperties: {} };
const settings = { tenantId: '11111111-2222-3333-4444-555555555555', clientId: '66666666-7777-8888-9999-000000000000', clientSecret: 'SECRET', teamIds: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };

function call(user, method, p, { body, query } = {}) {
  const ep = api.endpoints.find(e => e.method === method && e.path === p);
  assert.ok(ep, 'endpoint ' + method + ' ' + p);
  const res = { code: 200, body: null, json(o) { this.body = JSON.parse(JSON.stringify(o)); } };
  const stored = {};
  execution = { scheduled: false, stored, chain: 0 };
  ep.handle({
    currentUser: user, settings, globalStorage,
    request: { json: () => body || {}, getParameter: n => (query || {})[n] ?? null },
    response: res,
    store: (k, v) => { stored[k] = v; },
    load: () => null
  });
  execution = null;
  if (method === 'GET') assert.strictEqual(pendingAsync.length, 0, 'GET must not start background work');
  drainAsync(user);
  return res;
}

// ---------- scenario ----------
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); process.exitCode = 1; }
}

const admin = mkUser('admin', 'Admin User', 'admin@example.com', true);
const ayse = mkUser('ayse', 'Ayşe Yılmaz', 'ayse@example.com');
const mehmet = mkUser('mehmet', 'Mehmet Kaya', 'mehmet@example.com');

t('non-admin cannot use admin endpoints', () => {
  const r = call(ayse, 'GET', 'admin-state');
  assert.strictEqual(r.code, 403);
});

t('untracked user sees "not configured"', () => {
  const r = call(ayse, 'GET', 'me');
  assert.strictEqual(r.body.configured, false);
});

t('admin adds employees with hire dates', () => {
  assert.strictEqual(call(admin, 'POST', 'admin-employee-save', { body: { login: 'ayse', hireDate: '2019-03-15' } }).code, 200);
  assert.strictEqual(call(admin, 'POST', 'admin-employee-save', { body: { login: 'mehmet', hireDate: '2025-02-01' } }).code, 200);
  const s = call(admin, 'GET', 'admin-state').body;
  assert.strictEqual(s.employees.length, 2);
});

t('validation errors come back as 400', () => {
  const r = call(admin, 'POST', 'admin-employee-save', { body: { login: 'ayse', hireDate: '15.03.2019' } });
  assert.strictEqual(r.code, 400);
});

t('admin sync imports Teams leave, reasons and unmatched people', () => {
  const r = call(admin, 'POST', 'admin-sync');
  assert.strictEqual(r.code, 202, JSON.stringify(r.body));
  assert.strictEqual(r.body.phase, 'started');
  const st = call(admin, 'GET', 'sync-status').body;
  assert.strictEqual(st.phase, 'idle');
  assert.ok(st.lastSyncSummary && st.lastSyncSummary.items === 3, JSON.stringify(st));
  assert.strictEqual(globalStorage.extensionProperties.leaveSync, null, 'sync state is cleared');
  assert.ok(!JSON.stringify(globalStorage.extensionProperties).includes('tok'), 'token never stored');
  const tokenCall = graphCalls.find(c => c[0] === 'POST');
  assert.deepStrictEqual(tokenCall[3], ['basic', '66666666-7777-8888-9999-000000000000', 'SECRET']);
  assert.ok(!String(tokenCall[2]).includes('SECRET'), 'secret must not be in the body');
  const s = call(admin, 'GET', 'admin-state').body;
  assert.strictEqual(s.reasons.length, 2);
  assert.ok(s.reasons.every(x => !x.reviewed && !x.deducts));
  assert.strictEqual(s.unmatched.length, 1);
  assert.strictEqual(s.unmatched[0].email, 'ghost@other.com');
  const recs = JSON.parse(ayse.extensionProperties.leaveRecords);
  assert.deepStrictEqual(recs.map(x => x.id).sort(), ['T1', 'T2']); // staged deletion skipped
});

t('nothing deducted until the admin marks "Off" as annual leave', () => {
  let me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedDays, 0);
  call(admin, 'POST', 'admin-config-save', { body: { reasons: { TOR_off: { deducts: true }, TOR_sick: { deducts: false } } } });
  me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedDays, 3);
  const sick = me.balance.current.usageByType.find(u => u.name === 'Sick Day');
  assert.strictEqual(sick.hours, 4);
});

t('employee sees only own data', () => {
  const me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.user.login, 'ayse');
  assert.ok(!JSON.stringify(me).includes('mehmet'));
  assert.ok(!JSON.stringify(me).includes('SECRET'));
  assert.strictEqual(me.isAdmin, false);
});

t('opening balance auto, then admin override + adjustment, audit trail', () => {
  let d = call(admin, 'GET', 'admin-employee', { query: { login: 'ayse' } }).body;
  assert.strictEqual(d.balance.openingIsAuto, true);
  const auto = d.balance.openingAuto;
  assert.ok(auto > 0);
  call(admin, 'POST', 'admin-employee-save', { body: { login: 'ayse', hireDate: '2019-03-15', openingDays: 4, openingConfirmed: true } });
  call(admin, 'POST', 'admin-adjustment-add', { body: { login: 'ayse', date: d.balance.current.start, days: 1, note: 'Bonus day' } });
  d = call(admin, 'GET', 'admin-employee', { query: { login: 'ayse' } }).body;
  assert.strictEqual(d.balance.current.carryIn, 4);
  assert.strictEqual(d.balance.current.remainingDays, 4 + d.balance.current.entitlement + 1 - 3);
  const audit = call(admin, 'GET', 'admin-audit').body.entries;
  assert.ok(audit.length >= 4);
  assert.strictEqual(audit[0].action, 'Adjustment added');
});

t('adjustment without note is rejected', () => {
  const r = call(admin, 'POST', 'admin-adjustment-add', { body: { login: 'ayse', date: '2026-11-01', days: 1 } });
  assert.strictEqual(r.code, 400);
});

t('linking an unmatched Teams user and re-syncing imports their leave', () => {
  const ghost = mkUser('ghost', 'Ghost User', 'ghost@example.com');
  call(admin, 'POST', 'admin-employee-save', { body: { login: 'ghost', hireDate: '2020-01-01' } });
  call(admin, 'POST', 'admin-map-user', { body: { aadId: 'aad-ghost', login: 'ghost' } });
  call(admin, 'POST', 'admin-sync');
  const me = call(ghost, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedHours, 4);
  assert.strictEqual(call(admin, 'GET', 'admin-state').body.unmatched.length, 0);
});

t('cancelled leave disappears on the next sync', () => {
  graphData.timesOff = graphData.timesOff.filter(x => x.id !== 'T1');
  call(admin, 'POST', 'admin-sync');
  const me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedDays, 0);
});

t('employee-triggered sync respects the interval; forced sync needs admin', () => {
  const before = graphCalls.length;
  const r = call(ayse, 'POST', 'sync');
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.phase, 'fresh');
  assert.strictEqual(graphCalls.length, before, 'no Microsoft call when data is fresh');
  assert.strictEqual(call(ayse, 'POST', 'sync', { body: { force: true } }).code, 403);
  assert.ok(!('lastSyncError' in call(ayse, 'GET', 'sync-status').body), 'employees get no error details');
});

t('calendar change: Saturday becomes a working day', () => {
  call(admin, 'POST', 'admin-config-save', { body: { weekendDays: [0] } });
  const s = call(admin, 'GET', 'admin-state').body;
  assert.deepStrictEqual(s.calendar.weekendDays, [0]);
});



t('e-mail autofilled into tenant ID gives a clear error', () => {
  const saved = settings.tenantId;
  settings.tenantId = 'someone@example.com';
  const r = call(admin, 'POST', 'admin-sync');
  settings.tenantId = saved;
  assert.strictEqual(r.body.phase, 'failed');
  assert.ok(/e-mail address/.test(r.body.lastSyncError.message), JSON.stringify(r.body));
  assert.ok(!r.body.lastSyncError.message.includes('someone@example.com'), 'no user input echoed back');
});
t('new hire inside Teams history is tracked from the hire date automatically', () => {
  const nova = mkUser('nova', 'Nova Yeni', 'nova@example.com');
  const iso = d => d.toISOString().slice(0, 10);
  const hire = new Date(); hire.setUTCDate(hire.getUTCDate() - 300);
  const hireIso = iso(hire);
  call(admin, 'POST', 'admin-employee-save', { body: { login: 'nova', hireDate: hireIso } });
  const d = call(admin, 'GET', 'admin-employee', { query: { login: 'nova' } }).body;
  assert.strictEqual(d.profile.trackFrom, hireIso);
  assert.strictEqual(d.balance.trackingStart, hireIso);
  assert.strictEqual(d.periodStarts[0], hireIso);
});

t('admin can move the tracking start and set "remaining today"', () => {
  call(admin, 'POST', 'admin-employee-save', { body: { login: 'mehmet', hireDate: '2025-02-01', trackFrom: '2025-02-01', remainingToday: 7 } });
  const d = call(admin, 'GET', 'admin-employee', { query: { login: 'mehmet' } }).body;
  assert.strictEqual(d.balance.trackingStart, '2025-02-01');
  assert.strictEqual(d.balance.current.remainingDays, 7);
  assert.strictEqual(d.profile.openingConfirmed, true);
  assert.strictEqual(d.profile.openingFromRemaining.remaining, 7);
});

t('admins can open any employee; employees cannot', () => {
  assert.strictEqual(call(ayse, 'GET', 'me', { query: { login: 'mehmet' } }).code, 403);
  const r = call(admin, 'GET', 'me', { query: { login: 'ayse' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.user.login, 'ayse');
  assert.strictEqual(r.body.viewingOther, true);
  assert.ok(r.body.balance.configured);
});

t('team overview lists every tracked employee with a day log (admins only)', () => {
  assert.strictEqual(call(ayse, 'GET', 'admin-overview').code, 403);
  const o = call(admin, 'GET', 'admin-overview').body;
  assert.ok(o.employees.length >= 3);
  const a = o.employees.find(e => e.login === 'ayse');
  assert.ok(Array.isArray(a.dayLog));
  assert.ok(a.current && typeof a.current.remainingDays === 'number');
  assert.ok(o.reasons.TOR_off.deducts);
});

t('manager change in the Shifts schedule (not shared yet) is counted as in the schedule', () => {
  graphData.timesOff.push({
    id: 'T9', userId: 'aad-ayse', isStagedForDeletion: false,
    sharedTimeOff: { startDateTime: '2026-10-12T05:00:00Z', endDateTime: '2026-10-17T14:00:00Z', timeOffReasonId: 'TOR_off' },
    draftTimeOff: { startDateTime: '2026-10-12T05:00:00Z', endDateTime: '2026-10-12T14:00:00Z', timeOffReasonId: 'TOR_off' }
  });
  call(admin, 'POST', 'admin-sync');
  const me = call(ayse, 'GET', 'me').body;
  const r = me.balance.records.find(x => x.id === 'T9');
  assert.ok(r.unshared);
  assert.strictEqual(r.hours, 8);
  assert.strictEqual(me.balance.current.usedHours, 8);
});

t('with "count unshared changes" off, the shared version counts', () => {
  call(admin, 'POST', 'admin-config-save', { body: { useDrafts: false } });
  call(admin, 'POST', 'admin-sync');
  const me = call(ayse, 'GET', 'me').body;
  // Sat is a working day in this test (calendar test above): 12–17 Oct = 6 × 8 h,
  // plus T3 (4 h) whose deletion is only staged – employees still see it in Teams.
  assert.strictEqual(me.balance.current.usedHours, 52);
  call(admin, 'POST', 'admin-config-save', { body: { useDrafts: true } });
  call(admin, 'POST', 'admin-sync');
});

t('admin can correct a single leave; it survives syncs and can be reset', () => {
  assert.strictEqual(call(admin, 'POST', 'admin-record-override', { body: { login: 'ayse', recId: 'T9', mode: 'hours', days: 0.5 } }).code, 400); // note required
  call(admin, 'POST', 'admin-record-override', { body: { login: 'ayse', recId: 'T9', mode: 'hours', days: 0.5, note: 'Half day only' } });
  call(admin, 'POST', 'admin-sync');
  let me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedHours, 4);
  assert.strictEqual(me.balance.records.find(x => x.id === 'T9').override.note, 'Half day only');
  call(admin, 'POST', 'admin-record-override', { body: { login: 'ayse', recId: 'T9', mode: 'exclude', note: 'Cancelled' } });
  me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedHours, 0);
  call(admin, 'POST', 'admin-record-override', { body: { login: 'ayse', recId: 'T9', mode: 'clear' } });
  me = call(ayse, 'GET', 'me').body;
  assert.strictEqual(me.balance.current.usedHours, 8);
  assert.strictEqual(call(ayse, 'POST', 'admin-record-override', { body: { login: 'ayse', recId: 'T9', mode: 'exclude', note: 'x' } }).code, 403);
});

t('Microsoft sign-in error is reported with the AADSTS code only', () => {
  graphData.tokenFails = true;
  call(admin, 'POST', 'admin-sync');
  graphData.tokenFails = false;
  const st = call(admin, 'GET', 'sync-status').body;
  assert.ok(/AADSTS7000215/.test(st.lastSyncError.message), st.lastSyncError.message);
  assert.ok(!/Trace ID/.test(st.lastSyncError.message));
  assert.strictEqual(st.phase, 'idle');
});

t('unmatched people are not looked up again on every sync', () => {
  const lookups = () => graphCalls.filter(c => c[1].endsWith('/$batch') && /\/users\//.test(c[2])).length;
  graphData.timesOff.push({ id: 'T20', userId: 'aad-stranger', isStagedForDeletion: false, sharedTimeOff: { startDateTime: '2026-11-03T06:00:00Z', endDateTime: '2026-11-03T10:00:00Z', timeOffReasonId: 'TOR_off' } });
  graphData.users['aad-stranger'] = { id: 'aad-stranger', displayName: 'Stranger', mail: 'stranger@elsewhere.org' };
  const a = lookups();
  call(admin, 'POST', 'sync', { body: { force: true } });
  assert.strictEqual(lookups(), a + 1, 'looked up once');
  const cfg = JSON.parse(globalStorage.extensionProperties.leaveConfig);
  cfg.lastSyncAt = null; globalStorage.extensionProperties.leaveConfig = JSON.stringify(cfg);
  call(ayse, 'POST', 'sync'); // automatic refresh
  assert.strictEqual(lookups(), a + 1, 'not looked up again by an automatic refresh');
  assert.ok(call(admin, 'GET', 'admin-state').body.unmatched.some(u => u.email === 'stranger@elsewhere.org'));
});

t('many pages: paging across chains stays within the async limits and resumes', () => {
  const extra = [];
  for (let i = 0; i < 60; i++) {
    extra.push({ id: 'P' + i, userId: 'aad-ayse', isStagedForDeletion: false, sharedTimeOff: { startDateTime: '2026-06-' + String(1 + (i % 28)).padStart(2, '0') + 'T06:00:00Z', endDateTime: '2026-06-' + String(1 + (i % 28)).padStart(2, '0') + 'T07:00:00Z', timeOffReasonId: 'TOR_sick' } });
  }
  const saved = graphData.timesOff;
  graphData.timesOff = saved.concat(extra);
  graphData.pageSize = 5; // 13 pages -> more than one chain
  let r = call(admin, 'POST', 'admin-sync');
  assert.strictEqual(r.code, 202);
  let st = call(admin, 'GET', 'sync-status').body;
  assert.strictEqual(st.phase, 'paused', JSON.stringify(st));
  let guard = 0;
  while (st.phase === 'paused' && guard++ < 5) { call(ayse, 'POST', 'sync'); st = call(admin, 'GET', 'sync-status').body; }
  assert.strictEqual(st.phase, 'idle');
  assert.strictEqual(st.lastSyncSummary.items, graphData.timesOff.filter(x => !x.isStagedForDeletion).length);
  assert.strictEqual(JSON.parse(ayse.extensionProperties.leaveRecords).filter(x => /^P/.test(x.id)).length, 60);
  graphData.timesOff = saved;
  graphData.pageSize = 1000;
  call(admin, 'POST', 'admin-sync');
});

t('throttled requests are retried; a running sync is not started twice', () => {
  graphFaults.push({ url: /timesOff$/, status: 429, times: 1 });
  call(admin, 'POST', 'admin-sync');
  const st = call(admin, 'GET', 'sync-status').body;
  assert.strictEqual(st.lastSyncError, null, JSON.stringify(st.lastSyncError));
  // Simulate a sync that is still running: a second request must not start another one.
  globalStorage.extensionProperties.leaveSync = JSON.stringify({ id: 'x', running: true, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const before = graphCalls.length;
  const r = call(admin, 'POST', 'admin-sync');
  assert.strictEqual(r.body.phase, 'running');
  assert.strictEqual(graphCalls.length, before);
  globalStorage.extensionProperties.leaveSync = null;
});

t('a Graph permission error stops the sync with a clear message and keeps the data', () => {
  const before = ayse.extensionProperties.leaveRecords;
  graphFaults.push({ url: /timeOffReasons$/, status: 403, times: 1 });
  call(admin, 'POST', 'admin-sync');
  const st = call(admin, 'GET', 'sync-status').body;
  assert.ok(/Schedule\.Read\.All/.test(st.lastSyncError.message), st.lastSyncError.message);
  assert.strictEqual(ayse.extensionProperties.leaveRecords, before);
  assert.strictEqual(globalStorage.extensionProperties.leaveSync, null);
});

console.log('\n' + passed + ' passed');

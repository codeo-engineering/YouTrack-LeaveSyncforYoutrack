/* Local preview: serves the widgets with a mocked YTApp host that calls the real backend handlers. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const APP = path.join(__dirname, '../app');

const users = {};
function mkUser(login, name, email, admin) {
  users[login] = { login, visibleName: name, email, isBanned: false, extensionProperties: {}, hasRole: r => !!admin && r === 'System Admin', isInGroup: () => false };
}
const entitiesMock = { User: {
  findByLogin: l => users[l] || null,
  findUniqueByEmail: e => Object.values(users).find(u => u.email === e) || null,
  findByExtensionProperties: q => { const l = Object.values(users).filter(u => Object.keys(q).every(k => u.extensionProperties[k] === q[k])); return { forEach: f => l.forEach(f) }; }
} };
const iso = (d, h1, h2) => [new Date(Date.parse(d + 'T00:00:00+03:00') + (h1 || 0) * 3600e3).toISOString(), new Date(Date.parse(d + 'T00:00:00+03:00') + (h2 || 24) * 3600e3).toISOString()];
function off(id, user, from, toDays, reason, h1, h2) {
  const [s] = iso(from, h1 || 0, 0);
  const e = h2 ? iso(from, 0, h2)[1] : new Date(Date.parse(from + 'T00:00:00+03:00') + toDays * 864e5).toISOString();
  return { id, userId: user, isStagedForDeletion: false, sharedTimeOff: { startDateTime: s, endDateTime: e, timeOffReasonId: reason } };
}
const P = ['chloe.adams','ethan.brooks','grace.miller','hannah.reed','isabel.turner','owen.carter','sophie.ellis','evan.stone'];
const NAMES = { 'chloe.adams':'Chloe Adams','ethan.brooks':'Ethan Brooks','grace.miller':'Grace Miller','hannah.reed':'Hannah Reed',
  'isabel.turner':'Isabel Turner','owen.carter':'Owen Carter','sophie.ellis':'Sophie Ellis','evan.stone':'Evan Stone' };
const AAD = {}; P.forEach((l, i) => { AAD[l] = '0d4f' + (1000 + i) + 'a-7c2e-4b1d-9e3a-5f60' + (100000 + i * 7919); });
const unknownIds = ['23f6e1b2-6cc4-4622-a7f0-7e23b8a9400a','1d3e08db-492a-415a-9709-adf8ad84def5','362f0ba3-ec0e-4314-a7d1-d17ea4b14ad4','edb927c3-a199-4f4a-b637-cfc8f7ac3371','690e7fe7-c791-44df-bfd6-ba77f32b0152'];
const graph = {
  reasons: [['TOR_off','Vacation'],['TOR_s','Sick Day'],['TOR_p','Parental Leave'],['TOR_dr',"Doctor's Report"]].map(([id, n]) => ({ id, displayName: n, isActive: true })),
  timesOff: [],
  users: {}
};
let n = 0;
P.forEach((l, i) => {
  graph.users[AAD[l]] = { mail: l + '@example.com', displayName: NAMES[l] };
  ['2025-12-15', '2026-03-09', '2026-06-22', '2026-08-10', '2026-10-19'].forEach((d, k) => {
    graph.timesOff.push(off('t' + (n++), AAD[l], d, (i + k) % 3 + 1, k === 2 ? 'TOR_s' : 'TOR_off'));
  });
});
// one leave changed in the Shifts schedule but not shared yet
graph.timesOff.push(Object.assign(off('tdraft', AAD['owen.carter'], '2026-10-12', 5, 'TOR_off'),
  { draftTimeOff: off('x', AAD['owen.carter'], '2026-10-12', 1, 'TOR_off').sharedTimeOff }));
// someone whose Teams e-mail differs from YouTrack
graph.users['aad-oliver'] = { mail: 'oliver.hayes@example.co.uk', displayName: 'Oliver Hayes' };
graph.timesOff.push(off('tol', 'aad-oliver', '2026-09-07', 2, 'TOR_off'));
unknownIds.forEach((id, k) => graph.timesOff.push(off('tu' + k, id, '2026-0' + (k + 3) + '-1' + k, 1, 'TOR_off')));
const resp = (code, b) => ({ code, isSuccess: code < 400, response: JSON.stringify(b), json: () => b });
class Connection {
  constructor(b) { this.b = b; } basicAuth() { return this; } bearerAuth() { return this; } addHeader() { return this; }
  postSync() { return resp(200, { access_token: 't' }); }
  getSync(uri) {
    if (uri.endsWith('/timeOffReasons')) return resp(200, { value: graph.reasons });
    if (uri.endsWith('/timesOff')) return resp(200, { value: graph.timesOff });
    const m = /^\/users\/(.+)$/.exec(uri); if (m) { const u = graph.users[decodeURIComponent(m[1])]; return u ? resp(200, u) : resp(404, {}); }
    return resp(404, {});
  }
}
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === '@jetbrains/youtrack-scripting-api/entities') return 'ME';
  if (r === '@jetbrains/youtrack-scripting-api/http') return 'MH';
  return orig.call(this, r, ...a);
};
require.cache.ME = { id: 'ME', filename: 'ME', loaded: true, exports: entitiesMock };
require.cache.MH = { id: 'MH', filename: 'MH', loaded: true, exports: { Connection } };
const api = require(path.join(APP, 'api.js')).httpHandler;
const gs = { extensionProperties: {} };
const settings = { tenantId: '11111111-2222-3333-4444-555555555555', clientId: '66666666-7777-8888-9999-000000000000', clientSecret: 's', teamIds: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
function call(login, method, p, body, query) {
  const ep = api.endpoints.find(e => e.method === method && e.path === p);
  const res = { code: 200, body: null, json(o) { this.body = o; } };
  ep.handle({ currentUser: users[login], settings, globalStorage: gs, request: { json: () => body || {}, getParameter: n => (query || {})[n] ?? null }, response: res });
  return res;
}

// seed
mkUser('isabel.turner', 'Isabel Turner', 'isabel.turner@example.com', true);
P.filter(l => l !== 'isabel.turner').forEach(l => mkUser(l, NAMES[l], l + '@example.com'));
mkUser('oliver.hayes', 'Oliver Hayes', 'oliver.hayes@example.com');
P.forEach((l, i) => call('isabel.turner', 'POST', 'admin-employee-save', { login: l, hireDate: (2018 + i % 6) + '-0' + (1 + i % 9) + '-15', addedOn: '2023-11-09', openingConfirmed: true }));
call('isabel.turner', 'POST', 'admin-sync', { force: true });
call('isabel.turner', 'POST', 'admin-config-save', { reasons: { TOR_off: { deducts: true }, TOR_s: { deducts: false }, TOR_p: { deducts: false }, TOR_dr: { deducts: false } } });
const mock = `
window.YTApp = { me: {}, register: async () => ({
  fetchApp: async (url, o) => {
    o = o || {};
    const q = new URLSearchParams(o.query || {}).toString();
    const r = await fetch('/__api/' + url.replace('api/', '') + '?as=' + (window.AS || 'isabel.turner') + (q ? '&' + q : ''), { method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined });
    const b = await r.json(); if (!r.ok) { const e = new Error('HTTP ' + r.status); e.data = b; throw e; } return b;
  },
  fetchYouTrack: async () => (await fetch('/__users')).json(),
  storage: { getItem: async k => localStorage.getItem(k), setItem: async (k, v) => localStorage.setItem(k, v) }
}) };`;

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__mock.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(mock); }
  if (u.pathname === '/__users') return res.end(JSON.stringify(Object.values(users).map(x => ({ login: x.login, fullName: x.visibleName, email: x.email }))));
  if (u.pathname.startsWith('/__api/')) {
    let data = ''; req.on('data', c => { data += c; });
    req.on('end', () => {
      const q = Object.fromEntries(u.searchParams);
      const r = call(q.as, req.method, u.pathname.slice(7), data ? JSON.parse(data) : {}, q);
      res.statusCode = r.code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(r.body));
    });
    return;
  }
  const file = path.join(APP, 'widgets', u.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  let body = fs.readFileSync(file);
  if (file.endsWith('.html')) {
    const as = u.searchParams.get('as') || 'isabel.turner';
    body = body.toString().replace('<script src="../common.js"></script>', `<script>window.AS=${JSON.stringify(as)}</script><script src="/__mock.js"></script><script src="../common.js"></script>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  } else if (file.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
  else if (file.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
  else if (file.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
  res.end(body);
}).listen(8765, () => console.log('preview on http://localhost:8765/leaves/index.html'));

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
const graph = {
  reasons: [['TOR_h', 'Hospital'], ['TOR_off', 'Off'], ['TOR_m', 'Masters'], ['TOR_mar', 'Marriage Leave'], ['TOR_p', 'Parental Leave'], ['TOR_s', 'Sick Day'], ['TOR_new', 'Volunteering']]
    .map(([id, n]) => ({ id, displayName: n, isActive: true })),
  timesOff: [
    off('a1', 'aad-isabel', '2026-04-06', 5, 'TOR_off'),
    off('a2', 'aad-isabel', '2026-07-20', 5, 'TOR_off'),
    off('a3', 'aad-isabel', '2026-09-14', 1, 'TOR_s'),
    off('a4', 'aad-isabel', '2026-10-27', 3, 'TOR_off'),
    off('a5', 'aad-isabel', '2026-11-11', 0, 'TOR_off', 13, 17),
    off('a6', 'aad-isabel', '2026-06-03', 1, 'TOR_h'),
    Object.assign(off('b1', 'aad-can', '2026-08-03', 10, 'TOR_off'), { draftTimeOff: off('x', 'aad-can', '2026-08-03', 1, 'TOR_off').sharedTimeOff }),
    off('b2', 'aad-can', '2026-10-05', 2, 'TOR_mar'),
    off('c1', 'aad-elif', '2026-05-25', 5, 'TOR_off'),
    off('x1', 'aad-unknown', '2026-10-12', 1, 'TOR_off')
  ],
  users: { 'aad-isabel': { mail: 'isabel@example.com', displayName: 'Isabel Turner' }, 'aad-can': { mail: 'can@example.com', displayName: 'Can Demir' }, 'aad-elif': { mail: 'elif@example.com', displayName: 'Elif Şahin' }, 'aad-unknown': { mail: 'deniz.ext@example.org', displayName: 'Deniz Aksoy' } }
};
const resp = (code, b) => ({ code, isSuccess: code < 400, response: JSON.stringify(b), json: () => b });
class Connection {
  constructor(b) { this.b = b; } basicAuth() { return this; } bearerAuth() { return this; } addHeader() { return this; }
  postSync() { return resp(200, { access_token: 't' }); }
  getSync(uri) {
    if (uri.endsWith('/timeOffReasons')) return resp(200, { value: graph.reasons });
    if (uri.endsWith('/timesOff')) return resp(200, { value: graph.timesOff });
    const m = /^\/users\/(.+)$/.exec(uri); if (m) return resp(200, graph.users[decodeURIComponent(m[1])] || {});
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
mkUser('isabel', 'Isabel Turner', 'isabel@example.com', true);
mkUser('can', 'Can Demir', 'can@example.com');
mkUser('elif', 'Elif Şahin', 'elif@example.com');
mkUser('mert', 'Mert Öztürk', 'mert@example.com');
mkUser('zeynep', 'Zeynep Arslan', 'zeynep@example.com');
call('isabel', 'POST', 'admin-employee-save', { login: 'isabel', hireDate: '2019-03-15', addedOn: '2026-11-11', openingDays: 6, openingConfirmed: true });
call('isabel', 'POST', 'admin-employee-save', { login: 'can', hireDate: '2023-06-01', addedOn: '2026-11-11' });
call('isabel', 'POST', 'admin-employee-save', { login: 'elif', hireDate: '2010-09-01', birthDate: '1975-05-02', addedOn: '2026-11-11', openingDays: 12.5, openingConfirmed: true });
call('isabel', 'POST', 'admin-employee-save', { login: 'mert', hireDate: '2026-02-16', addedOn: '2026-11-11', openingConfirmed: true });
call('isabel', 'POST', 'admin-sync', { force: true });
const reasons = {}; ['TOR_h', 'TOR_off', 'TOR_m', 'TOR_mar', 'TOR_p', 'TOR_s'].forEach(id => { reasons[id] = { deducts: id === 'TOR_off' }; });
call('isabel', 'POST', 'admin-config-save', { reasons });
call('isabel', 'POST', 'admin-adjustment-add', { login: 'isabel', date: '2026-03-15', days: 1, note: 'Extra day for 2025 overtime' });

if (process.env.PRESET === 'DE') {
  call('isabel', 'POST', 'admin-config-save', { holidayCountry: 'DE', utcOffsetMinutes: 60, dstRule: 'EU', holidays: [
    { date: '2026-01-06', name: 'Epiphany (Bavaria)', half: false },
    { date: '2026-06-04', name: 'Corpus Christi (Bavaria)', half: false },
    { date: '2026-08-15', name: 'Assumption Day (Bavaria)', half: false },
    { date: '2026-11-01', name: "All Saints' Day (Bavaria)", half: false },
    { date: '2026-12-24', name: 'Christmas Eve', half: true },
    { date: '2026-12-31', name: "New Year's Eve", half: true }
  ] });
}
const mock = `
window.YTApp = { me: {}, register: async () => ({
  fetchApp: async (url, o) => {
    o = o || {};
    const q = new URLSearchParams(o.query || {}).toString();
    const r = await fetch('/__api/' + url.replace('api/', '') + '?as=' + (window.AS || 'isabel') + (q ? '&' + q : ''), { method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined });
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
    const as = u.searchParams.get('as') || 'isabel';
    body = body.toString().replace('<script src="../common.js"></script>', `<script>window.AS=${JSON.stringify(as)}</script><script src="/__mock.js"></script><script src="../common.js"></script>`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  } else if (file.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
  else if (file.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
  else if (file.endsWith('.svg')) res.setHeader('Content-Type', 'image/svg+xml');
  res.end(body);
}).listen(8765, () => console.log('preview on http://localhost:8765/leaves/index.html'));

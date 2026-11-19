/**
 * Leave Sync for YouTrack – Microsoft Teams Shifts synchronisation (utility module).
 *
 * Every Microsoft call is an asynchronous HTTP request. The HTTP handler that starts a sync
 * returns right away; the work continues as a chain of async functions declared in
 * exports.httpHandler.asyncFunctions (see api.js):
 *
 *   handler  ── postAsync token ──►  onToken  ── postAsync $batch ──►  onBatch ── … ──► onBatch (finish)
 *
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token   (client credentials)
 *   POST https://graph.microsoft.com/v1.0/$batch, up to 20 requests per call:
 *        GET /teams/{teamId}/schedule/timeOffReasons   (Schedule.Read.All)
 *        GET /teams/{teamId}/schedule/timesOff         (Schedule.Read.All, follows @odata.nextLink)
 *        GET /users/{id}                               (User.Read.All, only for people not matched yet)
 *
 * Each execution schedules exactly one async HTTP call. A chain uses at most 9 steps; if more work
 * is left (very large teams), the sync pauses and the next sync request resumes it with a new token.
 * Sync progress is kept in AppGlobalStorage.leaveSync and cleared when the sync finishes.
 * The access token only travels through the async execution context (ctx.store), never storage.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const entities = require('@jetbrains/youtrack-scripting-api/entities');
const store = require('./store');
const engine = require('./engine');

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 30000;
const BATCH_SIZE = 20;          // Microsoft Graph JSON batching limit
const CHAIN_LIMIT = 9;          // steps used per chain (YouTrack's default maximum is 10)
const MAX_PAGES_PER_TEAM = 100; // safety stop for runaway paging
const MAX_RETRIES = 2;          // per request, for throttling (429) and transient 5xx errors
const STALE_RUN_MS = 5 * 60000; // a running sync with no progress for this long is considered dead
const PAUSE_RESUME_MS = 30 * 60000; // a paused sync older than this starts over
const LOOKUP_RETRY_MS = 7 * 86400000; // people not found in YouTrack are looked up again after 7 days

class SyncError extends Error {
  constructor(message) { super(message); this.userFacing = true; }
}

function isConfigured(settings) {
  return !!(settings && settings.tenantId && settings.clientId && settings.clientSecret && settings.teamIds);
}

function teamIdList(settings) {
  return String(settings.teamIds || '').split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Catches typical copy/paste and browser-autofill mistakes before calling Microsoft. */
function validateSettings(settings) {
  const tenant = String(settings.tenantId || '').trim();
  const client = String(settings.clientId || '').trim();
  if (tenant.indexOf('@') !== -1) {
    throw new SyncError('The "Microsoft Entra tenant ID" setting contains an e-mail address. Your browser probably autofilled it. Enter the Directory (tenant) ID from the app\'s Overview page in Entra, and re-enter the client secret too: it may have been autofilled with a password.');
  }
  if (!GUID_RE.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenant)) {
    throw new SyncError('The "Microsoft Entra tenant ID" setting is not a valid Directory (tenant) ID. It should look like 1a2b3c4d-1111-2222-3333-444455556666.');
  }
  if (!GUID_RE.test(client)) {
    throw new SyncError('The "Application (client) ID" setting is not a valid ID. Copy it from the app\'s Overview page in Entra (not the Object ID or the Secret ID).');
  }
  const teams = teamIdList(settings);
  if (teams.length > 20) throw new SyncError('Too many Teams team IDs: up to 20 teams are supported.');
  teams.forEach(function (id) {
    if (!GUID_RE.test(id)) {
      throw new SyncError('A Teams team ID is not valid. Use the GUID after groupId= in the team link.');
    }
  });
}

// ---------- sync state (AppGlobalStorage.leaveSync) ----------

function getState(ctx) {
  const raw = ctx.globalStorage.extensionProperties.leaveSync;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function saveState(ctx, state) {
  ctx.globalStorage.extensionProperties.leaveSync = state ? JSON.stringify(state) : null;
}

function newId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

/** Start of the Teams window: the earliest tracked leave year, at least 400 days and at most ~3 years back. */
function windowStart(cfg, today) {
  let since = engine.addDays(today, -400);
  store.listEmployees().forEach(function (u) {
    const p = store.getProfile(u);
    if (!p.hireDate || !engine.isValidIso(p.hireDate)) return;
    const start = engine.trackingStartFor(p, today);
    if (start < since) since = start;
  });
  const floor = engine.addDays(today, -1100);
  return since < floor ? floor : since;
}

function teamPath(teamId, what) {
  return '/teams/' + encodeURIComponent(teamId) + '/schedule/' + what;
}

/** Public status for the widgets. Admins also get error details. */
function status(ctx, cfg, admin) {
  const st = getState(ctx);
  const now = Date.now();
  let phase = 'idle';
  if (st && st.running && now - Date.parse(st.updatedAt) < STALE_RUN_MS) phase = 'running';
  else if (st && st.paused && now - Date.parse(st.updatedAt) < PAUSE_RESUME_MS) phase = 'paused';
  const out = {
    phase: phase,
    startedAt: phase !== 'idle' ? st.startedAt : null,
    lastSyncAt: cfg.lastSyncAt || null,
    failed: !!cfg.lastSyncError
  };
  if (admin) {
    out.lastSyncError = cfg.lastSyncError || null;
    out.lastSyncSummary = cfg.lastSyncSummary || null;
    if (phase !== 'idle') out.progress = { items: st.itemCount || 0, requests: st.requests || 0 };
  }
  return out;
}

// ---------- starting and resuming ----------

/**
 * Starts (or resumes) a sync and returns immediately.
 * Returns { phase: 'fresh' | 'running' | 'started' | 'resumed' | 'not-configured' | 'failed' }.
 */
function start(ctx, opts) {
  opts = opts || {};
  const settings = ctx.settings || {};
  const cfg = store.getConfig(ctx);
  if (!isConfigured(settings)) return { phase: 'not-configured' };

  const now = Date.now();
  let st = getState(ctx);
  if (st && st.running && now - Date.parse(st.updatedAt) < STALE_RUN_MS) return { phase: 'running', startedAt: st.startedAt };

  const resuming = !!(st && st.paused && now - Date.parse(st.updatedAt) < PAUSE_RESUME_MS);
  if (!resuming && !opts.force) {
    const last = cfg.lastSyncAt ? Date.parse(cfg.lastSyncAt) : 0;
    const interval = Math.max(5, +cfg.syncIntervalMinutes || 30) * 60000;
    if (now - last < interval) return { phase: 'fresh', lastSyncAt: cfg.lastSyncAt };
  }

  try {
    validateSettings(settings);
  } catch (e) {
    recordFailure(ctx, e);
    return { phase: 'failed' };
  }

  if (resuming) {
    st.running = true;
    st.paused = false;
    st.chainStep = 0;
  } else {
    const today = engine.todayIso(cfg);
    st = {
      id: newId(),
      running: true,
      paused: false,
      startedAt: new Date(now).toISOString(),
      today: today,
      since: windowStart(cfg, today),
      useDrafts: cfg.useDrafts !== false,
      recheckUnmatched: !!opts.force,
      queue: [],
      items: [],
      itemCount: 0,
      unshared: 0,
      reasons: {},
      pages: {},
      looked: {},
      lookups: {},
      requests: 0,
      chainStep: 0
    };
    teamIdList(settings).forEach(function (teamId) {
      st.queue.push({ kind: 'reasons', teamId: teamId, url: teamPath(teamId, 'timeOffReasons') });
      st.queue.push({ kind: 'timesOff', teamId: teamId, url: teamPath(teamId, 'timesOff') });
    });
  }
  st.updatedAt = new Date(now).toISOString();
  saveState(ctx, st);

  requestToken(ctx, settings, st.id);
  return { phase: resuming ? 'resumed' : 'started', startedAt: st.startedAt };
}

function requestToken(ctx, settings, syncId) {
  const c = new http.Connection(LOGIN, null, TIMEOUT_MS);
  // client_secret_basic: the secret setting is only ever handed to the http module's auth helper.
  c.basicAuth(String(settings.clientId).trim(), settings.clientSecret);
  c.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  c.addHeader('Accept', 'application/json');
  ctx.store('syncId', syncId);
  c.postAsync(
    '/' + encodeURIComponent(String(settings.tenantId).trim()) + '/oauth2/v2.0/token',
    null,
    'grant_type=client_credentials&scope=' + encodeURIComponent('https://graph.microsoft.com/.default'),
    'onToken'
  );
}

// ---------- reading async responses ----------

function responseOf(ctx) {
  const r = ctx.response || {};
  const text = r.body !== undefined && r.body !== null ? r.body : (r.response !== undefined ? r.response : null);
  let json = null;
  if (text) {
    try { json = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { json = null; }
  }
  return { ok: !!r.isSuccess, code: r.code || r.status || null, json: json };
}

/** A short, safe description of a Microsoft error (error code and first sentence only). */
function microsoftError(json) {
  if (!json) return '';
  if (json.error && typeof json.error === 'object') {
    const code = json.error.code ? String(json.error.code) : '';
    const msg = json.error.message ? String(json.error.message).split('. ')[0] : '';
    return clip([code, msg].filter(Boolean).join(': '));
  }
  if (json.error_description) return clip(String(json.error_description).split(/\r?\n/)[0]);
  if (json.error) return clip(String(json.error));
  return '';
}

function clip(text) {
  return text.length > 220 ? text.slice(0, 220) + '…' : text;
}

/** Loads the state for this chain. Returns null if the chain is outdated (a newer sync replaced it). */
function chainState(ctx) {
  const st = getState(ctx);
  const id = ctx.load('syncId');
  if (!st || !st.running || !id || st.id !== id) return null;
  st.chainStep = (st.chainStep || 0) + 1;
  st.updatedAt = new Date().toISOString();
  return st;
}

// ---------- async functions ----------

function onToken(ctx) {
  const st = chainState(ctx);
  if (!st) return;
  try {
    const r = responseOf(ctx);
    if (!r.ok || !r.json || !r.json.access_token) {
      const detail = microsoftError(r.json);
      throw new SyncError('Microsoft sign-in failed' + (r.code ? ' (HTTP ' + r.code + ')' : '') + (detail ? ': ' + detail : '.') +
        ' Check the tenant ID, client ID and client secret in the app settings.');
    }
    next(ctx, st, r.json.access_token);
  } catch (e) {
    fail(ctx, st, e);
  }
}

function onBatch(ctx) {
  const st = chainState(ctx);
  if (!st) return;
  try {
    const token = ctx.load('token');
    const sent = st.inFlight || [];
    st.inFlight = null;
    const r = responseOf(ctx);
    if (!r.ok || !r.json || !Array.isArray(r.json.responses)) {
      if (r.code === 401) throw new SyncError('Microsoft Graph rejected the access token (HTTP 401). Check that admin consent was granted for the app registration.');
      if ((r.code === 429 || r.code >= 500) && (st.batchRetries || 0) < MAX_RETRIES) {
        st.batchRetries = (st.batchRetries || 0) + 1;
        st.queue = sent.concat(st.queue);
      } else {
        const detail = microsoftError(r.json);
        throw new SyncError('Microsoft Graph request failed' + (r.code ? ' (HTTP ' + r.code + ')' : '') + (detail ? ': ' + detail : '.'));
      }
    } else {
      st.batchRetries = 0;
      const byId = {};
      r.json.responses.forEach(function (x) { byId[String(x.id)] = x; });
      sent.forEach(function (req, i) { handleOne(st, req, byId[String(i + 1)]); });
    }
    next(ctx, st, token);
  } catch (e) {
    fail(ctx, st, e);
  }
}

/** Processes one response of a batch. Re-queues throttled requests; throws on real errors. */
function handleOne(st, req, res) {
  const code = res ? +res.status : 0;
  const body = res && res.body && typeof res.body === 'object' ? res.body : null;
  if (!res || code === 429 || code >= 500) {
    req.retries = (req.retries || 0) + 1;
    if (req.retries > MAX_RETRIES) {
      throw new SyncError('Microsoft Graph is busy or unavailable (HTTP ' + (code || 'no response') + '). The next sync will try again.');
    }
    st.queue.push(req);
    return;
  }
  if (req.kind === 'user') {
    st.looked[req.aadId] = true;
    st.lookups[req.aadId] = code >= 200 && code < 300 && body
      ? { name: body.displayName || null, mail: body.mail || null, upn: body.userPrincipalName || null }
      : { failed: true };
    return;
  }
  if (code < 200 || code >= 300 || !body) {
    const what = req.kind === 'reasons' ? 'time-off reasons' : 'time off';
    let hint = '';
    if (code === 403) hint = ' Check that the Schedule.Read.All application permission has admin consent.';
    if (code === 404) hint = ' Check the Teams team ID and that the team uses Shifts.';
    const detail = microsoftError(body);
    throw new SyncError('Could not read ' + what + ' for a team (HTTP ' + code + ')' + (detail ? ': ' + detail : '.') + hint);
  }
  const values = Array.isArray(body.value) ? body.value : [];
  if (req.kind === 'reasons') {
    values.forEach(function (x) { st.reasons[x.id] = { name: x.displayName, active: x.isActive !== false }; });
  } else {
    values.forEach(function (item) { addItem(st, req.teamId, item); });
    const link = body['@odata.nextLink'];
    st.pages[req.teamId] = (st.pages[req.teamId] || 0) + 1;
    if (link && st.pages[req.teamId] < MAX_PAGES_PER_TEAM) {
      st.queue.push({ kind: 'timesOff', teamId: req.teamId, url: link.indexOf(GRAPH) === 0 ? link.slice(GRAPH.length) : link });
    }
  }
}

/** Keeps only what the leave calculation needs, for items inside the sync window. */
function addItem(st, teamId, item) {
  if (!item || !item.userId) return;
  const eff = effectiveTimeOff(item, st.useDrafts);
  if (!eff) return;
  const v = eff.version;
  if (!v.endDateTime || String(v.startDateTime).slice(0, 10) < st.since) return;
  const rec = {
    id: item.id,
    teamId: teamId,
    userId: item.userId,
    start: v.startDateTime,
    end: v.endDateTime,
    reasonId: v.timeOffReasonId,
    note: v.displayName || null
  };
  if (eff.unshared) {
    rec.unshared = true;
    rec.sharedStart = eff.shared ? eff.shared.startDateTime : null;
    rec.sharedEnd = eff.shared ? eff.shared.endDateTime : null;
    st.unshared++;
  }
  st.items.push(rec);
  st.itemCount++;
}

/** Schedules the next batch, pauses at the chain limit, or finishes the sync. */
function next(ctx, st, token) {
  if (!st.queue.length) queueLookups(ctx, st);
  if (!st.queue.length) {
    finish(ctx, st);
    return;
  }
  if (st.chainStep >= CHAIN_LIMIT) {
    // No async steps left in this chain: the next sync request resumes with a new token.
    st.running = false;
    st.paused = true;
    saveState(ctx, st);
    return;
  }
  const batch = st.queue.splice(0, BATCH_SIZE);
  st.inFlight = batch;
  st.requests = (st.requests || 0) + batch.length;
  saveState(ctx, st);

  const c = new http.Connection(GRAPH, null, TIMEOUT_MS);
  c.bearerAuth(token);
  c.addHeader('Content-Type', 'application/json');
  c.addHeader('Accept', 'application/json');
  ctx.store('syncId', st.id);
  ctx.store('token', token);
  c.postAsync('/$batch', null, JSON.stringify({
    requests: batch.map(function (req, i) { return { id: String(i + 1), method: 'GET', url: req.url }; })
  }), 'onBatch');
}

/** Queues Microsoft user lookups for Teams people who are not matched to YouTrack yet. */
function queueLookups(ctx, st) {
  const cfg = store.getConfig(ctx);
  const userMap = cfg.userMap || {};
  const unmatched = cfg.unmatched || {};
  const now = Date.now();
  const seen = {};
  st.items.forEach(function (rec) {
    const id = rec.userId;
    if (seen[id] || userMap[id] || st.looked[id]) return;
    seen[id] = true;
    const known = unmatched[id];
    const checkedAt = known ? Date.parse(known.checkedAt || known.seenAt || 0) : 0;
    if (known && !st.recheckUnmatched && now - checkedAt < LOOKUP_RETRY_MS) return;
    st.queue.push({ kind: 'user', aadId: id, url: '/users/' + encodeURIComponent(id) + '?$select=id,displayName,mail,userPrincipalName' });
  });
}

function loginFor(cfg, aadId, info, nowIso) {
  if (cfg.userMap[aadId]) return cfg.userMap[aadId];
  const prev = cfg.unmatched[aadId] || {};
  const fresh = !!(info && !info.failed);
  const name = fresh ? info.name : prev.name;
  const email = fresh ? (info.mail || info.upn) : prev.email;
  const candidates = fresh ? [info.mail, info.upn] : [prev.email];
  for (let i = 0; i < candidates.length; i++) {
    if (!candidates[i]) continue;
    const u = entities.User.findUniqueByEmail(candidates[i]);
    if (u) {
      cfg.userMap[aadId] = u.login;
      delete cfg.unmatched[aadId];
      return u.login;
    }
  }
  cfg.unmatched[aadId] = {
    name: name || null,
    email: email || null,
    seenAt: nowIso,
    checkedAt: info ? nowIso : (prev.checkedAt || prev.seenAt || nowIso),
    lookupFailed: info ? !!info.failed : !!prev.lookupFailed
  };
  return null;
}

/** Applies the collected Teams data to every tracked employee and clears the sync state. */
function finish(ctx, st) {
  const cfg = store.getConfig(ctx);
  cfg.userMap = cfg.userMap || {};
  cfg.unmatched = cfg.unmatched || {};
  cfg.reasons = cfg.reasons || {};
  const nowIso = new Date().toISOString();

  Object.keys(st.reasons).forEach(function (id) {
    const r = st.reasons[id];
    const existing = cfg.reasons[id];
    if (existing) {
      existing.name = r.name;
      existing.active = r.active;
    } else {
      cfg.reasons[id] = { name: r.name, deducts: false, reviewed: false, active: r.active, firstSeen: st.today };
    }
  });

  const byLogin = {};
  const loginCache = {};
  let matchedItems = 0;
  st.items.forEach(function (rec) {
    if (!(rec.userId in loginCache)) {
      const info = st.lookups[rec.userId];
      loginCache[rec.userId] = loginFor(cfg, rec.userId, info || null, nowIso);
    }
    const login = loginCache[rec.userId];
    if (!login) return;
    const reason = cfg.reasons[rec.reasonId];
    const out = {
      id: rec.id,
      teamId: rec.teamId,
      start: rec.start,
      end: rec.end,
      reasonId: rec.reasonId,
      reasonName: reason ? reason.name : null,
      note: rec.note
    };
    if (rec.unshared) {
      out.unshared = true;
      out.sharedStart = rec.sharedStart;
      out.sharedEnd = rec.sharedEnd;
    }
    (byLogin[login] = byLogin[login] || []).push(out);
    matchedItems++;
  });

  // Replace each tracked employee's records inside the window; keep older history untouched.
  let updatedUsers = 0;
  store.listEmployees().forEach(function (u) {
    const fresh = byLogin[u.login] || [];
    const old = store.getRecords(u);
    const kept = old.filter(function (r) { return String(r.start).slice(0, 10) < st.since; });
    const merged = kept.concat(fresh).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (JSON.stringify(merged) !== JSON.stringify(old)) {
      store.saveRecords(u, merged);
      updatedUsers++;
    }
  });

  cfg.lastSyncAt = nowIso;
  cfg.lastSyncError = null;
  cfg.lastSyncSummary = {
    since: st.since,
    items: st.itemCount,
    matchedItems: matchedItems,
    unshared: st.unshared,
    useDrafts: st.useDrafts,
    updatedUsers: updatedUsers,
    unmatched: Object.keys(cfg.unmatched).length,
    newReasons: Object.keys(cfg.reasons).filter(function (id) { return !cfg.reasons[id].reviewed; }).length,
    requests: st.requests || 0
  };
  store.saveConfig(ctx, cfg);
  saveState(ctx, null);
}

function recordFailure(ctx, e) {
  const userFacing = e && e.userFacing;
  if (!userFacing) console.error('Leave Sync: unexpected sync error: ' + (e && e.stack || e));
  const cfg = store.getConfig(ctx);
  cfg.lastSyncError = {
    at: new Date().toISOString(),
    message: userFacing ? e.message : 'Unexpected error while syncing with Microsoft Teams. Try again later; if it keeps happening, contact the app vendor.'
  };
  cfg.lastSyncAt = new Date().toISOString(); // back off until the next interval
  store.saveConfig(ctx, cfg);
}

function fail(ctx, st, e) {
  recordFailure(ctx, e);
  saveState(ctx, null);
}

// ---------- time-off versions ----------

function sameItem(a, b) {
  return !!a && !!b && a.startDateTime === b.startDateTime && a.endDateTime === b.endDateTime && a.timeOffReasonId === b.timeOffReasonId;
}

/**
 * The version of a time-off item that counts.
 * useDrafts (default): what the manager sees in the Shifts schedule, including changes that
 * haven't been shared with the team yet. Otherwise: only what has been shared with employees.
 */
function effectiveTimeOff(item, useDrafts) {
  const shared = item.sharedTimeOff && item.sharedTimeOff.startDateTime ? item.sharedTimeOff : null;
  const draft = item.draftTimeOff && item.draftTimeOff.startDateTime ? item.draftTimeOff : null;
  if (useDrafts) {
    if (item.isStagedForDeletion) return null; // deleted in the schedule, not shared yet
    if (draft) return { version: draft, unshared: !sameItem(draft, shared), shared: shared };
    return shared ? { version: shared, unshared: false, shared: shared } : null;
  }
  return shared ? { version: shared, unshared: false, shared: shared } : null;
}

module.exports = {
  effectiveTimeOff: effectiveTimeOff,
  isConfigured: isConfigured,
  start: start,
  status: status,
  asyncFunctions: { onToken: onToken, onBatch: onBatch },
  CHAIN_LIMIT: CHAIN_LIMIT
};

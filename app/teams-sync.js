/**
 * Leave Sync for YouTrack – Microsoft Teams Shifts synchronisation (utility module).
 *
 * Uses Microsoft Graph with an app registration (client credentials):
 *   POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
 *   GET  /teams/{teamId}/schedule/timeOffReasons      (Schedule.Read.All)
 *   GET  /teams/{teamId}/schedule/timesOff            (Schedule.Read.All)
 *   GET  /users/{id}                                  (User.Read.All) – to match people by e-mail
 *
 * Only shared (published) time off that is not staged for deletion is imported. Approved Teams
 * time-off requests become such items, so cancelled/declined requests disappear on the next sync.
 */
const http = require('@jetbrains/youtrack-scripting-api/http');
const entities = require('@jetbrains/youtrack-scripting-api/entities');
const store = require('./store');
const engine = require('./engine');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_PAGES = 50;

function short(text) {
  text = String(text || '');
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
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
    throw new Error('The "Microsoft Entra tenant ID" setting contains an e-mail address (' + tenant + '). Your browser probably autofilled it. Enter the Directory (tenant) ID from the app\'s Overview page in Entra – and re-enter the client secret too, it may have been autofilled with a password.');
  }
  if (!GUID_RE.test(tenant) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenant)) {
    throw new Error('The "Microsoft Entra tenant ID" setting is not a valid Directory (tenant) ID. It should look like 1a2b3c4d-1111-2222-3333-444455556666.');
  }
  if (!GUID_RE.test(client)) {
    throw new Error('The "Application (client) ID" setting is not a valid ID. Copy it from the app\'s Overview page in Entra (not the Object ID or the Secret ID).');
  }
  teamIdList(settings).forEach(function (id) {
    if (!GUID_RE.test(id)) {
      throw new Error('"' + id + '" is not a valid Teams team ID. Use the GUID after groupId= in the team link.');
    }
  });
}

function getToken(settings) {
  validateSettings(settings);
  const c = new http.Connection('https://login.microsoftonline.com');
  // client_secret_basic: the secret setting is only ever handed to the http module's auth helper.
  c.basicAuth(String(settings.clientId).trim(), settings.clientSecret);
  c.addHeader('Content-Type', 'application/x-www-form-urlencoded');
  c.addHeader('Accept', 'application/json');
  const res = c.postSync(
    '/' + encodeURIComponent(String(settings.tenantId).trim()) + '/oauth2/v2.0/token',
    null,
    'grant_type=client_credentials&scope=' + encodeURIComponent('https://graph.microsoft.com/.default')
  );
  if (!res.isSuccess) throw new Error('Microsoft sign-in failed (HTTP ' + res.code + '): ' + short(res.response));
  const token = res.json().access_token;
  if (!token) throw new Error('Microsoft sign-in returned no access token');
  return token;
}

function graphGet(token, uri, query) {
  const c = new http.Connection(GRAPH);
  c.bearerAuth(token);
  c.addHeader('Accept', 'application/json');
  const res = c.getSync(uri, query || []);
  return res;
}

/** Follows @odata.nextLink pages. */
function graphList(token, uri, query) {
  const items = [];
  let res = graphGet(token, uri, query);
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!res.isSuccess) {
      const err = new Error('Microsoft Graph error (HTTP ' + res.code + ') for ' + uri + ': ' + short(res.response));
      err.code = res.code;
      throw err;
    }
    const body = res.json();
    (body.value || []).forEach(function (v) { items.push(v); });
    const next = body['@odata.nextLink'];
    if (!next) return items;
    res = graphGet(token, next.indexOf(GRAPH) === 0 ? next.slice(GRAPH.length) : next, []);
  }
  return items;
}

function listTimesOff(token, teamId) {
  // No server-side filter: items that only exist as an unshared draft have no sharedTimeOff,
  // so a filter on sharedTimeOff would hide them. Dates are filtered locally instead.
  return graphList(token, '/teams/' + encodeURIComponent(teamId) + '/schedule/timesOff', []);
}

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

/** Finds the YouTrack login for an Entra (Azure AD) user id, caching the result in config. */
function resolveLogin(token, cfg, aadId, triedThisRun) {
  if (cfg.userMap[aadId]) return cfg.userMap[aadId];
  if (triedThisRun[aadId]) return null;
  triedThisRun[aadId] = true;
  let info = null;
  try {
    const res = graphGet(token, '/users/' + encodeURIComponent(aadId), [{ name: '$select', value: 'id,displayName,mail,userPrincipalName' }]);
    if (res.isSuccess) info = res.json();
  } catch (e) { /* handled below */ }
  const candidates = [];
  if (info && info.mail) candidates.push(info.mail);
  if (info && info.userPrincipalName) candidates.push(info.userPrincipalName);
  for (let i = 0; i < candidates.length; i++) {
    const u = entities.User.findUniqueByEmail(candidates[i]);
    if (u) {
      cfg.userMap[aadId] = u.login;
      delete cfg.unmatched[aadId];
      return u.login;
    }
  }
  cfg.unmatched[aadId] = {
    name: info ? info.displayName : null,
    email: info ? (info.mail || info.userPrincipalName) : null,
    seenAt: new Date().toISOString(),
    lookupFailed: !info
  };
  return null;
}

/**
 * Runs a full sync. Returns a summary object. Throws on connection/configuration errors.
 */
function runSync(ctx) {
  const settings = ctx.settings || {};
  if (!isConfigured(settings)) throw new Error('Teams connection is not configured yet (Administration → Apps → Leave Sync for YouTrack → Settings).');
  const cfg = store.getConfig(ctx);
  cfg.userMap = cfg.userMap || {};
  cfg.unmatched = cfg.unmatched || {};
  cfg.reasons = cfg.reasons || {};

  const today = engine.todayIso(cfg);
  const employees = store.listEmployees();
  // Window: from the earliest tracked leave year (at most ~3 years back), so cancellations are reflected.
  let since = engine.addDays(today, -400);
  employees.forEach(function (u) {
    const p = store.getProfile(u);
    if (!p.hireDate || !engine.isValidIso(p.hireDate)) return;
    const start = engine.trackingStartFor(p, today);
    if (start < since) since = start;
  });
  const floor = engine.addDays(today, -1100);
  if (since < floor) since = floor;

  const token = getToken(settings);
  const byLogin = {};
  let itemCount = 0;
  const seenReasons = {};
  const tried = {};
  let unsharedCount = 0;

  teamIdList(settings).forEach(function (teamId) {
    graphList(token, '/teams/' + encodeURIComponent(teamId) + '/schedule/timeOffReasons', []).forEach(function (r) {
      seenReasons[r.id] = true;
      const existing = cfg.reasons[r.id];
      if (existing) {
        existing.name = r.displayName;
        existing.active = r.isActive !== false;
      } else {
        cfg.reasons[r.id] = { name: r.displayName, deducts: false, reviewed: false, active: r.isActive !== false, firstSeen: today };
      }
    });

    listTimesOff(token, teamId).forEach(function (item) {
      if (!item.userId) return;
      const eff = effectiveTimeOff(item, cfg.useDrafts !== false);
      if (!eff) return;
      const v = eff.version;
      if (!v.endDateTime) return;
      if (String(v.startDateTime).slice(0, 10) < since) return;
      const login = resolveLogin(token, cfg, item.userId, tried);
      if (!login) return;
      const reason = cfg.reasons[v.timeOffReasonId];
      const rec = {
        id: item.id,
        teamId: teamId,
        start: v.startDateTime,
        end: v.endDateTime,
        reasonId: v.timeOffReasonId,
        reasonName: reason ? reason.name : null,
        note: v.displayName || null
      };
      if (eff.unshared) {
        rec.unshared = true;
        rec.sharedStart = eff.shared ? eff.shared.startDateTime : null;
        rec.sharedEnd = eff.shared ? eff.shared.endDateTime : null;
        unsharedCount++;
      }
      (byLogin[login] = byLogin[login] || []).push(rec);
      itemCount++;
    });
  });

  // Replace each tracked employee's records inside the window; keep older history untouched.
  let updatedUsers = 0;
  employees.forEach(function (u) {
    const fresh = byLogin[u.login] || [];
    const old = store.getRecords(u);
    const kept = old.filter(function (r) { return String(r.start).slice(0, 10) < since; });
    const merged = kept.concat(fresh).sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    if (JSON.stringify(merged) !== JSON.stringify(old)) {
      store.saveRecords(u, merged);
      updatedUsers++;
    }
  });

  cfg.lastSyncAt = new Date().toISOString();
  cfg.lastSyncError = null;
  cfg.lastSyncSummary = {
    since: since,
    items: itemCount,
    unshared: unsharedCount,
    useDrafts: cfg.useDrafts !== false,
    updatedUsers: updatedUsers,
    unmatched: Object.keys(cfg.unmatched).length,
    newReasons: Object.keys(cfg.reasons).filter(function (id) { return !cfg.reasons[id].reviewed; }).length
  };
  store.saveConfig(ctx, cfg);
  return cfg.lastSyncSummary;
}

/** Runs a sync if the last one is older than the configured interval. Never throws. */
function syncIfStale(ctx, force) {
  const cfg = store.getConfig(ctx);
  if (!isConfigured(ctx.settings)) return { ran: false, reason: 'not-configured' };
  const last = cfg.lastSyncAt ? Date.parse(cfg.lastSyncAt) : 0;
  const interval = Math.max(5, +cfg.syncIntervalMinutes || 30) * 60000;
  if (!force && Date.now() - last < interval) return { ran: false, reason: 'fresh', lastSyncAt: cfg.lastSyncAt };
  try {
    const summary = runSync(ctx);
    return { ran: true, summary: summary };
  } catch (e) {
    const c = store.getConfig(ctx);
    c.lastSyncError = { at: new Date().toISOString(), message: String(e && e.message || e) };
    c.lastSyncAt = new Date().toISOString(); // back off until the next interval
    store.saveConfig(ctx, c);
    return { ran: true, error: c.lastSyncError.message };
  }
}

module.exports = {
  effectiveTimeOff: effectiveTimeOff,
  isConfigured: isConfigured,
  runSync: runSync,
  syncIfStale: syncIfStale
};

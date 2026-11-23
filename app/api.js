/**
 * Leave Sync for YouTrack – HTTP endpoints used by the two widgets.
 *
 * Employee endpoints (any signed-in user, own data only):
 *   GET  api/me            balance, usage by type and history of the current user
 *   POST api/sync          starts a Teams refresh if the data is older than the sync interval (202, returns at once)
 *   GET  api/sync-status   whether a Teams refresh is running (polled by the widgets)
 *
 * Admin endpoints (System Admin or member of the "Leave administrators" group from app settings):
 *   GET  api/admin-state, api/admin-employee?login=, api/admin-audit
 *   POST api/admin-employee-save, api/admin-employee-remove,
 *        api/admin-adjustment-add, api/admin-adjustment-remove,
 *        api/admin-config-save, api/admin-map-user, api/admin-sync
 *
 * Microsoft calls never run inside these handlers: teams-sync.js schedules them as async HTTP
 * requests whose responses are handled by the asyncFunctions declared at the bottom of this file.
 */
const engine = require('./engine');
const store = require('./store');
const teams = require('./teams-sync');

// ---------- helpers ----------

const SYNC_HISTORY_DAYS = 400; // Teams history read on every sync (more if an employee is tracked from earlier)

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function isLeaveAdmin(ctx) {
  const user = ctx.currentUser;
  try { if (user.hasRole('System Admin')) return true; } catch (e) { /* older API */ }
  const group = ctx.settings && ctx.settings.adminGroup;
  if (group && group.name) {
    try { if (user.isInGroup(group.name)) return true; } catch (e) { /* ignore */ }
  }
  return false;
}

function requireAdmin(ctx) {
  if (!isLeaveAdmin(ctx)) throw new HttpError(403, 'Only leave administrators can do this.');
}

function body(ctx) {
  try { return ctx.request.json() || {}; } catch (e) { throw new HttpError(400, 'Invalid JSON body'); }
}

function endpoint(method, path, fn) {
  return {
    scope: 'global',
    method: method,
    path: path,
    handle: function (ctx) {
      try {
        const result = fn(ctx);
        ctx.response.json(result === undefined ? { ok: true } : result);
      } catch (e) {
        if (e instanceof HttpError) {
          ctx.response.code = e.code;
          ctx.response.json({ error: e.message });
        } else {
          console.error('Leave Sync: ' + method + ' ' + path + ' failed: ' + (e && e.stack || e));
          ctx.response.code = 500;
          ctx.response.json({ error: 'Something went wrong on the server. Try again; if it keeps happening, contact the app vendor.' });
        }
      }
    }
  };
}

function optDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (!engine.isValidIso(value)) throw new HttpError(400, field + ' must be a date (YYYY-MM-DD)');
  return value;
}

function optNumber(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!isFinite(n)) throw new HttpError(400, field + ' must be a number');
  return Math.round(n * 100) / 100;
}

function userInfo(u) {
  return { login: u.login, name: u.visibleName, email: u.email || null, banned: !!u.isBanned };
}

function syncStatus(ctx, cfg) {
  const st = teams.status(ctx, cfg, true);
  return {
    configured: teams.isConfigured(ctx.settings),
    demo: st.demo,
    phase: st.phase,
    startedAt: st.startedAt,
    progress: st.progress || null,
    lastSyncAt: cfg.lastSyncAt || null,
    lastSyncError: cfg.lastSyncError || null,
    lastSyncSummary: cfg.lastSyncSummary || null,
    intervalMinutes: cfg.syncIntervalMinutes,
    useDrafts: cfg.useDrafts !== false
  };
}

function reasonList(cfg) {
  return Object.keys(cfg.reasons || {}).map(function (id) {
    const r = cfg.reasons[id];
    return { id: id, name: r.name, deducts: !!r.deducts, reviewed: !!r.reviewed, active: r.active !== false };
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

function employeeSummary(u, cfg, today) {
  const profile = store.getProfile(u);
  const b = engine.computeBalance(profile, store.getRecords(u), cfg, today);
  const info = userInfo(u);
  if (!b.configured) return Object.assign(info, { configured: false });
  return Object.assign(info, {
    configured: true,
    hireDate: b.hireDate,
    birthDate: profile.birthDate || null,
    seniorityYears: b.seniorityYears,
    started: b.started,
    currentStart: b.current ? b.current.start : null,
    currentEnd: b.current ? b.current.end : null,
    entitlement: b.current ? b.current.entitlement : 0,
    carryIn: b.current ? b.current.carryIn : 0,
    usedDays: b.current ? b.current.usedDays : 0,
    remainingDays: b.current ? b.current.remainingDays : 0,
    openingIsAuto: b.openingIsAuto,
    openingConfirmed: b.openingConfirmed,
    nextAnniversary: b.nextAnniversary
  });
}

function getEmployeeOr404(login) {
  const u = store.findUser(login);
  if (!u) throw new HttpError(404, 'User not found: ' + login);
  return u;
}

// ---------- employee endpoints ----------

function me(ctx) {
  // Admins may open any employee's page with ?login=…; everyone else only ever gets their own data.
  const requested = ctx.request.getParameter('login');
  let u = ctx.currentUser;
  if (requested && requested !== u.login) {
    requireAdmin(ctx);
    u = getEmployeeOr404(requested);
  }
  const cfg = store.getConfig(ctx);
  const base = {
    user: userInfo(u), isAdmin: isLeaveAdmin(ctx), viewingOther: u.login !== ctx.currentUser.login,
    sync: { lastSyncAt: cfg.lastSyncAt || null, demo: teams.isDemo(ctx.settings) }
  };
  if (!store.isEnabled(u)) return Object.assign(base, { configured: false });
  const profile = store.getProfile(u);
  const balance = engine.computeBalance(profile, store.getRecords(u), cfg, engine.todayIso(cfg));
  return Object.assign(base, { configured: balance.configured, balance: balance });
}

/** Starts a Teams refresh in the background. 202 when a refresh is running, 200 otherwise. */
function startSync(ctx, force) {
  const result = teams.start(ctx, { force: force });
  if (result.phase === 'started' || result.phase === 'resumed' || result.phase === 'running') ctx.response.code = 202;
  const cfg = store.getConfig(ctx);
  return Object.assign({}, teams.status(ctx, cfg, isLeaveAdmin(ctx)), { phase: result.phase });
}

function sync(ctx) {
  const force = !!body(ctx).force;
  if (force) requireAdmin(ctx);
  return startSync(ctx, force);
}

function syncState(ctx) {
  const cfg = store.getConfig(ctx);
  return teams.status(ctx, cfg, isLeaveAdmin(ctx));
}

// ---------- admin endpoints ----------

function adminState(ctx) {
  requireAdmin(ctx);
  const cfg = store.getConfig(ctx);
  const today = engine.todayIso(cfg);
  const employees = store.listEmployees().map(function (u) { return employeeSummary(u, cfg, today); })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return {
    today: today,
    employees: employees,
    reasons: reasonList(cfg),
    calendar: {
      workdayHours: cfg.workdayHours,
      weekendDays: cfg.weekendDays,
      utcOffsetMinutes: cfg.utcOffsetMinutes,
      dstRule: cfg.dstRule === 'EU' ? 'EU' : 'NONE',
      autoFixedHolidays: cfg.autoFixedHolidays !== false,
      holidayCountry: engine.holidayCountry(cfg),
      countries: engine.HOLIDAY_COUNTRIES,
      fixedByCountry: Object.keys(engine.HOLIDAY_COUNTRIES).reduce(function (m, c) {
        m[c] = engine.fixedHolidays(+today.slice(0, 4), c); return m;
      }, {}),
      holidays: (cfg.holidays || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }),
      fixedHolidays: engine.fixedHolidays(+today.slice(0, 4), engine.holidayCountry(cfg)).concat(engine.fixedHolidays(+today.slice(0, 4) + 1, engine.holidayCountry(cfg)))
    },
    tiers: cfg.tiers,
    ageRule: cfg.ageRule,
    sync: syncStatus(ctx, cfg),
    unmatched: Object.keys(cfg.unmatched || {}).map(function (id) { return Object.assign({ aadId: id }, cfg.unmatched[id]); }),
    userMap: cfg.userMap || {}
  };
}

function adminOverview(ctx) {
  requireAdmin(ctx);
  const cfg = store.getConfig(ctx);
  const today = engine.todayIso(cfg);
  const employees = store.listEmployees().map(function (u) {
    const b = engine.computeBalance(store.getProfile(u), store.getRecords(u), cfg, today);
    const info = userInfo(u);
    if (!b.configured) return Object.assign(info, { configured: false });
    const c = b.current;
    return Object.assign(info, {
      configured: true,
      hireDate: b.hireDate,
      current: c ? { start: c.start, end: c.end, entitlement: c.entitlement, carryIn: c.carryIn, usedDays: c.usedDays, remainingDays: c.remainingDays } : null,
      dayLog: b.dayLog
    });
  }).sort(function (a, b2) { return String(a.name).localeCompare(String(b2.name)); });
  const reasonNames = {};
  Object.keys(cfg.reasons || {}).forEach(function (id) { reasonNames[id] = { name: cfg.reasons[id].name, deducts: !!cfg.reasons[id].deducts }; });
  return { today: today, workdayHours: cfg.workdayHours, reasons: reasonNames, employees: employees };
}

function adminEmployee(ctx) {
  requireAdmin(ctx);
  const login = ctx.request.getParameter('login');
  const u = getEmployeeOr404(login);
  const cfg = store.getConfig(ctx);
  const profile = store.getProfile(u);
  const today = engine.todayIso(cfg);
  return {
    user: userInfo(u),
    enabled: store.isEnabled(u),
    profile: profile,
    periodStarts: profile.hireDate ? engine.periodStarts(profile.hireDate, today) : [],
    historyFrom: engine.addDays(today, -SYNC_HISTORY_DAYS),
    balance: engine.computeBalance(profile, store.getRecords(u), cfg, today)
  };
}

function adminEmployeeSave(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  const u = getEmployeeOr404(b.login);
  const cfg = store.getConfig(ctx);
  const today = engine.todayIso(cfg);
  const before = store.getProfile(u);
  const p = Object.assign({}, before);

  const hireDate = optDate(b.hireDate, 'Hire date');
  if (!hireDate) throw new HttpError(400, 'Hire date is required');
  p.hireDate = hireDate;
  if ('birthDate' in b) p.birthDate = optDate(b.birthDate, 'Birth date');
  if ('openingDays' in b) p.openingDays = optNumber(b.openingDays, 'Opening balance');
  if ('openingConfirmed' in b) p.openingConfirmed = !!b.openingConfirmed;
  if (!p.addedOn) p.addedOn = today;
  if (b.addedOn !== undefined) p.addedOn = optDate(b.addedOn, 'Tracking start') || today;
  if ('trackFrom' in b) {
    p.trackFrom = optDate(b.trackFrom, 'Count Teams leave from');
    if (p.trackFrom && p.trackFrom < p.hireDate) p.trackFrom = p.hireDate;
  } else if (!before.hireDate && p.hireDate >= engine.addDays(today, -SYNC_HISTORY_DAYS)) {
    // Recently hired: Teams holds their whole history, so count everything from the hire date
    // (leave taken in the first year is deducted from the first entitlement).
    p.trackFrom = p.hireDate;
  }
  if (b.entOverrides && typeof b.entOverrides === 'object') {
    const ov = Object.assign({}, p.entOverrides || {});
    Object.keys(b.entOverrides).forEach(function (start) {
      if (!engine.isValidIso(start)) return;
      const v = optNumber(b.entOverrides[start], 'Entitlement');
      if (v === null) delete ov[start]; else ov[start] = v;
    });
    p.entOverrides = ov;
  }
  p.adjustments = p.adjustments || [];
  if (b.remainingToday !== undefined && b.remainingToday !== null && b.remainingToday !== '') {
    const target = optNumber(b.remainingToday, 'Remaining today');
    const opening = engine.openingForRemainingOn(p, store.getRecords(u), cfg, today, target);
    if (opening === null) throw new HttpError(400, 'The first leave year has not started yet for this hire date');
    p.openingDays = opening;
    p.openingConfirmed = true;
    p.openingFromRemaining = { remaining: target, on: today };
  } else if ('openingDays' in b) {
    delete p.openingFromRemaining;
  }
  p.updatedAt = new Date().toISOString();
  p.updatedBy = ctx.currentUser.login;

  const wasEnabled = store.isEnabled(u);
  store.saveProfile(u, p);
  store.setEnabled(u, true);

  const changes = {};
  ['hireDate', 'birthDate', 'trackFrom', 'openingDays', 'openingConfirmed', 'addedOn', 'openingFromRemaining'].forEach(function (k) {
    if (JSON.stringify(before[k]) !== JSON.stringify(p[k])) changes[k] = { from: before[k] === undefined ? null : before[k], to: p[k] };
  });
  if (JSON.stringify(before.entOverrides || {}) !== JSON.stringify(p.entOverrides || {})) {
    changes.entitlementOverrides = { from: before.entOverrides || {}, to: p.entOverrides };
  }
  store.audit(ctx, wasEnabled ? 'Employee updated' : 'Employee added', u.login, changes);
  return { ok: true };
}

function adminEmployeeRemove(ctx) {
  requireAdmin(ctx);
  const u = getEmployeeOr404(body(ctx).login);
  store.setEnabled(u, false);
  store.audit(ctx, 'Employee removed from tracking (data kept)', u.login, null);
  return { ok: true };
}

function adminAdjustmentAdd(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  const u = getEmployeeOr404(b.login);
  const date = optDate(b.date, 'Date');
  const days = optNumber(b.days, 'Days');
  if (!date || days === null || days === 0) throw new HttpError(400, 'Date and a non-zero number of days are required');
  const note = String(b.note || '').trim();
  if (!note) throw new HttpError(400, 'Please add a note explaining the adjustment');
  const p = store.getProfile(u);
  p.adjustments = p.adjustments || [];
  const adj = {
    id: 'adj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date: date, days: days, note: note.slice(0, 500),
    by: ctx.currentUser.login, byName: ctx.currentUser.visibleName, at: new Date().toISOString()
  };
  p.adjustments.push(adj);
  store.saveProfile(u, p);
  store.audit(ctx, 'Adjustment added', u.login, { date: date, days: days, note: adj.note });
  return { ok: true, adjustment: adj };
}

function adminAdjustmentRemove(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  const u = getEmployeeOr404(b.login);
  const p = store.getProfile(u);
  const removed = (p.adjustments || []).filter(function (a) { return a.id === b.id; })[0];
  if (!removed) throw new HttpError(404, 'Adjustment not found');
  p.adjustments = p.adjustments.filter(function (a) { return a.id !== b.id; });
  store.saveProfile(u, p);
  store.audit(ctx, 'Adjustment removed', u.login, { date: removed.date, days: removed.days, note: removed.note });
  return { ok: true };
}

function adminRecordOverride(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  const u = getEmployeeOr404(b.login);
  if (!b.recId) throw new HttpError(400, 'Leave record is missing');
  const rec = store.getRecords(u).filter(function (r) { return r.id === b.recId; })[0];
  if (!rec) throw new HttpError(404, 'Leave record not found – run a sync and try again');
  const cfg = store.getConfig(ctx);
  const p = store.getProfile(u);
  p.recordOverrides = p.recordOverrides || {};
  const before = p.recordOverrides[b.recId] || null;
  const label = rec.start.slice(0, 10) + ' – ' + rec.end.slice(0, 10);
  if (b.mode === 'clear') {
    delete p.recordOverrides[b.recId];
    store.saveProfile(u, p);
    store.audit(ctx, 'Leave correction removed', u.login, { leave: label, was: before });
    return { ok: true };
  }
  const note = String(b.note || '').trim();
  if (!note) throw new HttpError(400, 'Please add a note explaining the correction');
  let ov;
  if (b.mode === 'exclude') {
    ov = { mode: 'exclude' };
  } else if (b.mode === 'hours') {
    let hours = optNumber(b.hours, 'Hours');
    if (hours === null && b.days !== undefined) {
      const d = optNumber(b.days, 'Days');
      hours = d === null ? null : Math.round(d * cfg.workdayHours * 100) / 100;
    }
    if (hours === null || hours < 0) throw new HttpError(400, 'Enter how much of this leave should be charged');
    ov = { mode: 'hours', hours: hours };
  } else {
    throw new HttpError(400, 'Unknown correction');
  }
  ov.note = note.slice(0, 300);
  ov.by = ctx.currentUser.login;
  ov.byName = ctx.currentUser.visibleName;
  ov.at = new Date().toISOString();
  p.recordOverrides[b.recId] = ov;
  store.saveProfile(u, p);
  store.audit(ctx, 'Leave corrected', u.login, { leave: label, correction: ov.mode === 'exclude' ? 'not counted' : ov.hours + ' h', note: ov.note });
  return { ok: true };
}

function adminConfigSave(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  const cfg = store.getConfig(ctx);
  const changes = {};

  if (b.reasons && typeof b.reasons === 'object') {
    Object.keys(b.reasons).forEach(function (id) {
      const r = cfg.reasons[id];
      if (!r) return;
      const deducts = !!b.reasons[id].deducts;
      if (r.deducts !== deducts || !r.reviewed) changes['reason:' + r.name] = { deducts: deducts };
      r.deducts = deducts;
      r.reviewed = true;
    });
  }
  if (b.workdayHours !== undefined) {
    const h = optNumber(b.workdayHours, 'Working hours per day');
    if (!(h > 0 && h <= 24)) throw new HttpError(400, 'Working hours per day must be between 0 and 24');
    if (h !== cfg.workdayHours) changes.workdayHours = { from: cfg.workdayHours, to: h };
    cfg.workdayHours = h;
  }
  if (Array.isArray(b.weekendDays)) {
    const w = b.weekendDays.map(Number).filter(function (d) { return d >= 0 && d <= 6; });
    changes.weekendDays = { from: cfg.weekendDays, to: w };
    cfg.weekendDays = w;
  }
  if (b.utcOffsetMinutes !== undefined) {
    const o = optNumber(b.utcOffsetMinutes, 'UTC offset');
    if (o === null || o < -720 || o > 840) throw new HttpError(400, 'UTC offset is out of range');
    cfg.utcOffsetMinutes = o;
  }
  if (b.dstRule !== undefined) {
    if (b.dstRule !== 'EU' && b.dstRule !== 'NONE') throw new HttpError(400, 'Unknown daylight saving rule');
    cfg.dstRule = b.dstRule;
  }
  if (b.autoFixedHolidays !== undefined) cfg.autoFixedHolidays = !!b.autoFixedHolidays;
  if (b.holidayCountry !== undefined) {
    if (!engine.HOLIDAY_COUNTRIES[b.holidayCountry]) throw new HttpError(400, 'Unknown country for public holidays');
    if (b.holidayCountry !== engine.holidayCountry(cfg)) changes.holidayCountry = { from: engine.holidayCountry(cfg), to: b.holidayCountry };
    cfg.holidayCountry = b.holidayCountry;
    cfg.autoFixedHolidays = b.holidayCountry !== 'NONE';
  }
  if (Array.isArray(b.holidays)) {
    cfg.holidays = b.holidays.map(function (h) {
      if (!h || !engine.isValidIso(h.date)) throw new HttpError(400, 'Every holiday needs a valid date');
      return { date: h.date, name: String(h.name || 'Holiday').slice(0, 100), half: !!h.half };
    });
    changes.holidays = { count: cfg.holidays.length };
  }
  if (Array.isArray(b.tiers)) {
    const tiers = b.tiers.map(function (t) {
      const from = optNumber(t.fromYears, 'Years'), days = optNumber(t.days, 'Days');
      if (from === null || days === null || from < 1 || days < 0) throw new HttpError(400, 'Invalid seniority tier');
      return { fromYears: from, days: days };
    }).sort(function (a, b2) { return a.fromYears - b2.fromYears; });
    if (!tiers.length) throw new HttpError(400, 'At least one seniority tier is required');
    changes.tiers = { from: cfg.tiers, to: tiers };
    cfg.tiers = tiers;
  }
  if (b.ageRule && typeof b.ageRule === 'object') {
    cfg.ageRule = {
      enabled: !!b.ageRule.enabled,
      minDays: optNumber(b.ageRule.minDays, 'Minimum days') || 20,
      youngMaxAge: optNumber(b.ageRule.youngMaxAge, 'Age') || 18,
      oldMinAge: optNumber(b.ageRule.oldMinAge, 'Age') || 50
    };
    changes.ageRule = cfg.ageRule;
  }
  if (b.useDrafts !== undefined) {
    cfg.useDrafts = !!b.useDrafts;
    cfg.lastSyncAt = null; // re-read Teams with the new rule
    changes.useDrafts = cfg.useDrafts;
  }
  if (b.syncIntervalMinutes !== undefined) {
    const m = optNumber(b.syncIntervalMinutes, 'Sync interval');
    cfg.syncIntervalMinutes = Math.max(5, m || 30);
  }
  store.saveConfig(ctx, cfg);
  store.audit(ctx, 'Settings changed', null, changes);
  return { ok: true };
}

function adminMapUser(ctx) {
  requireAdmin(ctx);
  const b = body(ctx);
  if (!b.aadId) throw new HttpError(400, 'Teams user id is missing');
  const cfg = store.getConfig(ctx);
  if (b.login) {
    const u = getEmployeeOr404(b.login);
    cfg.userMap[b.aadId] = u.login;
    delete cfg.unmatched[b.aadId];
    cfg.lastSyncAt = null; // pick up this person's leave on the next sync
    store.audit(ctx, 'Teams user linked', u.login, { teamsUserId: b.aadId });
  } else {
    delete cfg.userMap[b.aadId];
    store.audit(ctx, 'Teams user unlinked', null, { teamsUserId: b.aadId });
  }
  store.saveConfig(ctx, cfg);
  return { ok: true };
}

function adminSync(ctx) {
  requireAdmin(ctx);
  return startSync(ctx, true);
}

function adminAudit(ctx) {
  requireAdmin(ctx);
  return { entries: store.getAudit(ctx) };
}

exports.httpHandler = {
  endpoints: [
    endpoint('GET', 'me', me),
    endpoint('POST', 'sync', sync),
    endpoint('GET', 'sync-status', syncState),
    endpoint('GET', 'admin-state', adminState),
    endpoint('GET', 'admin-employee', adminEmployee),
    endpoint('GET', 'admin-audit', adminAudit),
    endpoint('GET', 'admin-overview', adminOverview),
    endpoint('POST', 'admin-employee-save', adminEmployeeSave),
    endpoint('POST', 'admin-employee-remove', adminEmployeeRemove),
    endpoint('POST', 'admin-adjustment-add', adminAdjustmentAdd),
    endpoint('POST', 'admin-adjustment-remove', adminAdjustmentRemove),
    endpoint('POST', 'admin-config-save', adminConfigSave),
    endpoint('POST', 'admin-map-user', adminMapUser),
    endpoint('POST', 'admin-record-override', adminRecordOverride),
    endpoint('POST', 'admin-sync', adminSync)
  ],
  // Responses of the asynchronous Microsoft requests scheduled by teams-sync.js.
  asyncFunctions: {
    onToken: function (ctx) { teams.asyncFunctions.onToken(ctx); },
    onBatch: function (ctx) { teams.asyncFunctions.onBatch(ctx); }
  }
};

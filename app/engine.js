/**
 * Leave Sync for YouTrack – calculation engine.
 *
 * Pure JavaScript, no YouTrack dependencies, so it can be unit-tested with Node.
 *
 * Model
 * -----
 * - Leave years run from one work anniversary (hire date + k years) to the next.
 *   Period k starts on the k-th anniversary. Period 0 is the first year (no entitlement yet).
 * - Entitlement of period k depends on seniority k (tiers, default 1-5 → 14, 6-14 → 21, 15+ → 26;
 *   configurable in Leave Management)
 *   and an optional age floor (≤18 or ≥50 years old → at least 20 days).
 * - Unused leave carries over: remaining(k) = carry-in + entitlement + adjustments − used.
 * - Leave is counted in hours: weekends and public holidays are not deducted, half-day
 *   holidays (arife) count as half a working day, partial-day leave counts its real hours
 *   (capped at one working day per day).
 * - Only Teams reasons marked "deducts" reduce the balance; others are reported only.
 */

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// Defaults for a new installation: no country assumed. Administrators choose built-in holidays
// (Türkiye, Germany or none), the time zone and the entitlement rules in Leave Management.
const DEFAULT_CONFIG = {
  workdayHours: 8,
  weekendDays: [0, 6], // 0 = Sunday, 6 = Saturday
  utcOffsetMinutes: 0, // standard (winter) offset, e.g. 60 for Germany, 180 for Türkiye
  dstRule: 'NONE', // 'NONE' or 'EU' (+1 h from the last Sunday of March to the last Sunday of October, 01:00 UTC)
  autoFixedHolidays: true,
  holidayCountry: 'NONE', // legacy (before 1.4.0): 'TR' or 'DE' built-in lists, migrated into `holidays`
  holidays: [], // public holidays and days off entered by the administrator: { date, name, half }
  tiers: [
    { fromYears: 1, days: 14 },
    { fromYears: 6, days: 21 },
    { fromYears: 15, days: 26 }
  ],
  ageRule: { enabled: true, minDays: 20, youngMaxAge: 18, oldMinAge: 50 },
  reasons: {}, // teamsReasonId -> { name, deducts, reviewed, active }
  userMap: {}, // Entra user id -> YouTrack login
  unmatched: {}, // Entra user id -> { name, email, seenAt }
  syncIntervalMinutes: 30,
  useDrafts: true // count unshared changes made in the Shifts schedule
};

// ---------- date helpers (all dates are 'YYYY-MM-DD' strings in local company time) ----------

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function isoFromMs(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function msFromIso(iso) {
  const p = parseIso(iso);
  return Date.UTC(p.y, p.m - 1, p.d);
}

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw new Error('Invalid date: ' + iso + ' (expected YYYY-MM-DD)');
  const y = +m[1], mo = +m[2], d = +m[3];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) throw new Error('Invalid date: ' + iso);
  return { y: y, m: mo, d: d };
}

function isValidIso(iso) {
  try { parseIso(iso); return true; } catch (e) { return false; }
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Adds whole years; 29 Feb becomes 28 Feb in non-leap years. */
function addYears(iso, n) {
  const p = parseIso(iso);
  const y = p.y + n;
  let d = p.d;
  if (p.m === 2 && p.d === 29 && !isLeap(y)) d = 28;
  return y + '-' + pad(p.m) + '-' + pad(d);
}

function addDays(iso, n) {
  return isoFromMs(msFromIso(iso) + n * DAY_MS);
}

/** Last Sunday of a month (0-based month) at 01:00 UTC – the EU switch time. */
function lastSundayUtc(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}

function euSummerTime(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(y, 2) && utcMs < lastSundayUtc(y, 9);
}

/** Company UTC offset (ms) at a moment, including daylight saving time if configured. */
function offsetMs(cfg, utcMs) {
  const base = (cfg && typeof cfg.utcOffsetMinutes === 'number') ? cfg.utcOffsetMinutes : DEFAULT_CONFIG.utcOffsetMinutes;
  const dst = cfg && cfg.dstRule === 'EU' && euSummerTime(utcMs) ? 60 : 0;
  return (base + dst) * 60000;
}

/** UTC ms → local wall-clock ms (as if the local time were UTC). */
function toLocalMs(cfg, utcMs) {
  return utcMs + offsetMs(cfg, utcMs);
}

/** Local midnight at the start of a local date → UTC ms. */
function localMidnightUtc(cfg, iso) {
  const local = msFromIso(iso);
  let utc = local - offsetMs(cfg, local);
  utc = local - offsetMs(cfg, utc); // second pass settles DST switch days
  return utc;
}

function todayIso(cfg, nowMs) {
  const now = nowMs == null ? Date.now() : nowMs;
  return isoFromMs(toLocalMs(cfg, now));
}

/** 'HH:MM' local time of a UTC timestamp. */
function localTime(cfg, isoTs) {
  const d = new Date(toLocalMs(cfg, Date.parse(isoTs)));
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/** Whole years between two dates (age / seniority). */
function yearsBetween(fromIso, toIso) {
  const a = parseIso(fromIso), b = parseIso(toIso);
  let years = b.y - a.y;
  if (b.m < a.m || (b.m === a.m && b.d < a.d)) years--;
  return years;
}

// ---------- config ----------

// Installations created before 1.4.0 started with Türkiye defaults. If their stored settings miss
// one of these fields, they keep the old value so nothing changes for them.
const LEGACY_DEFAULTS = { utcOffsetMinutes: 180, holidayCountry: 'TR' };

function mergeConfig(stored) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!stored) return cfg;
  Object.keys(LEGACY_DEFAULTS).forEach(function (k) {
    if (stored[k] === undefined || stored[k] === null) cfg[k] = LEGACY_DEFAULTS[k];
  });
  Object.keys(stored).forEach(function (k) {
    if (stored[k] !== undefined && stored[k] !== null) cfg[k] = stored[k];
  });
  migrateBuiltInHolidays(cfg);
  if (!cfg.ageRule) cfg.ageRule = JSON.parse(JSON.stringify(DEFAULT_CONFIG.ageRule));
  if (!Array.isArray(cfg.tiers) || !cfg.tiers.length) cfg.tiers = JSON.parse(JSON.stringify(DEFAULT_CONFIG.tiers));
  if (!(cfg.workdayHours > 0)) cfg.workdayHours = 8;
  return cfg;
}

// ---------- holidays & working time ----------

const MIGRATION_FIRST_YEAR = 2020;

/**
 * Since 1.4.0 all holidays are entered by the administrator. Installations that used the built-in
 * Türkiye or Germany lists get those holidays copied into their own list once (2020 to next year),
 * so past and planned leave is counted exactly as before. Saved with the next settings change or sync.
 */
function migrateBuiltInHolidays(cfg, nowMs) {
  const country = cfg.autoFixedHolidays === false ? 'NONE' : cfg.holidayCountry;
  if (country !== 'TR' && country !== 'DE') {
    cfg.holidayCountry = 'NONE';
    return;
  }
  const byDate = {};
  (cfg.holidays || []).forEach(function (h) { if (h && h.date) byDate[h.date] = h; });
  const lastYear = new Date(nowMs == null ? Date.now() : nowMs).getUTCFullYear() + 1;
  for (let y = MIGRATION_FIRST_YEAR; y <= lastYear; y++) {
    fixedHolidays(y, country).forEach(function (h) {
      const prev = byDate[h.date];
      if (!prev || (prev.half && !h.half)) byDate[h.date] = { date: h.date, name: h.name, half: !!h.half };
    });
  }
  cfg.holidays = Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
  cfg.holidayCountry = 'NONE';
  cfg.autoFixedHolidays = false;
}

/** Easter Sunday (Gregorian, anonymous algorithm) as 'YYYY-MM-DD'. */
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return year + '-' + pad(month) + '-' + pad(day);
}

const HOLIDAY_COUNTRIES = {
  TR: 'Türkiye',
  DE: 'Germany (nationwide)',
  NONE: 'None – add all holidays yourself'
};

function holidayCountry(cfg) {
  if (cfg && cfg.autoFixedHolidays === false) return 'NONE';
  const c = cfg && cfg.holidayCountry;
  return HOLIDAY_COUNTRIES[c] ? c : 'NONE';
}

// Türkiye: religious holidays follow the lunar calendar and move every year. Known years are built in;
// later years are added by the administrator under "Other days off".
const TR_RELIGIOUS = {
  2026: [
    ['2026-03-19', 'Ramadan Feast Eve', true], ['2026-03-20', 'Ramadan Feast (day 1)'], ['2026-03-21', 'Ramadan Feast (day 2)'], ['2026-03-22', 'Ramadan Feast (day 3)'],
    ['2026-05-26', 'Sacrifice Feast Eve', true], ['2026-05-27', 'Sacrifice Feast (day 1)'], ['2026-05-28', 'Sacrifice Feast (day 2)'], ['2026-05-29', 'Sacrifice Feast (day 3)'], ['2026-05-30', 'Sacrifice Feast (day 4)']
  ],
  2027: [
    ['2027-03-08', 'Ramadan Feast Eve', true], ['2027-03-09', 'Ramadan Feast (day 1)'], ['2027-03-10', 'Ramadan Feast (day 2)'], ['2027-03-11', 'Ramadan Feast (day 3)'],
    ['2027-05-15', 'Sacrifice Feast Eve', true], ['2027-05-16', 'Sacrifice Feast (day 1)'], ['2027-05-17', 'Sacrifice Feast (day 2)'], ['2027-05-18', 'Sacrifice Feast (day 3)'], ['2027-05-19', 'Sacrifice Feast (day 4)']
  ]
};

/** Built-in public holidays for a year. Names are in English. */
function fixedHolidays(year, country) {
  country = country || 'NONE';
  if (country === 'TR') {
    // Law 2429 – fixed-date national holidays, plus the religious holidays of known years
    return [
      { date: year + '-01-01', name: 'New Year\'s Day', half: false },
      { date: year + '-04-23', name: 'National Sovereignty and Children\'s Day', half: false },
      { date: year + '-05-01', name: 'Labour and Solidarity Day', half: false },
      { date: year + '-05-19', name: 'Commemoration of Atatürk, Youth and Sports Day', half: false },
      { date: year + '-07-15', name: 'Democracy and National Unity Day', half: false },
      { date: year + '-08-30', name: 'Victory Day', half: false },
      { date: year + '-10-28', name: 'Republic Day Eve', half: true },
      { date: year + '-10-29', name: 'Republic Day', half: false }
    ].concat((TR_RELIGIOUS[year] || []).map(function (h) {
      return { date: h[0], name: h[1], half: !!h[2] };
    })).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
  }
  if (country === 'DE') {
    // Public holidays observed in every German state (regional ones are added by the admin)
    const easter = easterSunday(year);
    return [
      { date: year + '-01-01', name: 'New Year\'s Day', half: false },
      { date: addDays(easter, -2), name: 'Good Friday', half: false },
      { date: addDays(easter, 1), name: 'Easter Monday', half: false },
      { date: year + '-05-01', name: 'Labour Day', half: false },
      { date: addDays(easter, 39), name: 'Ascension Day', half: false },
      { date: addDays(easter, 50), name: 'Whit Monday', half: false },
      { date: year + '-10-03', name: 'Day of German Unity', half: false },
      { date: year + '-12-25', name: 'Christmas Day', half: false },
      { date: year + '-12-26', name: 'Second Day of Christmas', half: false }
    ].sort(function (x, y) { return x.date < y.date ? -1 : 1; });
  }
  return [];
}

/** Returns a lookup function date -> {name, half} | null. Full-day entries win over half-day ones. */
function holidayLookup(cfg) {
  const custom = {};
  (cfg.holidays || []).forEach(function (h) {
    if (!h || !isValidIso(h.date)) return;
    const prev = custom[h.date];
    if (!prev || (prev.half && !h.half)) custom[h.date] = { name: h.name || 'Holiday', half: !!h.half };
  });
  const fixedCache = {};
  return function (iso) {
    let hit = custom[iso] || null;
    const country = holidayCountry(cfg);
    if (country !== 'NONE') {
      const y = iso.slice(0, 4);
      if (!fixedCache[y]) {
        fixedCache[y] = {};
        fixedHolidays(+y, country).forEach(function (h) { fixedCache[y][h.date] = h; });
      }
      const f = fixedCache[y][iso];
      if (f && (!hit || (hit.half && !f.half))) hit = { name: f.name, half: f.half };
    }
    return hit;
  };
}

function dayOfWeek(iso) {
  return new Date(msFromIso(iso)).getUTCDay();
}

/** Working hours available on a date (0 on weekends/full holidays, half on half-day holidays). */
function dayCapacity(iso, cfg, lookup) {
  if ((cfg.weekendDays || []).indexOf(dayOfWeek(iso)) !== -1) return 0;
  const h = lookup(iso);
  if (h) return h.half ? cfg.workdayHours / 2 : 0;
  return cfg.workdayHours;
}

/**
 * Splits a leave record (UTC timestamps from Teams) into chargeable hours per local day.
 * A fully covered day counts as its capacity; a partial day counts its real hours, capped at capacity.
 */
function leaveHoursByDay(record, cfg, lookup) {
  const s = toLocalMs(cfg, Date.parse(record.start));
  const e = toLocalMs(cfg, Date.parse(record.end));
  const out = [];
  if (!(e > s)) return out;
  for (let d = Math.floor(s / DAY_MS) * DAY_MS; d < e; d += DAY_MS) {
    const overlap = Math.min(e, d + DAY_MS) - Math.max(s, d);
    if (overlap <= 0) continue;
    const iso = isoFromMs(d);
    const cap = dayCapacity(iso, cfg, lookup);
    const fullDay = overlap >= DAY_MS - 60000;
    const hours = cap <= 0 ? 0 : (fullDay ? cap : Math.min(overlap / HOUR_MS, cap));
    out.push({ date: iso, hours: round2(hours), calendarHours: round2(overlap / HOUR_MS), nonWorking: cap <= 0 });
  }
  return out;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// ---------- entitlement ----------

function tierDays(seniorityYears, cfg) {
  let days = 0;
  const tiers = cfg.tiers.slice().sort(function (a, b) { return a.fromYears - b.fromYears; });
  tiers.forEach(function (t) { if (seniorityYears >= t.fromYears) days = t.days; });
  return days;
}

/** Automatic entitlement (days) for period k starting on periodStartIso. */
function autoEntitlement(k, periodStartIso, profile, cfg) {
  if (k < 1) return { days: 0, rule: 'First year – no entitlement yet' };
  let days = tierDays(k, cfg);
  let rule = k + ' years of service → ' + days + ' days';
  const ar = cfg.ageRule;
  if (ar && ar.enabled && profile.birthDate && isValidIso(profile.birthDate)) {
    const age = yearsBetween(profile.birthDate, periodStartIso);
    if ((age <= ar.youngMaxAge || age >= ar.oldMinAge) && days < ar.minDays) {
      days = ar.minDays;
      rule += ' (raised to ' + ar.minDays + ' – age ' + age + ')';
    }
  }
  return { days: days, rule: rule };
}

function periodStart(hireIso, k) {
  return k <= 0 ? hireIso : addYears(hireIso, k);
}

/** Leave-year index containing a date; −1 if before the hire date. */
function periodIndexFor(iso, hireIso) {
  if (iso < hireIso) return -1;
  return yearsBetween(hireIso, iso);
}

/**
 * Admin correction of a single leave record:
 *   {mode:'exclude'}            → nothing is charged
 *   {mode:'hours', hours: n}    → n hours are charged, filled day by day from the first working day
 */
function applyRecordOverride(parts, ov) {
  if (!ov) return parts;
  if (ov.mode === 'exclude') return parts.map(function (p) { return Object.assign({}, p, { hours: 0 }); });
  if (ov.mode === 'hours' && typeof ov.hours === 'number' && ov.hours >= 0) {
    let left = ov.hours;
    const out = parts.map(function (p) {
      const take = Math.min(p.hours, left);
      left -= take;
      return Object.assign({}, p, { hours: round2(take) });
    });
    if (left > 0.001 && out.length) {
      const last = out.filter(function (p) { return !p.nonWorking; }).pop() || out[out.length - 1];
      last.hours = round2(last.hours + left);
    }
    return out;
  }
  return parts;
}

// ---------- tracking start ----------

/**
 * Index of the first tracked leave year. Leave before it is assumed to be included in the
 * opening balance. Admins can pick it (profile.trackFrom); otherwise it is the leave year
 * the employee was added in (profile.addedOn).
 */
function firstTrackedPeriod(profile, today) {
  const hire = profile.hireDate;
  const from = (profile.trackFrom && isValidIso(profile.trackFrom)) ? profile.trackFrom
    : (profile.addedOn && isValidIso(profile.addedOn)) ? profile.addedOn : today;
  return Math.max(periodIndexFor(from, hire), 0);
}

function trackingStartFor(profile, today) {
  return periodStart(profile.hireDate, firstTrackedPeriod(profile, today));
}

/** All leave-year starts from the hire date up to the current one (for the admin picker). */
function periodStarts(hireIso, today) {
  const out = [];
  const kc = Math.max(periodIndexFor(today, hireIso), 0);
  for (let k = 0; k <= kc; k++) out.push(periodStart(hireIso, k));
  return out;
}

/**
 * Opening balance that makes the remaining balance on `today` equal `target`, counting
 * only leave up to and including today (future approved leave is deducted afterwards).
 */
function openingForRemainingOn(profile, records, cfg, today, target) {
  const endOfToday = localMidnightUtc(cfg, addDays(today, 1)); // local midnight after today, in UTC ms
  const clipped = [];
  (records || []).forEach(function (r) {
    const s = Date.parse(r.start), e = Date.parse(r.end);
    if (!(s < endOfToday)) return;
    clipped.push(Object.assign({}, r, { end: new Date(Math.min(e, endOfToday)).toISOString() }));
  });
  const p = Object.assign({}, profile, { openingDays: 0 });
  const b = computeBalance(p, clipped, cfg, today);
  if (!b.configured || !b.current) return null;
  // Adjustments dated after today are not part of "today"
  const futureAdj = (profile.adjustments || []).filter(function (a) { return a.date > today && a.date <= b.current.end; })
    .reduce(function (sum, a) { return sum + (+a.days || 0); }, 0);
  return round2(target - (b.current.remainingDays - futureAdj));
}

// ---------- balance ----------

/**
 * @param profile {hireDate, birthDate?, addedOn?, openingDays?, openingConfirmed?, entOverrides?, adjustments?}
 * @param records [{id, start, end, reasonId, reasonName?}]
 * @param cfg merged config
 * @param today 'YYYY-MM-DD'
 */
function computeBalance(profile, records, cfg, today) {
  if (!profile || !profile.hireDate || !isValidIso(profile.hireDate)) {
    return { configured: false };
  }
  const hire = profile.hireDate;
  const wh = cfg.workdayHours;
  const lookup = holidayLookup(cfg);
  const kc = periodIndexFor(today, hire); // current period (−1 = not started yet)
  const k0 = firstTrackedPeriod(profile, today); // first tracked period
  const trackingStart = periodStart(hire, k0);
  const overrides = profile.entOverrides || {};

  function entitlementFor(k) {
    const start = periodStart(hire, k);
    const auto = autoEntitlement(k, start, profile, cfg);
    const ov = overrides[start];
    const hasOv = typeof ov === 'number' && isFinite(ov);
    return { start: start, auto: auto.days, rule: auto.rule, days: hasOv ? ov : auto.days, overridden: hasOv };
  }

  // Allocate every leave record to days and leave years.
  const allocations = [];
  const recordViews = [];
  const recordOverrides = profile.recordOverrides || {};
  (records || []).forEach(function (rec) {
    const reason = (cfg.reasons || {})[rec.reasonId] || null;
    const deducts = !!(reason && reason.deducts);
    const ov = recordOverrides[rec.id] || null;
    const original = leaveHoursByDay(rec, cfg, lookup);
    const originalHours = round2(original.reduce(function (s2, x) { return s2 + x.hours; }, 0));
    const parts = applyRecordOverride(original, ov);
    let total = 0, tracked = 0;
    parts.forEach(function (p) {
      total += p.hours;
      const k = periodIndexFor(p.date, hire);
      if (k < k0 || p.date < trackingStart) return; // before tracking start: covered by the opening balance
      tracked += p.hours;
      allocations.push({ k: k, date: p.date, hours: p.hours, reasonId: rec.reasonId, deducts: deducts, recId: rec.id });
    });
    recordViews.push({
      id: rec.id,
      start: rec.start,
      end: rec.end,
      firstDay: parts.length ? parts[0].date : null,
      lastDay: parts.length ? parts[parts.length - 1].date : null,
      reasonId: rec.reasonId,
      reasonName: reason ? reason.name : (rec.reasonName || 'Unknown reason'),
      deducts: deducts,
      hours: round2(total),
      days: round2(total / wh),
      beforeTracking: tracked < total - 0.001,
      startTime: localTime(cfg, rec.start),
      endTime: localTime(cfg, rec.end),
      unshared: !!rec.unshared,
      sharedStart: rec.sharedStart || null,
      sharedEnd: rec.sharedEnd || null,
      override: ov,
      originalHours: originalHours
    });
  });
  recordViews.sort(function (a, b) { return a.start < b.start ? 1 : -1; });

  let kmax = Math.max(kc, k0);
  allocations.forEach(function (a) { if (a.k > kmax) kmax = a.k; });

  // Opening balance = carry-in to the first tracked period. Default: everything earned before, unused.
  let autoOpening = 0;
  for (let k = 1; k < k0; k++) autoOpening += entitlementFor(k).days;
  const openingIsAuto = !(typeof profile.openingDays === 'number' && isFinite(profile.openingDays));
  const opening = openingIsAuto ? autoOpening : profile.openingDays;

  const adjustments = (profile.adjustments || []).slice();
  const periods = [];
  let carry = opening;
  for (let k = k0; k <= kmax; k++) {
    const ent = entitlementFor(k);
    const end = addDays(periodStart(hire, k + 1), -1);
    const adjList = adjustments.filter(function (a) { return a.date >= ent.start && a.date <= end; });
    const adj = adjList.reduce(function (s, a) { return s + (+a.days || 0); }, 0);
    const byType = {};
    let usedHours = 0;
    allocations.forEach(function (a) {
      if (a.k !== k) return;
      byType[a.reasonId] = (byType[a.reasonId] || 0) + a.hours;
      if (a.deducts) usedHours += a.hours;
    });
    const used = usedHours / wh;
    const remaining = carry + ent.days + adj - used;
    periods.push({
      index: k,
      start: ent.start,
      end: end,
      seniorityYears: k,
      isCurrent: k === kc,
      isFuture: k > kc,
      carryIn: round2(carry),
      entitlement: ent.days,
      entitlementAuto: ent.auto,
      entitlementRule: ent.rule,
      entitlementOverridden: ent.overridden,
      adjustments: round2(adj),
      adjustmentList: adjList,
      usedDays: round2(used),
      usedHours: round2(usedHours),
      remainingDays: round2(remaining),
      remainingHours: round2(remaining * wh),
      usageByType: Object.keys(byType).map(function (id) {
        const r = (cfg.reasons || {})[id];
        return { reasonId: id, name: r ? r.name : 'Unknown reason', deducts: !!(r && r.deducts), hours: round2(byType[id]), days: round2(byType[id] / wh) };
      }).sort(function (a, b) { return b.hours - a.hours; })
    });
    carry = remaining;
  }

  // Calendar-year usage by type (all tracked records, any reason).
  const calendar = {};
  allocations.forEach(function (a) {
    const y = a.date.slice(0, 4);
    calendar[y] = calendar[y] || {};
    calendar[y][a.reasonId] = (calendar[y][a.reasonId] || 0) + a.hours;
  });
  const calendarYears = {};
  Object.keys(calendar).forEach(function (y) {
    calendarYears[y] = Object.keys(calendar[y]).map(function (id) {
      const r = (cfg.reasons || {})[id];
      return { reasonId: id, name: r ? r.name : 'Unknown reason', deducts: !!(r && r.deducts), hours: round2(calendar[y][id]), days: round2(calendar[y][id] / wh) };
    }).sort(function (a, b) { return b.hours - a.hours; });
  });

  const current = periods.filter(function (p) { return p.isCurrent; })[0] || null;
  const next = kc >= 0 ? entitlementFor(kc + 1) : entitlementFor(1);

  return {
    configured: true,
    today: today,
    hireDate: hire,
    seniorityYears: Math.max(kc, 0),
    started: kc >= 0,
    workdayHours: wh,
    trackingStart: trackingStart,
    opening: round2(opening),
    openingAuto: round2(autoOpening),
    openingIsAuto: openingIsAuto,
    openingConfirmed: !!profile.openingConfirmed,
    current: current,
    nextAnniversary: { date: next.start, entitlement: next.days, rule: next.rule },
    periods: periods,
    calendarYears: calendarYears,
    records: recordViews,
    // Chargeable hours per day (tracked leave only) – lets the UI total any date range.
    dayLog: allocations.filter(function (a) { return a.hours > 0; }).map(function (a) {
      return { date: a.date, hours: a.hours, reasonId: a.reasonId, deducts: a.deducts, recId: a.recId };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }),
    reasonNames: Object.keys(cfg.reasons || {}).reduce(function (m, id) { m[id] = cfg.reasons[id].name; return m; }, {})
  };
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  mergeConfig: mergeConfig,
  computeBalance: computeBalance,
  leaveHoursByDay: leaveHoursByDay,
  applyRecordOverride: applyRecordOverride,
  holidayLookup: holidayLookup,
  fixedHolidays: fixedHolidays,
  easterSunday: easterSunday,
  holidayCountry: holidayCountry,
  HOLIDAY_COUNTRIES: HOLIDAY_COUNTRIES,
  autoEntitlement: autoEntitlement,
  periodIndexFor: periodIndexFor,
  periodStart: periodStart,
  periodStarts: periodStarts,
  firstTrackedPeriod: firstTrackedPeriod,
  trackingStartFor: trackingStartFor,
  openingForRemainingOn: openingForRemainingOn,
  addYears: addYears,
  addDays: addDays,
  dayOfWeek: dayOfWeek,
  localMidnightUtc: localMidnightUtc,
  todayIso: todayIso,
  offsetMs: offsetMs,
  localTime: localTime,
  isValidIso: isValidIso,
  yearsBetween: yearsBetween,
  round2: round2
};

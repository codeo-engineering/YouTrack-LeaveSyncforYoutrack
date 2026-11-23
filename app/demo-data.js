/**
 * Leave Sync for YouTrack – demo data (utility module).
 *
 * When "Use demo data" is on in the app settings, the sync makes no Microsoft calls. Instead it reads
 * sample Teams Shifts data from this module, shaped exactly like Microsoft Graph responses, and runs
 * it through the normal sync pipeline. This lets you try the app without a Microsoft 365 tenant.
 *
 * Sample time off is generated for every tracked employee, relative to today, so the data never
 * gets old. The Teams account of an employee carries their YouTrack e-mail address, so they are
 * matched automatically. Two extra Teams people show how unmatched people are handled: one with an
 * e-mail address that isn't in YouTrack (can be linked by hand) and one unknown account.
 */
const engine = require('./engine');

const TEAM_ID = '00000000-0000-4000-8000-00000000d3e0';
const REASONS = [
  { id: 'demo-vacation', displayName: 'Vacation', isActive: true },
  { id: 'demo-sick', displayName: 'Sick', isActive: true },
  { id: 'demo-personal', displayName: 'Personal day', isActive: true },
  { id: 'demo-parental', displayName: 'Parental leave', isActive: true }
];
const EXTRA_PEOPLE = [
  { id: 'demo-extra-1', displayName: 'Jordan Rivers (demo)', mail: 'jordan.rivers@demo.invalid' },
  { id: 'demo-extra-2', unknown: true }
];

function isDemoId(id) {
  return typeof id === 'string' && id.indexOf('demo-') === 0;
}

function teamUserId(login) {
  return 'demo-user-' + String(login).replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Moves a date forward to the next working day (Monday–Friday). */
function weekday(iso) {
  let d = iso;
  while (engine.dayOfWeek(d) === 0 || engine.dayOfWeek(d) === 6) d = engine.addDays(d, 1);
  return d;
}

function allDay(cfg, startIso, days) {
  return {
    startDateTime: new Date(engine.localMidnightUtc(cfg, startIso)).toISOString(),
    endDateTime: new Date(engine.localMidnightUtc(cfg, engine.addDays(startIso, days))).toISOString()
  };
}

function hours(cfg, dayIso, fromHour, toHour) {
  const midnight = engine.localMidnightUtc(cfg, dayIso);
  return {
    startDateTime: new Date(midnight + fromHour * 3600000).toISOString(),
    endDateTime: new Date(midnight + toHour * 3600000).toISOString()
  };
}

function version(range, reasonId, note) {
  return { startDateTime: range.startDateTime, endDateTime: range.endDateTime, timeOffReasonId: reasonId, displayName: note || null, theme: 'blue' };
}

/** Sample time off for one employee. `n` varies the dates between employees. */
function timeOffFor(cfg, today, userId, n) {
  const shift = (n % 5) * 3;
  const items = [];
  let seq = 0;
  function add(range, reasonId, note, extra) {
    seq++;
    const item = Object.assign({
      id: 'demo-TOF-' + userId.slice(10) + '-' + seq,
      userId: userId,
      isStagedForDeletion: false,
      sharedTimeOff: version(range, reasonId, note),
      draftTimeOff: null
    }, extra || {});
    items.push(item);
  }
  // Earlier this year: a full vacation week that spans a weekend (weekend days are not deducted).
  const week = weekday(engine.addDays(today, -150 + shift));
  add(allDay(cfg, week, 7), 'demo-vacation', 'Summer holiday');
  // Three vacation days.
  add(allDay(cfg, weekday(engine.addDays(today, -60 + shift)), 3), 'demo-vacation', null);
  // Time off around New Year's Day (a public holiday in the built-in calendars).
  const newYear = String(+today.slice(0, 4) - (today.slice(5) < '01-10' ? 1 : 0)) + '-01-01';
  if (newYear < today) add(allDay(cfg, engine.addDays(newYear, -1), 3), 'demo-vacation', 'New Year');
  // Half a day and a few hours.
  add(hours(cfg, weekday(engine.addDays(today, -25 + shift)), 9, 13), 'demo-personal', 'Half day');
  add(hours(cfg, weekday(engine.addDays(today, -12 + shift)), 14, 16), 'demo-sick', 'Doctor appointment');
  // Sick leave (not annual leave, unless you tick it on the Leave types tab).
  add(allDay(cfg, weekday(engine.addDays(today, -40 + shift)), 2), 'demo-sick', null);
  // Upcoming vacation.
  add(allDay(cfg, weekday(engine.addDays(today, 20 + shift)), 5), 'demo-vacation', 'Upcoming trip');
  // A manager shortened a request in the schedule but hasn't shared the change yet: 3 days → 1 day.
  const changed = weekday(engine.addDays(today, 45 + shift));
  add(allDay(cfg, changed, 3), 'demo-vacation', 'Shortened by manager', {
    draftTimeOff: version(allDay(cfg, changed, 1), 'demo-vacation', 'Shortened by manager')
  });
  // Deleted in the schedule (not shared yet): never counted.
  add(allDay(cfg, weekday(engine.addDays(today, 70 + shift)), 2), 'demo-vacation', 'Cancelled', { isStagedForDeletion: true });
  return items;
}

/**
 * Returns a function that answers Microsoft Graph requests (relative URLs, as used in $batch)
 * with demo data. `employees` are the tracked YouTrack users: [{ login, name, email }].
 */
function graph(cfg, today, employees) {
  const users = {};
  let timesOff = [];
  employees.slice(0, 100).forEach(function (e, i) {
    const id = teamUserId(e.login);
    users[id] = { id: id, displayName: e.name || e.login, mail: e.email || null, userPrincipalName: null };
    timesOff = timesOff.concat(timeOffFor(cfg, today, id, i));
  });
  EXTRA_PEOPLE.forEach(function (p, i) {
    if (!p.unknown) users[p.id] = { id: p.id, displayName: p.displayName, mail: p.mail, userPrincipalName: p.mail };
    timesOff.push({
      id: 'demo-TOF-extra-' + i,
      userId: p.id,
      isStagedForDeletion: false,
      sharedTimeOff: version(allDay(cfg, weekday(engine.addDays(today, -30 - i * 7)), 2), 'demo-vacation', null),
      draftTimeOff: null
    });
  });

  return function (url) {
    const path = String(url).split('?')[0];
    if (path === '/teams/' + TEAM_ID + '/schedule/timeOffReasons') return { status: 200, body: { value: REASONS } };
    if (path === '/teams/' + TEAM_ID + '/schedule/timesOff') return { status: 200, body: { value: timesOff } };
    const m = /^\/users\/([^/]+)$/.exec(path);
    if (m) {
      const u = users[decodeURIComponent(m[1])];
      return u ? { status: 200, body: u } : { status: 404, body: { error: { code: 'Request_ResourceNotFound', message: 'Resource does not exist.' } } };
    }
    return { status: 404, body: { error: { code: 'NotFound', message: 'Not found.' } } };
  };
}

module.exports = { TEAM_ID: TEAM_ID, VACATION_ID: 'demo-vacation', graph: graph, isDemoId: isDemoId };

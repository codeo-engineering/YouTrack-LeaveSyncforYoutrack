const assert = require('assert');
const path = require('path');
const E = require(path.resolve(process.argv[2] || path.join(__dirname, '../app/engine.js')));

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n     ', e.message); process.exitCode = 1; }
}

const cfg = E.mergeConfig({
  reasons: {
    TOR_off: { name: 'Off', deducts: true },
    TOR_sick: { name: 'Sick Day', deducts: false },
    TOR_marriage: { name: 'Marriage Leave', deducts: false }
  }
});
const lookup = E.holidayLookup(cfg);
// Teams stores UTC; an all-day leave on 11.11.2026 in Istanbul = 2026-11-10T21:00Z .. 2026-11-11T21:00Z
const allDay = (from, toExclusive) => ({ start: from + 'T00:00:00+03:00', end: toExclusive + 'T00:00:00+03:00' });

t('all-day leave on a Wednesday = 8h', () => {
  const r = E.leaveHoursByDay(allDay('2026-11-11', '2026-11-12'), cfg, lookup);
  assert.deepStrictEqual(r.map(x => [x.date, x.hours]), [['2026-11-11', 8]]);
});

t('Fri→Mon leave skips the weekend (2 working days)', () => {
  const r = E.leaveHoursByDay(allDay('2026-11-13', '2026-11-17'), cfg, lookup);
  assert.strictEqual(r.reduce((s, x) => s + x.hours, 0), 16);
});

t('public holiday (29 Oct) not deducted, 28 Oct half day', () => {
  const r = E.leaveHoursByDay(allDay('2026-10-28', '2026-10-30'), cfg, lookup);
  assert.deepStrictEqual(r.map(x => [x.date, x.hours]), [['2026-10-28', 4], ['2026-10-29', 0]]);
});

t('Kurban Bayramı week 2026: only Mon 25 May + half arife count', () => {
  const r = E.leaveHoursByDay(allDay('2026-05-25', '2026-05-30'), cfg, lookup);
  assert.strictEqual(r.reduce((s, x) => s + x.hours, 0), 12);
});

t('hourly leave 13:00-16:00 = 3h', () => {
  const r = E.leaveHoursByDay({ start: '2026-11-11T10:00:00Z', end: '2026-11-11T13:00:00Z' }, cfg, lookup);
  assert.deepStrictEqual(r.map(x => x.hours), [3]);
});

t('09:00-18:00 partial day is capped at 8h', () => {
  const r = E.leaveHoursByDay({ start: '2026-11-11T06:00:00Z', end: '2026-11-11T15:00:00Z' }, cfg, lookup);
  assert.deepStrictEqual(r.map(x => x.hours), [8]);
});

t('seniority tiers 14 / 21 / 26 with 5th year still 14', () => {
  const p = { hireDate: '2000-01-01' };
  const days = k => E.autoEntitlement(k, E.periodStart('2000-01-01', k), p, cfg).days;
  assert.deepStrictEqual([0, 1, 5, 6, 14, 15, 20].map(days), [0, 14, 14, 21, 21, 26, 26]);
});

t('age floor: 52-year-old with 2 years of service gets 20', () => {
  const p = { hireDate: '2024-01-01', birthDate: '1974-01-01' };
  assert.strictEqual(E.autoEntitlement(2, '2026-01-01', p, cfg).days, 20);
});

t('29 Feb hire date anniversaries fall on 28 Feb', () => {
  assert.strictEqual(E.addYears('2024-02-29', 1), '2025-02-28');
  assert.strictEqual(E.addYears('2024-02-29', 4), '2028-02-29');
});

t('existing employee: auto opening = all earlier entitlement, carry & remaining', () => {
  // hired 2019-03-15, added today 2026-11-11 → current period k=7 started 2026-03-15
  const profile = { hireDate: '2019-03-15', addedOn: '2026-11-11' };
  const records = [
    Object.assign({ id: 'a', reasonId: 'TOR_off' }, allDay('2026-11-09', '2026-11-12')), // Mon-Wed = 3 days
    Object.assign({ id: 'b', reasonId: 'TOR_sick' }, allDay('2026-06-01', '2026-06-02')), // not deducted
    { id: 'c', reasonId: 'TOR_off', start: '2026-07-01T10:00:00Z', end: '2026-07-01T14:00:00Z' } // 4h
  ];
  const b = E.computeBalance(profile, records, cfg, '2026-11-11');
  // k=1..5 → 14*5=70, k=6 → 21  ⇒ opening 91
  assert.strictEqual(b.openingAuto, 91);
  assert.strictEqual(b.current.index, 7);
  assert.strictEqual(b.current.entitlement, 21);
  assert.strictEqual(b.current.usedDays, 3.5);
  assert.strictEqual(b.current.remainingDays, 91 + 21 - 3.5);
  const sick = b.current.usageByType.find(u => u.reasonId === 'TOR_sick');
  assert.strictEqual(sick.days, 1);
});

t('admin overrides: opening, entitlement override and adjustment', () => {
  const profile = {
    hireDate: '2019-03-15', addedOn: '2026-11-11', openingDays: 6.5, openingConfirmed: true,
    entOverrides: { '2026-03-15': 22 },
    adjustments: [{ id: 'x', date: '2026-03-15', days: -1, note: 'paper leave before Teams' }]
  };
  const b = E.computeBalance(profile, [], cfg, '2026-11-11');
  assert.strictEqual(b.current.remainingDays, 6.5 + 22 - 1);
  assert.strictEqual(b.current.entitlementOverridden, true);
});

t('carry-over rolls into the next leave year on the anniversary', () => {
  const profile = { hireDate: '2024-11-20', addedOn: '2024-11-20' };
  const records = [Object.assign({ id: 'a', reasonId: 'TOR_off' }, allDay('2026-01-05', '2026-01-10'))]; // 5 days in year 2
  const b = E.computeBalance(profile, records, cfg, '2026-02-01');
  // period 0 (2024-11-20..2025-11-19): 0; period 1 (2025-11-20..): 14 − 5 = 9
  assert.strictEqual(b.periods.length, 2);
  assert.strictEqual(b.periods[0].remainingDays, 0);
  assert.strictEqual(b.periods[1].carryIn, 0);
  assert.strictEqual(b.current.remainingDays, 9);
  const b2 = E.computeBalance(profile, records, cfg, '2026-11-25');
  assert.strictEqual(b2.current.carryIn, 9);
  assert.strictEqual(b2.current.remainingDays, 9 + 14);
});

t('leave spanning an anniversary is split between leave years', () => {
  const profile = { hireDate: '2020-11-12', addedOn: '2026-01-01' }; // anniversary Thu 12 Nov 2026
  const records = [Object.assign({ id: 'a', reasonId: 'TOR_off' }, allDay('2026-11-11', '2026-11-13'))];
  const b = E.computeBalance(profile, records, cfg, '2026-11-13');
  const prev = b.periods.find(p => p.start === '2025-11-12');
  const cur = b.periods.find(p => p.start === '2026-11-12');
  assert.strictEqual(prev.usedDays, 1);
  assert.strictEqual(cur.usedDays, 1);
  assert.strictEqual(cur.entitlement, 21); // 6 years of service
});

t('new reason not reviewed yet does not deduct', () => {
  const profile = { hireDate: '2020-01-01', addedOn: '2026-01-01' };
  const records = [Object.assign({ id: 'a', reasonId: 'TOR_new' }, allDay('2026-11-11', '2026-11-12'))];
  const b = E.computeBalance(profile, records, cfg, '2026-11-11');
  assert.strictEqual(b.current.usedDays, 0);
});

t('unconfigured profile', () => {
  assert.strictEqual(E.computeBalance({}, [], cfg, '2026-11-11').configured, false);
});

t('recent hire tracked from hire date: first-year leave is deducted from the first entitlement', () => {
  // like the real case: hired 13 Oct 2025, today 11 Nov 2026
  const profile = { hireDate: '2025-10-13', addedOn: '2026-11-11', trackFrom: '2025-10-13' };
  const recs = [
    { id: '1', reasonId: 'TOR_off', start: '2026-02-13T06:00:00Z', end: '2026-02-13T10:00:00Z' }, // 4h
    Object.assign({ id: '2', reasonId: 'TOR_off' }, allDay('2026-03-16', '2026-03-19')),            // 3d
    Object.assign({ id: '3', reasonId: 'TOR_off' }, allDay('2026-09-29', '2026-10-01')),            // 2d
    Object.assign({ id: '4', reasonId: 'TOR_off' }, allDay('2026-10-30', '2026-10-31'))             // 1d (year 2)
  ];
  const b = E.computeBalance(profile, recs, cfg, '2026-11-11');
  assert.strictEqual(b.trackingStart, '2025-10-13');
  assert.strictEqual(b.periods[0].usedDays, 5.5);
  assert.strictEqual(b.periods[0].remainingDays, -5.5);
  assert.strictEqual(b.current.carryIn, -5.5);
  assert.strictEqual(b.current.remainingDays, -5.5 + 14 - 1);
  assert.ok(b.records.every(r => !r.beforeTracking));
});

t('without trackFrom the same leave counts as "before tracking"', () => {
  const profile = { hireDate: '2025-10-13', addedOn: '2026-11-11' };
  const recs = [Object.assign({ id: '2', reasonId: 'TOR_off' }, allDay('2026-03-16', '2026-03-19'))];
  const b = E.computeBalance(profile, recs, cfg, '2026-11-11');
  assert.strictEqual(b.trackingStart, '2026-10-13');
  assert.ok(b.records[0].beforeTracking);
});

t('remaining today → opening balance; future leave is deducted afterwards', () => {
  const profile = { hireDate: '2020-04-04', addedOn: '2026-11-11' };
  const recs = [
    Object.assign({ id: 'past', reasonId: 'TOR_off' }, allDay('2026-06-01', '2026-06-04')),   // 3 days, past
    Object.assign({ id: 'future', reasonId: 'TOR_off' }, allDay('2026-12-07', '2026-12-09')) // 2 days, future
  ];
  const opening = E.openingForRemainingOn(profile, recs, cfg, '2026-11-11', 3);
  // remaining today = opening + 21 − 3 = 3  ⇒ opening = −15
  assert.strictEqual(opening, -15);
  const b = E.computeBalance(Object.assign({}, profile, { openingDays: opening }), recs, cfg, '2026-11-11');
  assert.strictEqual(b.current.remainingDays, 1); // 3 today − 2 future days
});

t('remaining today for a recent hire tracked from hire date', () => {
  const profile = { hireDate: '2025-10-13', trackFrom: '2025-10-13' };
  const recs = [Object.assign({ id: 'a', reasonId: 'TOR_off' }, allDay('2026-03-16', '2026-03-19'))];
  assert.strictEqual(E.openingForRemainingOn(profile, recs, cfg, '2026-11-11', 11), 0);
});

t('Germany preset: Easter-based holidays and EU summer time', () => {
  const de = E.mergeConfig({ holidayCountry: 'DE', utcOffsetMinutes: 60, dstRule: 'EU', reasons: cfg.reasons });
  const look = E.holidayLookup(de);
  assert.strictEqual(E.easterSunday(2026), '2026-04-05');
  // Berlin all-day leave in summer: 00:00 CEST = 22:00Z the day before
  let r = E.leaveHoursByDay({ start: '2026-07-14T22:00:00Z', end: '2026-07-15T22:00:00Z' }, de, look);
  assert.deepStrictEqual(r.map(x => [x.date, x.hours]), [['2026-07-15', 8]]);
  // winter: 00:00 CET = 23:00Z
  r = E.leaveHoursByDay({ start: '2026-01-13T23:00:00Z', end: '2026-01-14T23:00:00Z' }, de, look);
  assert.deepStrictEqual(r.map(x => [x.date, x.hours]), [['2026-01-14', 8]]);
  // Good Friday + Easter Monday week: Thu 2 Apr – Tue 7 Apr 2026 → Thu + Tue = 2 days
  r = E.leaveHoursByDay({ start: '2026-04-01T22:00:00Z', end: '2026-04-07T22:00:00Z' }, de, look);
  assert.strictEqual(r.reduce((a, x) => a + x.hours, 0), 16);
  // Turkish holidays are not applied for Germany
  assert.strictEqual(look('2026-10-29'), null);
  assert.strictEqual(E.localTime(de, '2026-07-15T06:00:00Z'), '08:00');
});

t('Türkiye preset uses English names', () => {
  assert.strictEqual(E.fixedHolidays(2026, 'TR')[0].name, "New Year's Day");
  assert.strictEqual(E.fixedHolidays(2026, 'NONE').length, 0);
});

t('new installations start without a country; older ones keep Türkiye', () => {
  const fresh = E.mergeConfig(null);
  assert.strictEqual(fresh.holidayCountry, 'NONE');
  assert.strictEqual(fresh.utcOffsetMinutes, 0);
  assert.deepStrictEqual(fresh.holidays, []);
  assert.strictEqual(E.holidayLookup(fresh)('2026-01-01'), null, 'no built-in holiday by default');
  const legacy = E.mergeConfig({ reasons: {}, tiers: fresh.tiers });
  assert.strictEqual(legacy.holidayCountry, 'TR');
  assert.strictEqual(legacy.utcOffsetMinutes, 180);
  const saved = E.mergeConfig({ holidayCountry: 'DE', utcOffsetMinutes: 60 });
  assert.strictEqual(saved.holidayCountry, 'DE');
  assert.strictEqual(saved.utcOffsetMinutes, 60);
});

t('Türkiye: religious holidays of known years are built in and not counted twice', () => {
  const tr = E.mergeConfig({ holidayCountry: 'TR', utcOffsetMinutes: 180 });
  const look = E.holidayLookup(tr);
  assert.strictEqual(look('2026-03-20').name, 'Ramadan Feast (day 1)');
  assert.strictEqual(look('2027-05-15').half, true);
  assert.strictEqual(look('2026-03-20').half, false);
  // Older installations also have the same days under "Other days off".
  const both = E.mergeConfig({ holidayCountry: 'TR', utcOffsetMinutes: 180, holidays: [{ date: '2026-03-19', name: 'Ramadan Feast Eve', half: true }, { date: '2026-03-20', name: 'Ramadan Feast (day 1)', half: false }] });
  const rec = { id: 'x', start: '2026-03-16T21:00:00Z', end: '2026-03-21T21:00:00Z', reasonId: 'r' };
  const hours = E.leaveHoursByDay(rec, both, E.holidayLookup(both)).reduce((a, p) => a + p.hours, 0);
  // Local Tue 17 – Sat 21 March: 17 and 18 full (16 h), 19 eve half day (4 h), 20 holiday, 21 weekend → 20 h
  assert.strictEqual(hours, 20);
  assert.strictEqual(E.fixedHolidays(2026, 'DE').some(h => /Feast/.test(h.name)), false);
});

console.log('\n' + passed + ' passed');

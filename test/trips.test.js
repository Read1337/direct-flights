import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windows, bestTrip, bestTripOnDates, windowLengthDays, nightsBetween, operatingDays, quantileBins, PRESETS } from '../src/trips.js';

const f = (dep, arr, price) => ({ dep, arr, price });

test('weekend windows land on Fridays and run to Sunday night', () => {
  // 2026-11-06 is a Friday
  const w = windows(PRESETS.weekend, '2026-11-01', '2026-11-20');
  assert.deepEqual(w.map((x) => x.date), ['2026-11-06', '2026-11-13', '2026-11-20']);
  assert.equal(w[0].start, '2026-11-06T17:00');
  assert.equal(w[0].end, '2026-11-08T23:59');
});

test('windows already under way are skipped', () => {
  const w = windows(PRESETS.weekend, '2026-11-06', '2026-11-13', '2026-11-06T18:00');
  assert.deepEqual(w.map((x) => x.date), ['2026-11-13']);
});

test('long weekend wraps Thu → Mon', () => {
  assert.equal(windowLengthDays(PRESETS.long), 4);
  assert.equal(windows(PRESETS.long, '2026-11-01', '2026-11-07')[0].end, '2026-11-09T23:59');
});

test('same day and earlier end time means a week', () => {
  assert.equal(windowLengthDays({ startDay: 6, startTime: '09:00', endDay: 6, endTime: '08:00' }), 7);
  assert.equal(windowLengthDays({ startDay: 6, startTime: '09:00', endDay: 6, endTime: '20:00' }), 0);
});

const win = { start: '2026-12-04T17:00', end: '2026-12-06T23:59' };

test('picks the cheapest pair that fits', () => {
  const out = [f('2026-12-04T17:55:00', '2026-12-04T21:10:00', 30), f('2026-12-05T08:00:00', '2026-12-05T11:00:00', 15)];
  const back = [f('2026-12-06T15:00:00', '2026-12-06T16:30:00', 20), f('2026-12-06T21:00:00', '2026-12-06T22:30:00', 10)];
  const t = bestTrip(out, back, win, 24);
  assert.equal(t.total, 25);
  assert.equal(t.out.price, 15);
  assert.equal(t.back.price, 10);
  assert.equal(t.nights, 1);
});

test('rejects a Friday-morning departure (would need a day off)', () => {
  const out = [f('2026-12-04T06:20:00', '2026-12-04T09:40:00', 10)];
  const back = [f('2026-12-06T10:00:00', '2026-12-06T12:00:00', 10)];
  assert.equal(bestTrip(out, back, win, 0), null);
});

test('rejects a return landing after the window ends (Malta Monday 05:50 case)', () => {
  const out = [f('2026-12-04T20:15:00', '2026-12-05T00:25:00', 15)];
  const back = [f('2026-12-07T05:50:00', '2026-12-07T08:00:00', 15)];
  assert.equal(bestTrip(out, back, win, 0), null);
});

test('a late arrival home just after midnight is outside a Sunday-23:59 window', () => {
  const out = [f('2026-12-04T18:00:00', '2026-12-04T21:00:00', 10)];
  const back = [f('2026-12-06T21:30:00', '2026-12-07T00:10:00', 10)];
  assert.equal(bestTrip(out, back, win, 0), null);
});

test('enforces minimum time at destination', () => {
  const out = [f('2026-12-05T18:00:00', '2026-12-05T21:00:00', 10)];
  const back = [f('2026-12-06T09:00:00', '2026-12-06T11:00:00', 10)];
  assert.equal(bestTrip(out, back, win, 24), null);
  assert.equal(bestTrip(out, back, win, 12).hours, 12);
});

test('ties prefer more time there', () => {
  const out = [f('2026-12-04T18:00:00', '2026-12-04T21:00:00', 10)];
  const back = [f('2026-12-06T09:00:00', '2026-12-06T11:00:00', 10), f('2026-12-06T20:00:00', '2026-12-06T22:00:00', 10)];
  assert.equal(bestTrip(out, back, win, 0).back.dep, '2026-12-06T20:00:00');
});

test('totals do not drift on float cents', () => {
  const t = bestTrip([f('2026-12-04T18:00:00', '2026-12-04T21:00:00', 14.99)], [f('2026-12-06T18:00:00', '2026-12-06T20:00:00', 19.99)], win, 0);
  assert.equal(t.total, 34.98);
});

test('nights and operating days', () => {
  assert.equal(nightsBetween('2026-12-04T21:10:00', '2026-12-06T21:00:00'), 2);
  assert.deepEqual(operatingDays([f('2026-12-04T10:00:00', '', 1), f('2026-12-07T10:00:00', '', 1), f('2026-12-06T10:00:00', '', 1)]), ['Mon', 'Fri', 'Sun']);
  assert.deepEqual(operatingDays([]), []);
});

test('operating days ignore a stray week of the old schedule', () => {
  // Malaga: daily in the last summer week (26 Oct–1 Nov 2026), then Mon + Fri for 4 weeks.
  const summer = ['26', '27', '28', '29', '30', '31'].map((d) => f(`2026-10-${d}T17:00:00`, '', 1));
  const winter = ['02', '06', '09', '13', '16', '20', '23', '27'].map((d) => f(`2026-11-${d}T17:00:00`, '', 1));
  assert.deepEqual(operatingDays([...summer, ...winter]), ['Mon', 'Fri']);
});

test('quantile bins put cheapest in 0 and priciest in the top bin', () => {
  const { binOf } = quantileBins([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 5);
  assert.equal(binOf(10), 0);
  assert.equal(binOf(100), 4);
  assert.equal(quantileBins([]).binOf(5), 0);
  const few = quantileBins([98, 384, 507]);
  assert.deepEqual([98, 384, 507].map(few.binOf), [0, 1, 2]);
});

const dates = { outFrom: '2026-12-04', outTo: '2026-12-04', backFrom: '2026-12-06', backTo: '2026-12-06' };

test('exact dates: only flights on those days, any time', () => {
  const out = [f('2026-12-04T06:20:00', '2026-12-04T09:40:00', 20), f('2026-12-05T06:20:00', '2026-12-05T09:40:00', 5)];
  const back = [f('2026-12-06T10:00:00', '2026-12-06T12:00:00', 15), f('2026-12-07T10:00:00', '2026-12-07T12:00:00', 1)];
  const t = bestTripOnDates(out, back, dates);
  assert.equal(t.total, 35);
  assert.equal(t.shift, 0);
  assert.equal(bestTripOnDates(out.slice(1), back, dates), null);
});

test('flexible dates find a cheaper shifted pair, and prefer requested dates on a tie', () => {
  const out = [f('2026-12-04T18:00:00', '2026-12-04T21:00:00', 30), f('2026-12-05T18:00:00', '2026-12-05T21:00:00', 10)];
  const back = [f('2026-12-06T18:00:00', '2026-12-06T20:00:00', 10)];
  const flex = { outFrom: '2026-12-03', outTo: '2026-12-05', backFrom: '2026-12-05', backTo: '2026-12-07', outWant: '2026-12-04', backWant: '2026-12-06' };
  assert.equal(bestTripOnDates(out, back, flex).out.dep, '2026-12-05T18:00:00');
  const tied = [f('2026-12-03T18:00:00', '2026-12-03T21:00:00', 10), f('2026-12-04T18:00:00', '2026-12-04T21:00:00', 10)];
  assert.equal(bestTripOnDates(tied, back, flex).out.dep, '2026-12-04T18:00:00');
});

test('return must leave after the outbound lands', () => {
  const same = { outFrom: '2026-12-04', outTo: '2026-12-04', backFrom: '2026-12-04', backTo: '2026-12-04' };
  const out = [f('2026-12-04T09:00:00', '2026-12-04T12:00:00', 10)];
  assert.equal(bestTripOnDates(out, [f('2026-12-04T11:00:00', '2026-12-04T13:00:00', 10)], same), null);
  assert.equal(bestTripOnDates(out, [f('2026-12-04T19:00:00', '2026-12-04T21:00:00', 10)], same).hours, 7);
});

test('minNights rules out same-day turnarounds from overlapping flexible ranges', () => {
  const span = { outFrom: '2026-12-02', outTo: '2026-12-06', backFrom: '2026-12-04', backTo: '2026-12-08' };
  const out = [f('2026-12-04T06:20:00', '2026-12-04T10:25:00', 10), f('2026-12-05T13:00:00', '2026-12-05T16:00:00', 20)];
  const back = [f('2026-12-04T11:00:00', '2026-12-04T15:00:00', 10), f('2026-12-07T11:00:00', '2026-12-07T15:00:00', 30)];
  assert.equal(bestTripOnDates(out, back, span).nights, 0);
  const t = bestTripOnDates(out, back, { ...span, minNights: 1 });
  assert.equal(t.nights >= 1, true);
  assert.equal(t.total, 40);
});

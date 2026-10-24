import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windows, bestTrip, windowLengthDays, nightsBetween, operatingDays, quantileBins, PRESETS } from '../src/trips.js';

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
});

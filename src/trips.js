// Pure trip logic: turns per-day flights into weekly trip windows and cheapest
// round trips. No DOM, no fetching — so it can be tested in node.
//
// Times are naive local strings ("2026-12-04T17:55:00"): departures are in the
// departure airport's local time, arrivals in the arrival airport's. That is
// exactly what we need — "leave after Fri 17:00" is checked against home time,
// "back by Sun 23:59" against home time, and time-at-destination subtracts two
// destination-local times.

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const PRESETS = {
  weekend: { label: 'Weekend', startDay: 5, startTime: '17:00', endDay: 0, endTime: '23:59', minHours: 24 },
  dayOff: { label: 'Fri off', startDay: 5, startTime: '00:00', endDay: 0, endTime: '23:59', minHours: 36 },
  long: { label: 'Long weekend', startDay: 4, startTime: '17:00', endDay: 1, endTime: '23:59', minHours: 48 },
};

const pad = (n) => String(n).padStart(2, '0');
export const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcDate = (s) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
// Naive local timestamp → ms, treating it as UTC so no DST/zone shifting happens.
export const ms = (t) => Date.parse(`${t.length === 16 ? `${t}:00` : t}Z`);

// Days from window start to window end. Same day with end <= start means a full week.
export function windowLengthDays({ startDay, startTime, endDay, endTime }) {
  const d = (endDay - startDay + 7) % 7;
  return d === 0 && endTime <= startTime ? 7 : d;
}

// Every window instance whose start falls in [from, to] (YYYY-MM-DD strings), skipping
// any that has already begun relative to `now` (a naive local "YYYY-MM-DDTHH:MM").
export function windows(spec, from, to, now = `${from}T00:00`) {
  const len = windowLengthDays(spec);
  const out = [];
  for (let d = utcDate(from); isoDate(d) <= to; d = addDays(d, 1)) {
    if (d.getUTCDay() !== spec.startDay) continue;
    const date = isoDate(d);
    const start = `${date}T${spec.startTime}`;
    if (start < now) continue;
    out.push({ date, start, end: `${isoDate(addDays(d, len))}T${spec.endTime}` });
  }
  return out;
}

// The cheapest out+back pair that fits in the window, or null.
// Flights: { dep, arr, price } with dep/arr as naive local timestamps.
export function bestTrip(outbound, inbound, win, minHours) {
  const start = ms(win.start);
  const end = ms(win.end);
  let best = null;
  for (const o of outbound) {
    const dep = ms(o.dep);
    if (dep < start || dep > end) continue;
    const landed = ms(o.arr);
    for (const b of inbound) {
      if (ms(b.arr) > end) continue;
      const hours = (ms(b.dep) - landed) / 3600000;
      if (hours < minHours) continue;
      const total = Math.round((o.price + b.price) * 100) / 100;
      if (!best || total < best.total || (total === best.total && hours > best.hours)) {
        best = { out: o, back: b, total, hours, nights: nightsBetween(o.arr, b.dep) };
      }
    }
  }
  return best;
}

// Cheapest out+back with the outbound departing on a date in [outFrom, outTo] and the
// return departing on a date in [backFrom, backTo] (YYYY-MM-DD, inclusive). Ties go to
// the pair closest to the requested dates, then the one with more time there.
// minNights stops overlapping flexible ranges from producing "fly out and straight back".
export function bestTripOnDates(outbound, inbound, { outFrom, outTo, backFrom, backTo, outWant = outFrom, backWant = backTo, minNights = 0 }) {
  const off = (t, want) => Math.abs(ms(`${t.slice(0, 10)}T00:00`) - ms(`${want}T00:00`)) / 86400000;
  let best = null;
  for (const o of outbound) {
    const od = o.dep.slice(0, 10);
    if (od < outFrom || od > outTo) continue;
    const landed = ms(o.arr);
    for (const b of inbound) {
      const bd = b.dep.slice(0, 10);
      if (bd < backFrom || bd > backTo || ms(b.dep) <= landed || nightsBetween(o.arr, b.dep) < minNights) continue;
      const total = Math.round((o.price + b.price) * 100) / 100;
      const shift = off(o.dep, outWant) + off(b.dep, backWant);
      const hours = (ms(b.dep) - landed) / 3600000;
      if (!best || total < best.total || (total === best.total && (shift < best.shift || (shift === best.shift && hours > best.hours)))) {
        best = { out: o, back: b, total, hours, shift, nights: nightsBetween(o.arr, b.dep) };
      }
    }
  }
  return best;
}

export function nightsBetween(arr, dep) {
  return Math.round((utcDate(dep) - utcDate(arr)) / 86400000);
}

// Weekdays a route regularly operates on: days that have a flight in at least half
// of the weeks seen. Stops a schedule change (summer daily → winter Mon/Fri) or a
// one-off extra flight from making a route look daily. → ["Mon", "Fri"]
export function operatingDays(flights) {
  if (!flights.length) return [];
  const weekOf = (t) => Math.floor((ms(`${t.slice(0, 10)}T00:00`) / 86400000 + 3) / 7); // Monday-based
  const weeks = new Set(flights.map((f) => weekOf(f.dep)));
  const perDay = new Map();
  for (const f of flights) {
    const d = utcDate(f.dep).getUTCDay();
    perDay.set(d, (perDay.get(d) || new Set()).add(weekOf(f.dep)));
  }
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => (perDay.get(d)?.size || 0) * 2 >= weeks.size).map((d) => DAY_NAMES[d]);
}

// Split values into `n` quantile bins; returns a function value → bin index (0 = cheapest).
export function quantileBins(values, n = 5) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { binOf: () => 0, edges: [] };
  n = Math.min(n, new Set(sorted).size); // never more bins than distinct prices
  const edges = [];
  for (let i = 1; i < n; i++) edges.push(sorted[Math.min(sorted.length - 1, Math.floor((i * sorted.length) / n))]);
  const binOf = (v) => {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    return i;
  };
  return { binOf, edges, min: sorted[0], max: sorted[sorted.length - 1] };
}

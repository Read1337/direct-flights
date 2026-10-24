import { getAirports, getRoutes, getMonth, pool, bookingUrl, BlockedError } from './api.js?v=__V__';
import { DAY_NAMES, PRESETS, windows, bestTrip, bestTripOnDates, operatingDays, quantileBins, isoDate } from './trips.js?v=__V__';

const $ = (id) => document.getElementById(id);
const SYMBOL = { GBP: '£', EUR: '€' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- settings (URL ?from= wins, then saved, then defaults) ----

// mode 'weekly' = every matching weekend in a range; 'dates' = one specific out/back pair.
const DEFAULTS = {
  origin: 'BOH', currency: 'GBP', weeks: 8, start: '', sort: 'price', hideEmpty: false,
  mode: 'weekly', preset: 'weekend', spec: { ...PRESETS.weekend }, dates: { out: '', back: '', flex: 0 },
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('df:settings')) || {}; } catch {}
  const s = { ...DEFAULTS, ...saved, spec: { ...DEFAULTS.spec, ...saved.spec }, dates: { ...DEFAULTS.dates, ...saved.dates } };
  const q = new URLSearchParams(location.search);
  const from = q.get('from');
  if (from && /^[A-Za-z]{3}$/.test(from)) s.origin = from.toUpperCase();
  // ?out=2026-12-04&back=2026-12-06[&flex=1] opens straight into specific dates (shareable).
  if (ISO.test(q.get('out') || '') && ISO.test(q.get('back') || '')) {
    s.mode = 'dates';
    s.preset = 'dates';
    s.dates = { out: q.get('out'), back: q.get('back'), flex: Math.min(3, Math.max(0, Number(q.get('flex')) || 0)) };
  }
  return s;
})();
const save = () => {
  try { localStorage.setItem('df:settings', JSON.stringify(settings)); } catch {}
  const url = new URL(location);
  url.searchParams.set('from', settings.origin);
  for (const k of ['out', 'back', 'flex']) url.searchParams.delete(k);
  if (settings.mode === 'dates') {
    url.searchParams.set('out', settings.dates.out);
    url.searchParams.set('back', settings.dates.back);
    if (settings.dates.flex) url.searchParams.set('flex', settings.dates.flex);
  }
  history.replaceState(null, '', url);
};

// ---- data for the current origin ----

let airports = [];
let routes = [];
let fares = new Map();   // "BOH-AGP" → [{dep, arr, price}]
let pending = new Map(); // dest code → jobs still outstanding for that row
let progress = { done: 0, total: 0 };
let loadError = null;
let controller = null;

const today = () => isoDate(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
const nowLocal = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${today()}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const plusDays = (iso, n) => isoDate(new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000));

// First-of-month strings for every month the horizon (plus one window) touches.
function monthsCovering(from, to) {
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// Next Friday → Sunday, as a starting point for "Pick dates".
function defaultDates() {
  const t = today();
  const dow = new Date(`${t}T00:00:00Z`).getUTCDay();
  const out = plusDays(t, ((5 - dow + 7) % 7) || 7);
  return { out, back: plusDays(out, 2) };
}

// Keep dates sane: nothing in the past, back never before out.
function fixDates() {
  const t = today();
  const d = settings.dates;
  if (!ISO.test(d.out) || d.out < t) Object.assign(d, defaultDates());
  if (!ISO.test(d.back) || d.back < d.out) d.back = plusDays(d.out, 2);
}

const weeklyStart = () => (settings.start && settings.start > today() ? settings.start : today());

// The date span we need fares for, as [from, to].
function range() {
  if (settings.mode === 'dates') {
    const { out, back, flex } = settings.dates;
    const from = plusDays(out, -flex);
    return [from < today() ? today() : from, plusDays(back, flex)];
  }
  const from = weeklyStart();
  return [from, plusDays(from, settings.weeks * 7 + 8)]; // +8: a window starting on the last day still needs its return
}

let loadedKey = null;
const fetchKey = () => `${settings.origin}|${settings.currency}|${monthsCovering(...range()).join(',')}`;

async function load() {
  loadedKey = fetchKey();
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const origin = settings.origin;
  const currency = settings.currency;

  // Each load owns its maps, so a superseded load's late responses can't leak into this one.
  const own = { fares: new Map(), pending: new Map(), progress: { done: 0, total: 0 } };
  ({ fares, pending, progress } = own);
  routes = [];
  loadError = null;
  render();

  let list;
  try {
    list = await getRoutes(origin, signal);
  } catch (e) {
    if (signal.aborted) return;
    loadError = e instanceof BlockedError ? 'Ryanair is refusing requests right now (rate limited). Try again in a while.' : `Couldn't load routes for ${origin}.`;
    return render();
  }
  if (signal.aborted) return;
  routes = list;

  // Month-major order so the nearest weekends fill in across every row first.
  const months = monthsCovering(...range());
  const jobs = [];
  for (const month of months) {
    for (const r of list) {
      for (const [a, b] of [[origin, r.code], [r.code, origin]]) {
        own.pending.set(r.code, (own.pending.get(r.code) || 0) + 1);
        jobs.push(async () => {
          try {
            const flights = await getMonth(a, b, month, currency, signal);
            const key = `${a}-${b}`;
            own.fares.set(key, [...(own.fares.get(key) || []), ...flights]);
          } catch (e) {
            if (e instanceof BlockedError && !signal.aborted) {
              loadError = 'Ryanair started refusing requests (rate limited). Showing what loaded; try again later.';
              controller.abort();
            }
            if (signal.aborted) return;
          }
          own.pending.set(r.code, own.pending.get(r.code) - 1);
          own.progress.done++;
          scheduleRender();
        });
      }
    }
  }
  own.progress.total = jobs.length;
  render();
  await pool(jobs, 4, signal);
  if (fares === own.fares) render();
}

// ---- rendering ----

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 200);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const hhmm = (t) => t.slice(11, 16);
const dayOf = (t) => DAY_NAMES[new Date(`${t.slice(0, 10)}T00:00:00Z`).getUTCDay()];
const dateLabel = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};
const money = (v, dp = 0) => `${SYMBOL[settings.currency] || ''}${v.toFixed(dp)}`;

// "flies Mon Fri", or "out Fri · back Mon" when the directions differ.
function daysLabel(out, back) {
  const fmt = (d) => (d.length === 7 ? 'daily' : d.join(' '));
  const o = operatingDays(out);
  const b = operatingDays(back);
  if (!o.length && !b.length) return '';
  return fmt(o) === fmt(b) ? `flies ${fmt(o)}` : `out ${fmt(o) || '–'} · back ${fmt(b) || '–'}`;
}

let trips = []; // index → trip, for the tooltip

function render() {
  renderStatus();
  const grid = $('grid');
  if (!routes.length) {
    grid.innerHTML = '';
    $('legend').innerHTML = '';
    return;
  }

  if (settings.mode === 'dates') return renderDates(grid);

  const from = weeklyStart();
  const wins = windows(settings.spec, from, plusDays(from, settings.weeks * 7), nowLocal());
  const origin = settings.origin;

  let rows = routes.map((r) => {
    const out = fares.get(`${origin}-${r.code}`) || [];
    const back = fares.get(`${r.code}-${origin}`) || [];
    const cells = wins.map((w) => bestTrip(out, back, w, settings.spec.minHours));
    const prices = cells.filter(Boolean).map((t) => t.total);
    return { r, cells, best: prices.length ? Math.min(...prices) : Infinity, loading: pending.get(r.code) > 0, days: daysLabel(out, back) };
  });

  if (settings.hideEmpty) rows = rows.filter((x) => x.loading || x.best < Infinity);
  sortRows(rows);

  const { binOf, edges, min, max } = quantileBins(rows.flatMap((x) => x.cells.filter(Boolean).map((t) => t.total)));
  renderLegend(edges, min, max);

  trips = [];
  const head = `<thead><tr><th scope="col">${rows.length} destination${rows.length === 1 ? '' : 's'}</th>${wins
    .map((w) => `<th scope="col"><span class="wd">${dayOf(w.start)}</span>${dateLabel(w.date)}</th>`)
    .join('')}</tr></thead>`;

  const body = rows
    .map(({ r, cells, loading, days }) => {
      const meta = [r.country, days || (loading ? '' : 'no flights in range')].filter(Boolean).join(' · ');
      const th = destHeader(r, meta);
      const tds = cells
        .map((t, i) => {
          if (!t) return `<td>${loading ? '<span class="wait">…</span>' : '<span class="none" aria-label="No trip">–</span>'}</td>`;
          const id = trips.push({ t, r, w: wins[i] }) - 1;
          const href = bookingUrl(origin, r.code, t.out.dep.slice(0, 10), t.back.dep.slice(0, 10));
          return `<td><a class="b${binOf(t.total)}" href="${esc(href)}" target="_blank" rel="noopener" data-i="${id}" aria-label="${esc(`${r.city}, ${money(t.total, 2)}, ${dayOf(t.out.dep)} to ${dayOf(t.back.dep)}`)}"><b>${money(t.total)}</b><small>${dayOf(t.out.dep)}→${dayOf(t.back.dep)}</small></a></td>`;
        })
        .join('');
      return `<tr>${th}${tds}</tr>`;
    })
    .join('');

  grid.className = '';
  grid.innerHTML = head + `<tbody>${body}</tbody>`;
}

const sortRows = (rows) =>
  rows.sort(settings.sort === 'name' ? (a, b) => a.r.city.localeCompare(b.r.city) : (a, b) => a.best - b.best || a.r.city.localeCompare(b.r.city));

const destHeader = (r, meta) =>
  `<th scope="row" class="dest"><div class="dw"><span class="city">${flag(r.countryCode)} ${esc(r.city)}</span>${r.recent ? '<span class="badge">NEW</span>' : ''}<span class="meta" title="${esc(meta)}">${esc(meta)}</span></div></th>`;

// Specific dates: one row per destination with the actual flights, cheapest first.
function renderDates(grid) {
  const origin = settings.origin;
  const { out, back, flex } = settings.dates;
  const wantNights = Math.round((Date.parse(back) - Date.parse(out)) / 86400000);
  const span = {
    outFrom: plusDays(out, -flex), outTo: plusDays(out, flex), backFrom: plusDays(back, -flex), backTo: plusDays(back, flex),
    outWant: out, backWant: back,
    minNights: wantNights === 0 ? 0 : Math.max(1, wantNights - flex), // a day trip only if you asked for one
  };

  let rows = routes.map((r) => {
    const o = fares.get(`${origin}-${r.code}`) || [];
    const b = fares.get(`${r.code}-${origin}`) || [];
    const t = bestTripOnDates(o, b, span);
    return { r, t, best: t ? t.total : Infinity, loading: pending.get(r.code) > 0, days: daysLabel(o, b) };
  });
  if (settings.hideEmpty) rows = rows.filter((x) => x.loading || x.t);
  sortRows(rows);

  const { binOf, edges, min, max } = quantileBins(rows.filter((x) => x.t).map((x) => x.t.total));
  renderLegend(edges, min, max, flex ? `Cheapest return within ±${flex} day${flex > 1 ? 's' : ''} of your dates, per person` : 'Cheapest return on your dates, per person');

  const when = (f, want, from, to) => {
    const d = f.dep.slice(0, 10);
    const diff = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${want}T00:00:00Z`)) / 86400000);
    const tag = diff ? ` <span class="shift">${diff > 0 ? '+' : '−'}${Math.abs(diff)}d</span>` : '';
    return `<td class="when"><b>${dayOf(f.dep)} ${dateLabel(d)}${tag}</b>${hhmm(f.dep)}<span class="code"> ${from}</span> → ${hhmm(f.arr)}<span class="code"> ${to}</span></td>`;
  };

  trips = [];
  const head = `<thead><tr><th scope="col">${rows.length} destination${rows.length === 1 ? '' : 's'}</th><th scope="col">Return</th><th scope="col">Out</th><th scope="col">Back</th></tr></thead>`;
  const body = rows
    .map(({ r, t, loading, days }) => {
      const th = destHeader(r, [r.country, days || (loading ? '' : 'no flights in range')].filter(Boolean).join(' · '));
      if (!t) return `<tr>${th}<td colspan="3" class="nope">${loading ? '…' : 'No flights that fit these dates'}</td></tr>`;
      const id = trips.push({ t, r }) - 1;
      const href = bookingUrl(origin, r.code, t.out.dep.slice(0, 10), t.back.dep.slice(0, 10));
      const price = `<td><a class="b${binOf(t.total)}" href="${esc(href)}" target="_blank" rel="noopener" data-i="${id}" aria-label="${esc(`${r.city}, ${money(t.total, 2)}`)}"><b>${money(t.total)}</b><small>${t.nights} night${t.nights === 1 ? '' : 's'}</small></a></td>`;
      return `<tr>${th}${price}${when(t.out, out, origin, r.code)}${when(t.back, back, r.code, origin)}</tr>`;
    })
    .join('');

  grid.className = 'list';
  grid.innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderStatus() {
  const el = $('status');
  el.className = 'status';
  if (loadError) {
    el.classList.add('error');
    el.textContent = loadError;
  } else if (progress.total && progress.done < progress.total) {
    const pct = Math.round((100 * progress.done) / progress.total);
    el.innerHTML = `<span class="bar"><i style="width:${pct}%"></i></span> Checking ${routes.length} routes… ${pct}%`;
  } else if (!routes.length) {
    el.textContent = `Loading routes from ${settings.origin}…`;
  } else {
    el.textContent = `${routes.length} direct routes from ${settings.origin}`;
  }
}

function renderLegend(edges, min, max, title = 'Cheapest return in each window, per person') {
  if (min === undefined) return ($('legend').innerHTML = '');
  const bounds = [min, ...edges, max];
  const sw = bounds.slice(0, -1).map((lo, i) => {
    const hi = bounds[i + 1];
    const label = i === bounds.length - 2 ? (lo === hi ? money(lo) : `${money(lo)}+`) : `${money(lo)}–${money(hi)}`;
    return `<span class="sw b${i}">${label}</span>`;
  });
  $('legend').innerHTML = `<span>${title}</span><span class="swatches">${sw.join('')}</span>`;
}

// ---- tooltip ----

function showTip(a) {
  const { t, r } = trips[a.dataset.i] || {};
  if (!t) return;
  const leg = (k, f, from, to) =>
    `<span class="k">${k}</span><span>${dayOf(f.dep)} ${dateLabel(f.dep.slice(0, 10))} · ${hhmm(f.dep)} ${from} → ${hhmm(f.arr)} ${to}</span><span>${money(f.price, 2)}</span>`;
  const tip = $('tip');
  tip.innerHTML = `<div><b>${esc(r.city)}</b> · ${t.nights} night${t.nights === 1 ? '' : 's'} · ${Math.round(t.hours)}h there</div>
    <div class="leg">${leg('Out', t.out, settings.origin, r.code)}${leg('Back', t.back, r.code, settings.origin)}</div>
    <div class="total"><span>Total</span><span>${money(t.total, 2)}</span></div>
    <div class="hint">Click to open on ryanair.com</div>`;
  tip.hidden = false;
  const box = a.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = Math.min(window.innerWidth - w - 8, Math.max(8, box.left + box.width / 2 - w / 2));
  let y = box.top - h - 8;
  if (y < 8) y = box.bottom + 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => ($('tip').hidden = true);
$('grid').addEventListener('mouseover', (e) => { const a = e.target.closest('a[data-i]'); a ? showTip(a) : hideTip(); });
$('grid').addEventListener('focusin', (e) => { const a = e.target.closest('a[data-i]'); if (a) showTip(a); });
$('grid').addEventListener('mouseleave', hideTip);
$('grid').addEventListener('focusout', hideTip);
document.querySelector('.grid-wrap').addEventListener('scroll', hideTip, { passive: true });

// ---- controls ----

function syncControls() {
  $('origin').value = labelFor(settings.origin);
  for (const k of ['startDay', 'endDay']) $(k).value = settings.spec[k];
  for (const k of ['startTime', 'endTime', 'minHours']) $(k).value = settings.spec[k];
  $('weeks').value = settings.weeks;
  $('start').value = weeklyStart();
  $('start').min = today();
  $('outDate').value = settings.dates.out;
  $('backDate').value = settings.dates.back;
  $('outDate').min = today();
  $('backDate').min = settings.dates.out;
  $('flex').value = settings.dates.flex;
  $('weeklyControls').hidden = settings.mode === 'dates';
  $('datesControls').hidden = settings.mode !== 'dates';
  $('currency').value = settings.currency;
  $('sort').value = settings.sort;
  $('hideEmpty').checked = settings.hideEmpty;
  for (const b of $('presets').children) b.setAttribute('aria-pressed', b.dataset.p === settings.preset);
}

function labelFor(code) {
  const a = airports.find((x) => x.code === code);
  return a ? `${a.name} (${a.code}) — ${a.country}` : code;
}

function setupControls() {
  const dayOpts = [5, 6, 0, 1, 2, 3, 4].map((d) => `<option value="${d}">${DAY_NAMES[d]}</option>`).join('');
  $('startDay').innerHTML = dayOpts;
  $('endDay').innerHTML = dayOpts;
  $('presets').innerHTML = [...Object.entries(PRESETS), ['dates', { label: 'Pick dates' }]].map(([k, p]) => `<button type="button" data-p="${k}">${p.label}</button>`).join(' ');

  $('presets').addEventListener('click', (e) => {
    const p = e.target.closest('button')?.dataset.p;
    if (!p) return;
    settings.preset = p;
    if (p === 'dates') {
      settings.mode = 'dates';
      fixDates();
    } else {
      const { label, ...spec } = PRESETS[p];
      settings.mode = 'weekly';
      settings.spec = spec;
    }
    changed(true);
  });

  // Trip rule edits only re-pair existing data — no refetch.
  const specInput = (e) => {
    const { id, value } = e.target;
    if (id === 'startDay' || id === 'endDay') settings.spec[id] = Number(value);
    else if (id === 'minHours') settings.spec.minHours = Math.max(0, Number(value) || 0);
    else if (value) settings.spec[id] = value;
    settings.preset = Object.keys(PRESETS).find((k) => {
      const { label, ...s } = PRESETS[k];
      return Object.entries(s).every(([kk, v]) => settings.spec[kk] === v);
    }) || null;
    changed();
  };
  for (const id of ['startDay', 'endDay', 'startTime', 'endTime', 'minHours']) $(id).addEventListener('change', specInput);

  $('sort').addEventListener('change', (e) => { settings.sort = e.target.value; changed(); });
  $('hideEmpty').addEventListener('change', (e) => { settings.hideEmpty = e.target.checked; changed(); });
  // These change what we fetch.
  $('weeks').addEventListener('change', (e) => { settings.weeks = Number(e.target.value); changed(true); });
  $('start').addEventListener('change', (e) => { settings.start = ISO.test(e.target.value) ? e.target.value : ''; changed(true); });
  $('outDate').addEventListener('change', (e) => {
    if (!ISO.test(e.target.value)) return;
    const len = Math.round((Date.parse(settings.dates.back) - Date.parse(settings.dates.out)) / 86400000);
    settings.dates.out = e.target.value;
    // Moving the out date keeps the trip length, like most flight searches.
    settings.dates.back = plusDays(e.target.value, Math.max(0, len));
    fixDates();
    changed(true);
  });
  $('backDate').addEventListener('change', (e) => {
    if (!ISO.test(e.target.value)) return;
    settings.dates.back = e.target.value;
    fixDates();
    changed(true);
  });
  $('flex').addEventListener('change', (e) => { settings.dates.flex = Number(e.target.value); changed(true); });
  $('currency').addEventListener('change', (e) => { settings.currency = e.target.value; changed(true); });

  const pickOrigin = () => {
    const v = $('origin').value.trim();
    const code = (v.match(/\(([A-Z]{3})\)/) || [])[1] || (/^[a-z]{3}$/i.test(v) ? v.toUpperCase() : null);
    const known = airports.length ? airports.find((a) => a.code === code) : code && { code };
    if (!known) return;
    if (known.code !== settings.origin) {
      settings.origin = known.code;
      changed(true);
    }
    $('origin').value = labelFor(settings.origin);
    $('origin').blur();
  };
  $('origin').addEventListener('change', pickOrigin);
  $('origin').addEventListener('keydown', (e) => e.key === 'Enter' && pickOrigin());
  $('origin').addEventListener('focus', (e) => e.target.select());

  $('refresh').addEventListener('click', () => {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith('df:v2:fares:') || k.startsWith('df:v2:routes:')).forEach((k) => localStorage.removeItem(k));
    } catch {}
    load();
  });
}

function changed(refetch = false) {
  save();
  syncControls();
  hideTip();
  refetch && fetchKey() !== loadedKey ? load() : render();
}

// ---- boot ----

try { Object.keys(localStorage).filter((k) => k.startsWith('df:v1:')).forEach((k) => localStorage.removeItem(k)); } catch {}

if (settings.mode === 'dates') fixDates();
setupControls();
syncControls();
save();
load();
getAirports()
  .then((list) => {
    airports = list;
    $('airports').innerHTML = list.map((a) => `<option value="${esc(`${a.name} (${a.code}) — ${a.country}`)}"></option>`).join('');
    syncControls();
  })
  .catch(() => {});

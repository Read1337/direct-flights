import { getAirports, getRoutes, getMonth, pool, bookingUrl, BlockedError } from './api.js';
import { DAY_NAMES, PRESETS, windows, bestTrip, operatingDays, quantileBins, isoDate } from './trips.js';

const $ = (id) => document.getElementById(id);
const SYMBOL = { GBP: '£', EUR: '€' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- settings (URL ?from= wins, then saved, then defaults) ----

const DEFAULTS = { origin: 'BOH', currency: 'GBP', weeks: 8, sort: 'price', hideEmpty: false, preset: 'weekend', spec: { ...PRESETS.weekend } };
const settings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('df:settings')) || {}; } catch {}
  const s = { ...DEFAULTS, ...saved, spec: { ...DEFAULTS.spec, ...saved.spec } };
  const from = new URLSearchParams(location.search).get('from');
  if (from && /^[A-Za-z]{3}$/.test(from)) s.origin = from.toUpperCase();
  return s;
})();
const save = () => {
  try { localStorage.setItem('df:settings', JSON.stringify(settings)); } catch {}
  const url = new URL(location);
  url.searchParams.set('from', settings.origin);
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

async function load() {
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
  const from = today();
  const months = monthsCovering(from, plusDays(from, settings.weeks * 7 + 8));
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

  const from = today();
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
  rows.sort(settings.sort === 'name' ? (a, b) => a.r.city.localeCompare(b.r.city) : (a, b) => a.best - b.best || a.r.city.localeCompare(b.r.city));

  const { binOf, edges, min, max } = quantileBins(rows.flatMap((x) => x.cells.filter(Boolean).map((t) => t.total)));
  renderLegend(edges, min, max);

  trips = [];
  const head = `<thead><tr><th scope="col">${rows.length} destination${rows.length === 1 ? '' : 's'}</th>${wins
    .map((w) => `<th scope="col"><span class="wd">${dayOf(w.start)}</span>${dateLabel(w.date)}</th>`)
    .join('')}</tr></thead>`;

  const body = rows
    .map(({ r, cells, loading, days }) => {
      const meta = [r.country, days || (loading ? '' : 'no flights in range')].filter(Boolean).join(' · ');
      const th = `<th scope="row" class="dest"><div class="dw"><span class="city">${flag(r.countryCode)} ${esc(r.city)}</span>${r.recent ? '<span class="badge">NEW</span>' : ''}<span class="meta" title="${esc(meta)}">${esc(meta)}</span></div></th>`;
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

function renderLegend(edges, min, max) {
  if (min === undefined) return ($('legend').innerHTML = '');
  const bounds = [min, ...edges, max];
  const sw = bounds.slice(0, -1).map((lo, i) => {
    const hi = bounds[i + 1];
    return `<span class="sw b${i}">${i === bounds.length - 2 ? `${money(lo)}+` : `${money(lo)}–${money(hi)}`}</span>`;
  });
  $('legend').innerHTML = `<span>Cheapest return in each window, per person</span><span class="swatches">${sw.join('')}</span>`;
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
  $('presets').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button type="button" data-p="${k}">${p.label}</button>`).join(' ');

  $('presets').addEventListener('click', (e) => {
    const p = e.target.closest('button')?.dataset.p;
    if (!p) return;
    const { label, ...spec } = PRESETS[p];
    settings.preset = p;
    settings.spec = spec;
    changed();
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
  refetch ? load() : render();
}

// ---- boot ----

try { Object.keys(localStorage).filter((k) => k.startsWith('df:v1:')).forEach((k) => localStorage.removeItem(k)); } catch {}

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

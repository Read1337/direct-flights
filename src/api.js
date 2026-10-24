// Ryanair's public (undocumented) endpoints. They send Access-Control-Allow-Origin: *,
// so the browser calls them directly — no backend. Be polite: low concurrency and a
// local cache, because hammering them gets an IP blocked.

const AIRPORTS = 'https://www.ryanair.com/api/views/locate/5/airports/en/active';
const ROUTES = (iata) => `https://www.ryanair.com/api/views/locate/searchWidget/routes/en/airport/${iata}`;
const PER_DAY = (o, d, month, cur) =>
  `https://services-api.ryanair.com/farfnd/v4/oneWayFares/${o}/${d}/cheapestPerDay?outboundMonthOfDate=${month}&currency=${cur}`;

const HOUR = 3600000;
const PREFIX = 'df:v2:';

export class BlockedError extends Error {}

function cacheGet(key, maxAge) {
  try {
    const hit = JSON.parse(localStorage.getItem(PREFIX + key));
    return hit && Date.now() - hit.t < maxAge ? hit.v : undefined;
  } catch {
    return undefined;
  }
}

function cacheSet(key, v) {
  const put = () => localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v }));
  try {
    put();
  } catch {
    // Probably over quota: drop cached fares (cheap to refetch) and try once more.
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(`${PREFIX}fares:`)).forEach((k) => localStorage.removeItem(k));
      put();
    } catch {
      /* storage unavailable — run uncached */
    }
  }
}

async function getJSON(url, signal) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (e) {
      if (signal?.aborted || attempt) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (res.status === 403 || res.status === 429) throw new BlockedError(`Ryanair returned ${res.status}`);
    if (res.ok) return res.json();
    if (attempt || res.status < 500) throw new Error(`${res.status} from ${url}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cached(key, maxAge, load) {
  const hit = cacheGet(key, maxAge);
  if (hit !== undefined) return hit;
  const v = await load();
  cacheSet(key, v);
  return v;
}

const place = (a) => ({
  code: a.code,
  name: a.name,
  city: a.city?.name ?? a.name,
  country: a.country?.name ?? '',
  countryCode: a.country?.code ?? '',
});

export const getAirports = (signal) =>
  cached('airports', 7 * 24 * HOUR, async () => (await getJSON(AIRPORTS, signal)).map(place).sort((a, b) => a.name.localeCompare(b.name)));

export const getRoutes = (iata, signal) =>
  cached(`routes:${iata}`, 24 * HOUR, async () =>
    (await getJSON(ROUTES(iata), signal)).map((r) => ({ ...place(r.arrivalAirport), seasonal: r.seasonal, recent: r.recent })),
  );

// One route, one direction, one month → [{ dep, arr, price }] for the days that have a flight.
// Cached as [dep, arr, price] tuples — half the size, so several big airports fit in storage.
export async function getMonth(o, d, month, currency, signal) {
  const rows = await cached(`fares:${o}-${d}:${month}:${currency}`, 6 * HOUR, async () => {
    const data = await getJSON(PER_DAY(o, d, month, currency), signal);
    return data.outbound.fares
      .filter((x) => !x.unavailable && !x.soldOut && x.price && x.departureDate)
      .map((x) => [x.departureDate.slice(0, 16), x.arrivalDate.slice(0, 16), x.price.value]);
  });
  return rows.map(([dep, arr, price]) => ({ dep, arr, price }));
}

// Run async jobs with at most `limit` in flight. Stops early if the signal aborts.
export async function pool(jobs, limit, signal) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) await jobs[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// Opens Ryanair's flight-select page with both dates prefilled.
export function bookingUrl(o, d, outDate, backDate) {
  const q = new URLSearchParams({
    adults: 1, teens: 0, children: 0, infants: 0,
    dateOut: outDate, dateIn: backDate,
    isConnectedFlight: false, isReturn: true, discount: 0, promoCode: '',
    originIata: o, destinationIata: d,
  });
  return `https://www.ryanair.com/gb/en/trip/flights/select?${q}`;
}

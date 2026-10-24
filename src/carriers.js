// Direct routes flown by airlines whose fares we can't read (Jet2, TUI, easyJet sit
// behind bot protection and don't allow cross-site requests). We list them so every
// realistic option shows up, and link out to the airline's own site for prices.
//
// Sources (checked 24 Oct 2026): Jet2's own airport data for BOH (destination list),
// Wikipedia "Bournemouth Airport" (TUI, easyJet, seasonal flags, start dates).
// Schedules change twice a year (late March, late October) — re-check then.

export const CARRIERS = {
  jet2: { name: 'Jet2' },
  tui: { name: 'TUI' },
  easyjet: { name: 'easyJet' },
};

// Jet2 route pages use their own destination names. Only names confirmed to exist are
// listed; anything else links to Jet2's Bournemouth destinations page instead of a guess.
const JET2_KEYS = { CFU: 'corfu', TFS: 'tenerife', PRG: 'prague', LPA: 'gran-canaria', FAO: 'faro', KEF: 'reykjavik', PMI: 'majorca', IBZ: 'ibiza', MAH: 'menorca' };
const JET2_ORIGIN_KEYS = { BOH: 'bournemouth' };

// place: [city, country, countryCode]
const P = {
  ACE: ['Lanzarote', 'Spain', 'es'], AGA: ['Agadir', 'Morocco', 'ma'], ALC: ['Alicante', 'Spain', 'es'],
  AYT: ['Antalya', 'Türkiye', 'tr'], BGO: ['Bergen', 'Norway', 'no'], CDG: ['Paris', 'France', 'fr'],
  CFU: ['Corfu', 'Greece', 'gr'], DLM: ['Dalaman', 'Türkiye', 'tr'], EFL: ['Kefalonia', 'Greece', 'gr'],
  FAO: ['Faro', 'Portugal', 'pt'], FNC: ['Madeira', 'Portugal', 'pt'], FUE: ['Fuerteventura', 'Spain', 'es'],
  GVA: ['Geneva', 'Switzerland', 'ch'], HER: ['Crete (Heraklion)', 'Greece', 'gr'], IBZ: ['Ibiza', 'Spain', 'es'],
  JER: ['Jersey', 'Jersey', 'je'], KEF: ['Reykjavik', 'Iceland', 'is'], KGS: ['Kos', 'Greece', 'gr'],
  LPA: ['Gran Canaria', 'Spain', 'es'], MAH: ['Menorca', 'Spain', 'es'], PFO: ['Paphos', 'Cyprus', 'cy'],
  PMI: ['Palma', 'Spain', 'es'], PRG: ['Prague', 'Czechia', 'cz'], REU: ['Reus', 'Spain', 'es'],
  RHO: ['Rhodes', 'Greece', 'gr'], TFS: ['Tenerife', 'Spain', 'es'], VIE: ['Vienna', 'Austria', 'at'],
  VRN: ['Verona', 'Italy', 'it'], ZTH: ['Zante', 'Greece', 'gr'],
};

// code → { seasonal, starts? (YYYY-MM, route not flying yet) }
const ROUTES = {
  BOH: {
    jet2: {
      FUE: {}, FNC: {}, LPA: {}, ACE: {}, TFS: {},
      AGA: { seasonal: true }, ALC: { seasonal: true }, AYT: { seasonal: true }, BGO: { seasonal: true },
      CFU: { seasonal: true }, DLM: { seasonal: true }, FAO: { seasonal: true }, HER: { seasonal: true },
      IBZ: { seasonal: true }, KEF: { seasonal: true }, KGS: { seasonal: true }, MAH: { seasonal: true },
      PMI: { seasonal: true }, PRG: { seasonal: true }, RHO: { seasonal: true }, VIE: { seasonal: true },
      ZTH: { seasonal: true },
      CDG: { seasonal: true, starts: '2027-04' }, JER: { seasonal: true, starts: '2027-04' },
      REU: { seasonal: true, starts: '2027-05' }, VRN: { seasonal: true, starts: '2027-04' },
    },
    tui: {
      ACE: {}, TFS: {},
      AYT: { seasonal: true }, CFU: { seasonal: true }, DLM: { seasonal: true }, EFL: { seasonal: true },
      HER: { seasonal: true }, IBZ: { seasonal: true }, KGS: { seasonal: true }, LPA: { seasonal: true },
      MAH: { seasonal: true }, PFO: { seasonal: true }, PMI: { seasonal: true }, RHO: { seasonal: true },
      ZTH: { seasonal: true },
    },
    easyjet: { GVA: { seasonal: true } },
  },
};

// Other airlines' destinations from an origin: [{ code, city, country, countryCode, carriers: [{ id, seasonal, starts }] }]
export function otherRoutes(origin) {
  const byCode = new Map();
  for (const [id, dests] of Object.entries(ROUTES[origin] || {})) {
    for (const [code, info] of Object.entries(dests)) {
      if (!byCode.has(code)) {
        const [city, country, countryCode] = P[code];
        byCode.set(code, { code, city, country, countryCode, carriers: [] });
      }
      byCode.get(code).carriers.push({ id, ...info });
    }
  }
  return [...byCode.values()];
}

// Where to see this airline's fares for a route; dates prefilled when the link format supports it.
export function carrierUrl(id, origin, dest, out, back) {
  if (id === 'jet2') {
    const from = JET2_ORIGIN_KEYS[origin];
    const to = JET2_KEYS[dest];
    if (!from || !to) return `https://www.jet2.com/en/destinations/${from || 'bournemouth'}-destinations-map`;
    const q = out ? `?${new URLSearchParams({ from: out, to: back, adults: 1, children: '', infants: 0, preselect: true, searchType: 4 })}` : '';
    return `https://www.jet2.com/en/cheap-flights/${from}/${to}${q}`;
  }
  if (id === 'easyjet') {
    const q = new URLSearchParams({ lang: 'EN', dep: origin, dest, apax: 1, cpax: 0, ipax: 0 });
    if (out) { q.set('dd', out); q.set('rd', back); }
    return `https://www.easyjet.com/deeplink?${q}`;
  }
  return 'https://www.tui.co.uk/flight/';
}

# Direct Flights

Every direct flight from one airport, as a grid of destinations × weekends, showing the cheapest return that fits your free time. For quick trips from your *local* airport.

No backend: the page calls Ryanair's public fare endpoints straight from the browser (they allow cross-origin requests) and caches responses in `localStorage` for 6 hours.

```
npm run serve   # http://localhost:8642/?from=BOH
npm test        # trip-pairing logic
```

## How it works

- `src/api.js` — Ryanair airports, routes, and `cheapestPerDay` fares (one route, one direction, one month per request), 4 requests at a time.
- `src/trips.js` — pure logic: weekly trip windows ("leave Fri after 17:00, back Sun by 23:59"), cheapest out+back pair per window with a minimum time at the destination.
- `src/app.js` — controls, grid, tooltip. Settings persist locally; `?from=XXX` picks the airport.

Times are local at each airport, which is what the rules need: departures are checked against home time, the return's arrival against home time, and time-at-destination subtracts two destination-local times.

## Known limits

- Ryanair only. Jet2/TUI/easyJet not yet (Jet2 is the big gap for Bournemouth).
- `cheapestPerDay` gives the cheapest flight per day, so on routes with several daily flights a later, pricier flight that fits your times can be missed.
- Prices are base fares per person, no bags or seats.
- The endpoints are unofficial and could change or start rate-limiting.

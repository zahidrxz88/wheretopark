# Wheretopark

Singapore parking finder that ranks nearby carparks **cheapest-first**, using
official HDB parking rates plus a small curated list of private carpark rates.

## What's real vs. estimated

- **HDB/URA public carparks**: exact locations from the official
  [data.gov.sg HDB Carpark Information dataset](https://data.gov.sg/datasets/d_23f946fa557947f93a8043bbef41dd09/view),
  priced using HDB's **standardized, published rates**:
  $0.60/half-hour outside the Central Area, $1.20/half-hour inside it,
  capped at $12 (non-central) or $20 (central) per day, $5 overnight, free on
  Sundays & Public Holidays 7am-10:30pm. These numbers are confirmed, not scraped.
- **Private carparks** (malls, Wilson Parking, etc.): there's no free public
  API for these. We ship a small hand-curated list
  (`data/private-carparks.json`) with rates found from public reviews/rate
  cards. Anything not in that list won't show up — it's not comprehensive.
- **"Central Area" detection** is approximated with a rough polygon
  (`lib/rates.js`) based on the searched address, then applied to all nearby
  HDB carparks. It's a reasonable approximation, not the legally exact
  gazetted boundary — always sanity-check right at the boundary.

## How to deploy (free, ~5 minutes)

1. **Create a free Vercel account** at [vercel.com](https://vercel.com) (you
   can sign up with your GitHub account).
2. **Push this folder to a GitHub repo** (a new one, or reuse your
   `wheretopark` repo — replace its contents with these files).
3. In Vercel, click **Add New → Project**, then **Import** your GitHub repo.
4. Leave all settings as default (Vercel auto-detects the `/api` folder as
   serverless functions and `/public` as the static site) → click **Deploy**.
5. Done — Vercel gives you a URL like `https://wheretopark.vercel.app`.

No environment variables or API keys are required to start. If you later hit
rate limits on OneMap's search API, you can register a free account at
[onemap.gov.sg](https://www.onemap.gov.sg/apidocs/) and add a token.

To enable the **EV charging toggle** and **live available-lot counts**,
register a free account key at
[datamall.lta.gov.sg](https://datamall.lta.gov.sg/) and add it as the
`LTA_ACCOUNT_KEY` environment variable in your Vercel project settings (see
`.env.example`). Without it, both features stay fully functional in the UI
but always return zero carparks / no lot count rather than guessing.

Coverage is nationwide for **HDB carparks** (EV charging matched by location,
live lots matched by exact carpark ID) - it's only the small curated list of
**private/mall carparks** (see `data/private-carparks*.json`) where EV/lots
are a best-effort proximity guess, and actual $ pricing is limited to that
same curated list (there's no free live rate feed for private operators).

## Local development

```
npm install -g vercel
vercel dev
```

Then open `http://localhost:3000`.

## Files

- `public/index.html` — the frontend (search box, results list)
- `api/carparks.js` — serverless function: geocode → find nearest HDB
  carparks → price them → merge in curated private carparks → rank
- `lib/rates.js` — HDB rate calculator + Central Area approximation
- `data/private-carparks.json` — curated private carpark rates (edit this
  file to add more as you research them)

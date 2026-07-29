// api/carparks.js
// Vercel serverless function: GET /api/carparks?address=...&time=ISO8601
//
// Pipeline:
//  1. Geocode the address via OneMap's free search API (Singapore government).
//  2. Fetch HDB's official carpark location dataset (data.gov.sg) and find the
//     nearest ones using SVY21 (metric, easting/northing) coordinates - no
//     extra coordinate-conversion calls needed since both the geocoded address
//     and the HDB dataset already come with SVY21 X/Y.
//  3. Apply HDB's official, standardized short-term parking rates to those
//     carparks - this part is exact, not scraped or guessed.
//  4. Merge in a small curated list of nearby private carparks (mall /
//     commercial operators) where we have researched real rates - these are
//     labelled with a confidence level since there's no free live API for them.
//  5. Rank everything cheapest-first, confirmed-rates before estimates.
//
// HONEST LIMITATIONS (please read):
//  - "Central Area" (which doubles the HDB rate) is approximated using the
//    searched address's location, applied to all nearby HDB carparks. This is
//    a reasonable simplification for carparks within ~1-2km of each other, but
//    can be wrong very close to the Central Area boundary.
//  - Private carpark rates are only as good as our curated list. Anything not
//    in that list shows as "unconfirmed - check on arrival."
//  - OneMap's search API is free for basic use, but Singapore's government may
//    require you to register a free API token if you hit higher volumes -
//    see https://www.onemap.gov.sg/apidocs/ if you get consistent auth errors.

const HDB_DATASET_ID = "d_23f946fa557947f93a8043bbef41dd09";
const { estimateHdbCost, isCentralArea } = require("../lib/rates");
const privateCarparks = require("../data/private-carparks.json");

let hdbCache = null;
let hdbCacheTime = 0;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour - carpark locations rarely change

async function fetchHdbCarparks() {
  const now = Date.now();
  if (hdbCache && now - hdbCacheTime < CACHE_TTL_MS) return hdbCache;

  const url = `https://data.gov.sg/api/action/datastore_search?resource_id=${HDB_DATASET_ID}&limit=3000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HDB dataset fetch failed: ${res.status}`);
  const json = await res.json();
  const records = json?.result?.records || [];
  hdbCache = records;
  hdbCacheTime = now;
  return records;
}

async function geocodeAddress(address) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
    address
  )}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OneMap search failed: ${res.status}`);
  const json = await res.json();
  const first = json?.results?.[0];
  if (!first) return null;
  return {
    address: first.ADDRESS || address,
    x: parseFloat(first.X),
    y: parseFloat(first.Y),
    lat: parseFloat(first.LATITUDE),
    lon: parseFloat(first.LONGITUDE),
  };
}

function svy21Distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1); // metres, SVY21 is a metric projection
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const address = (req.query.address || "").trim();
    if (!address) {
      res.status(400).json({ error: "Missing ?address= parameter" });
      return;
    }

    const timeParam = req.query.time ? new Date(req.query.time) : new Date();
    const dayOfWeek = timeParam.getDay(); // 0 = Sunday
    const hour = timeParam.getHours();

    const geocoded = await geocodeAddress(address);
    if (!geocoded) {
      res.status(404).json({ error: "Could not find that address. Try a more specific address or postal code." });
      return;
    }

    // --- HDB public carparks (exact official rates) ---
    const hdbRecords = await fetchHdbCarparks();
    const central = isCentralArea(geocoded.lat, geocoded.lon); // approximation, see notes above

    const hdbResults = hdbRecords
      .map((r) => {
        const x = parseFloat(r.x_coord);
        const y = parseFloat(r.y_coord);
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        const distanceM = svy21Distance(geocoded.x, geocoded.y, x, y);
        return {
          name: r.address || r.car_park_no,
          type: "HDB / public",
          distanceM: Math.round(distanceM),
          carParkNo: r.car_park_no,
          freeParking: r.free_parking,
          nightParking: r.night_parking,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 8)
      .map((c) => {
        const cost = estimateHdbCost(geocoded.lat, geocoded.lon, {
          durationHours: 9,
          dayOfWeek,
        });
        return {
          ...c,
          estimatedCost: cost.estimatedCost,
          rateLabel: cost.rateLabel,
          confidence: cost.confidence,
        };
      });

    // --- Curated private carparks nearby (estimate / unconfirmed) ---
    const privateResults = privateCarparks
      .map((p) => {
        const distanceM = haversineMeters(geocoded.lat, geocoded.lon, p.lat, p.lng);
        return { ...p, type: "Private / mall", distanceM: Math.round(distanceM) };
      })
      .filter((p) => p.distanceM <= 3000)
      .map((p) => ({
        name: p.name,
        type: p.type,
        distanceM: p.distanceM,
        estimatedCost: p.estimatedDayCost,
        rateLabel: p.notes,
        confidence: p.confidence,
      }));

    // --- Combine & rank: confirmed/estimate costs first (cheapest first), unconfirmed last ---
    const all = [...hdbResults, ...privateResults];
    const ranked = all.sort((a, b) => {
      const aHas = typeof a.estimatedCost === "number";
      const bHas = typeof b.estimatedCost === "number";
      if (aHas && bHas) return a.estimatedCost - b.estimatedCost || a.distanceM - b.distanceM;
      if (aHas) return -1;
      if (bHas) return 1;
      return a.distanceM - b.distanceM;
    });

    res.status(200).json({
      query: { address: geocoded.address, lat: geocoded.lat, lon: geocoded.lon },
      context: {
        dayOfWeek,
        hour,
        assumedCentralArea: central,
        note:
          "Central Area status is approximated from the searched address and applied to nearby HDB carparks. Private carpark rates come from a small curated list, not a live feed.",
      },
      results: ranked,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

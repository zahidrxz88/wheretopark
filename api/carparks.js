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
const {
  estimateHdbCost,
  isCentralArea,
  estimatePrivateCost,
  estimateHdbMotorcycleCost,
  estimateLtaCarparkCost,
} = require("../lib/rates");
const privateCarparks = require("../data/private-carparks.json");
const ltaCarparks = require("../data/private-carparks-lta.json");

const SEARCH_RADIUS_M = 1000; // 1km, as requested
const POSTAL_CODE_REGEX = /^\d{6}$/;

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

async function geocodePostalCode(postalCode) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(
    postalCode
  )}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OneMap search failed: ${res.status}`);
  const json = await res.json();
  const first = json?.results?.[0];
  if (!first) return null;
  return {
    address: first.ADDRESS || postalCode,
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
    const postalCode = (req.query.address || "").trim();

    if (!postalCode) {
      res.status(400).json({ error: "Missing ?address= parameter" });
      return;
    }
    if (!POSTAL_CODE_REGEX.test(postalCode)) {
      res.status(400).json({
        error: "Please enter a valid 6-digit Singapore postal code (e.g. 238164).",
      });
      return;
    }

    const vehicleType = req.query.vehicleType === "motorcycle" ? "motorcycle" : "car";
    const evOnly = req.query.evOnly === "true";

    const timeParam = req.query.time ? new Date(req.query.time) : new Date();
    const dayOfWeek = timeParam.getDay(); // 0 = Sunday
    const hour = timeParam.getHours();

    const durationHours = req.query.hours ? parseFloat(req.query.hours) : 9;
    const safeDuration = Number.isFinite(durationHours) && durationHours > 0 ? durationHours : 9;

    const startMin = req.query.startMin != null ? parseInt(req.query.startMin, 10) : null;
    const endMin = req.query.endMin != null ? parseInt(req.query.endMin, 10) : null;

    const geocoded = await geocodePostalCode(postalCode);
    if (!geocoded) {
      res.status(404).json({
        error: `Postal code "${postalCode}" not found. Please check it and try again.`,
      });
      return;
    }

    // --- HDB public carparks within 1km (exact official rates) ---
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
      .filter((c) => c.distanceM <= SEARCH_RADIUS_M)
      .sort((a, b) => a.distanceM - b.distanceM)
      .map((c) => {
        if (vehicleType === "motorcycle") {
          const cost = estimateHdbMotorcycleCost({ startMin, endMin, dayOfWeek });
          return {
            ...c,
            estimatedCost: cost.estimatedCost,
            rateLabel: cost.rateLabel,
            confidence: cost.confidence,
            ev: false, // EV charging info isn't in the HDB carpark dataset
          };
        }
        const cost = estimateHdbCost(geocoded.lat, geocoded.lon, {
          durationHours: safeDuration,
          dayOfWeek,
        });
        return {
          ...c,
          estimatedCost: cost.estimatedCost,
          rateLabel: cost.rateLabel,
          confidence: cost.confidence,
          ev: false, // EV charging info isn't in the HDB carpark dataset
        };
      });

    // --- Curated private carparks within 1km (car only - we don't have
    // researched motorcycle rates for these, so they're skipped for
    // motorcycle searches rather than showing a wrong number) ---
    let privateResults = [];
    if (vehicleType === "car") {
      const handCurated = privateCarparks
        .map((p) => {
          const distanceM = haversineMeters(geocoded.lat, geocoded.lon, p.lat, p.lng);
          return { ...p, type: "Private / mall", distanceM: Math.round(distanceM) };
        })
        .filter((p) => p.distanceM <= SEARCH_RADIUS_M)
        .map((p) => {
          const { cost, confidence } = estimatePrivateCost(p, safeDuration);
          return {
            name: p.name,
            type: p.type,
            distanceM: p.distanceM,
            estimatedCost: cost,
            rateLabel: p.notes,
            confidence,
            ev: !!p.ev, // not yet populated in data/private-carparks.json
          };
        });

      const ltaSourced = ltaCarparks
        .map((c) => {
          const distanceM = haversineMeters(geocoded.lat, geocoded.lon, c.lat, c.lng);
          return { ...c, type: "Private / mall (LTA)", distanceM: Math.round(distanceM) };
        })
        .filter((c) => c.distanceM <= SEARCH_RADIUS_M)
        .map((c) => {
          const { cost, confidence, rateLabel } = estimateLtaCarparkCost(c, safeDuration, startMin);
          return {
            name: c.name,
            type: c.type,
            distanceM: c.distanceM,
            estimatedCost: cost,
            rateLabel: rateLabel,
            confidence,
            ev: !!c.ev, // not yet populated in data/private-carparks-lta.json
          };
        });

      privateResults = [...handCurated, ...ltaSourced];
    }

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

    // EV filter: no carpark in our current data sources is confirmed to have
    // EV charging yet, so this is wired up but returns an empty list for now
    // (see `ev` field notes above) rather than guessing.
    const finalResults = evOnly ? ranked.filter((c) => c.ev === true) : ranked;

    res.status(200).json({
      query: { address: geocoded.address, lat: geocoded.lat, lon: geocoded.lon },
      context: {
        dayOfWeek,
        hour,
        durationHours: safeDuration,
        vehicleType,
        evOnly,
        radiusM: SEARCH_RADIUS_M,
        assumedCentralArea: central,
        note:
          "Central Area status is approximated from the searched address and applied to nearby HDB carparks. Private carpark rates come from a small curated list, not a live feed. Motorcycle results only include HDB/URA carparks - private carpark motorcycle rates aren't in our data yet." +
          (evOnly
            ? " EV charging availability isn't in any of our data sources yet, so the EV filter currently returns no carparks - this is a placeholder pending real charging-point data."
            : ""),
      },
      results: finalResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error" });
  }
};

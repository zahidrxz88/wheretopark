// lib/carparkAvailability.js
//
// Optional integration with LTA DataMall's "Carpark Availability" API -
// live available-lot counts, refreshed roughly every minute, for HDB/LTA/URA
// carparks nationwide. Uses the same LTA_ACCOUNT_KEY env var as the EV
// charging integration (see lib/evCharging.js) - without it configured, this
// module is a no-op and no carpark shows a lot count (honest, same as
// before this integration existed).
//
// HDB carparks are matched exactly by CarParkID === the HDB dataset's
// car_park_no (same numbering scheme, both ultimately from HDB) - reliable,
// nationwide. Curated private/mall carparks don't have an LTA carpark ID at
// all, so those are matched by proximity instead (see LOTS_MATCH_RADIUS_M in
// api/carparks.js) - coverage there is partial, limited to whatever's in
// this app's small curated list, not comprehensive.
//
// Expected response shape (per LTA's long-standing public documentation -
// NOT independently verified live from this codebase's dev environment, so
// this still logs one raw sample the first time a response comes back, in
// case the real shape differs like EVChargingPoints did):
//   { "value": [
//       { "CarParkID": "...", "Area": "...", "Development": "...",
//         "Location": "1.234 103.456", "AvailableLots": 42,
//         "LotType": "C", "Agency": "HDB" },
//       ...
//   ] }
// Only entries with LotType "C" (car) are used for matching car searches.
//
// NOTE: the endpoint is "CarParkAvailabilityv2" - the older
// "CarParkAvailability" (no v2 suffix) 404s as of 2026-08-04, confirmed
// live in production. LTA appears to have retired/renamed it since this
// integration was first written.

const CARPARK_AVAILABILITY_URL = "https://datamall2.mytransport.sg/ltaodataservice/CarParkAvailabilityv2";
const PAGE_SIZE = 500; // LTA paginates this endpoint in blocks of 500 via $skip
const MAX_PAGES = 10; // safety cap (~5000 records) so a pagination bug can't loop forever

let cache = null;
let cacheTime = 0;
let loggedSample = false;
const CACHE_TTL_MS = 1000 * 60 * 2; // 2 min - lot counts change frequently

function parseRecord(record) {
  let lat = [record.Latitude, record.latitude, record.lat].find((v) => v != null);
  let lon = [record.Longitude, record.longitude, record.lon, record.lng].find((v) => v != null);

  if ((lat == null || lon == null) && typeof record.Location === "string") {
    const parts = record.Location.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    if (parts.length >= 2) [lat, lon] = parts;
  }

  lat = parseFloat(lat);
  lon = parseFloat(lon);
  const availableLots = parseInt(record.AvailableLots, 10);
  const lotType = record.LotType || record.lotType;

  if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(availableLots)) return null;
  return {
    lat,
    lon,
    availableLots,
    lotType,
    carParkId: record.CarParkID || record.carParkId || null,
    agency: record.Agency || record.agency || null,
    development: record.Development || record.development || null,
  };
}

async function fetchCarParkAvailability() {
  const accountKey = process.env.LTA_ACCOUNT_KEY;
  if (!accountKey) return [];

  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

  try {
    const allRecords = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${CARPARK_AVAILABILITY_URL}?$skip=${page * PAGE_SIZE}`;
      const res = await fetch(url, {
        headers: { AccountKey: accountKey, accept: "application/json" },
      });
      if (!res.ok) {
        console.warn(`LTA CarParkAvailability fetch failed: HTTP ${res.status} (page ${page})`);
        break;
      }
      const json = await res.json();
      let records = json?.value ?? json?.Value ?? json?.results ?? json?.Results ?? (Array.isArray(json) ? json : null);

      if (!Array.isArray(records)) {
        if (!loggedSample) {
          loggedSample = true;
          console.warn(
            "LTA CarParkAvailability: response shape not recognized, raw JSON (first 800 chars):",
            JSON.stringify(json).slice(0, 800)
          );
        }
        break;
      }

      if (!loggedSample && records.length > 0) {
        loggedSample = true;
        console.warn(
          "LTA CarParkAvailability sample record (verify field names in lib/carparkAvailability.js match this):",
          JSON.stringify(records[0])
        );
      }

      allRecords.push(...records);
      if (records.length < PAGE_SIZE) break; // last page
    }

    const points = allRecords.map(parseRecord).filter(Boolean).filter((p) => p.lotType === "C");
    cache = points;
    cacheTime = now;
    return points;
  } catch (err) {
    console.warn("LTA CarParkAvailability fetch error:", err.message);
    return [];
  }
}

module.exports = { fetchCarParkAvailability };

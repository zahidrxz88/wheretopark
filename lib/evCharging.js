// lib/evCharging.js
//
// Optional integration with LTA DataMall's "Electric Vehicle Charging
// Points" API. Requires a free LTA DataMall account key, set as the
// LTA_ACCOUNT_KEY environment variable (see README) - never commit this key
// to the repo. Without it configured, this module is a no-op and every
// carpark's `ev` flag stays false, same as before this integration existed.
//
// Fetches the FULL nationwide dataset (PostalCode filter omitted, paginated
// via $skip like lib/carparkAvailability.js) rather than querying by the
// searched postal code. A real-world test found a charger ~150m from a
// search address that never showed up when queried by that address's own
// postal code - most likely because LTA's PostalCode filter matches only
// that exact postal code's own registration, not a "nearby" radius, which
// would silently miss chargers registered under a neighbouring building's
// postal code. Fetching everything and doing our own proximity matching
// (same pattern already used for CarParkAvailability) removes that
// uncertainty entirely.
//
// Real response shape (confirmed via production logs, 2026-08-01, when this
// endpoint was still called with ?PostalCode=...):
//   { "value": { "evLocationsData": [
//       { "address": "...", "name": "...", "latitude": 1.303705,
//         "longitude": 103.833206, "locationId": "...", "status": "",
//         "chargingPoints": [ { "operator": "...", "plugTypes": [...] } ] },
//       ...
//   ] } }
// NOT independently verified without the PostalCode filter - if the shape
// differs when fetching everything, the diagnostic logging below will show
// the real one so this can be corrected quickly. Only latitude/longitude per
// location are used here for proximity matching - chargingPoints/plugTypes
// detail (operator, price, plug type) isn't surfaced yet.

const EV_CHARGING_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVChargingPoints";
const PAGE_SIZE = 500; // matches the pagination block size LTA DataMall uses elsewhere (e.g. CarParkAvailability)
const MAX_PAGES = 20; // safety cap (~10000 records) so a pagination bug can't loop forever

let evCache = null;
let evCacheTime = 0;
let loggedSample = false;
const EV_CACHE_TTL_MS = 1000 * 60 * 5; // 5 min - LTA refreshes availability roughly this often

function parseLatLon(record) {
  let lat = [record.Latitude, record.latitude, record.lat].find((v) => v != null);
  let lon = [record.Longitude, record.longitude, record.lon, record.lng].find((v) => v != null);

  // Several other LTA DataMall endpoints (e.g. Taxi-Availability) pack
  // coordinates into a single "Location" string like "1.234 103.456" or
  // "1.234,103.456" instead of separate fields - fall back to that shape.
  if ((lat == null || lon == null) && typeof record.Location === "string") {
    const parts = record.Location.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n));
    if (parts.length >= 2) [lat, lon] = parts;
  }

  lat = parseFloat(lat);
  lon = parseFloat(lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

async function fetchEvChargingPoints() {
  const accountKey = process.env.LTA_ACCOUNT_KEY;
  if (!accountKey) return [];

  const now = Date.now();
  if (evCache && now - evCacheTime < EV_CACHE_TTL_MS) return evCache;

  try {
    const allRecords = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = `${EV_CHARGING_URL}?$skip=${page * PAGE_SIZE}`;
      const res = await fetch(url, {
        headers: { AccountKey: accountKey, accept: "application/json" },
      });
      if (!res.ok) {
        console.warn(`LTA EVChargingPoints fetch failed: HTTP ${res.status} (page ${page})`);
        break;
      }
      const json = await res.json();
      let records =
        json?.value?.evLocationsData ??
        json?.value ??
        json?.Value ??
        json?.results ??
        json?.Results ??
        json?.d?.results ??
        (Array.isArray(json) ? json : null);

      if (!Array.isArray(records)) {
        if (!loggedSample) {
          loggedSample = true;
          console.warn(
            "LTA EVChargingPoints: response shape not recognized, raw JSON (first 800 chars):",
            JSON.stringify(json).slice(0, 800)
          );
        }
        break;
      }

      if (!loggedSample) {
        loggedSample = true;
        console.warn(
          records.length > 0
            ? `LTA EVChargingPoints sample record (verify field names in lib/evCharging.js match this): ${JSON.stringify(records[0])}`
            : "LTA EVChargingPoints: request succeeded but returned zero records on the first page."
        );
      }

      allRecords.push(...records);
      if (records.length < PAGE_SIZE) break; // last page
    }

    const points = allRecords.map(parseLatLon).filter(Boolean);
    console.warn(`LTA EVChargingPoints: loaded ${points.length} charging locations nationwide.`);
    evCache = points;
    evCacheTime = now;
    return points;
  } catch (err) {
    console.warn("LTA EVChargingPoints fetch error:", err.message);
    return [];
  }
}

module.exports = { fetchEvChargingPoints };

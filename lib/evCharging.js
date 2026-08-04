// lib/evCharging.js
//
// Optional integration with LTA DataMall's "Electric Vehicle Charging
// Points" API. Requires a free LTA DataMall account key, set as the
// LTA_ACCOUNT_KEY environment variable (see README) - never commit this key
// to the repo. Without it configured, this module is a no-op and every
// carpark's `ev` flag stays false, same as before this integration existed.
//
// Queried by PostalCode (confirmed required - a parameterless/paginated
// "fetch everything" attempt got HTTP 400 in production on 2026-08-04, so
// that's not an option for this endpoint the way it is for
// CarParkAvailability). This means coverage is limited to whatever radius
// LTA's own PostalCode matching uses internally, which isn't documented -
// a real charging point a short walk from a searched address, but
// registered under a different postal code, may not come back. That's an
// LTA API limitation we can't currently work around, not a bug in the
// matching logic below.
//
// Real response shape (confirmed via production logs, 2026-08-01):
//   { "value": { "evLocationsData": [
//       { "address": "...", "name": "...", "latitude": 1.303705,
//         "longitude": 103.833206, "locationId": "...", "status": "",
//         "chargingPoints": [ { "operator": "...", "plugTypes": [...] } ] },
//       ...
//   ] } }
// Only latitude/longitude per location are used here for proximity
// matching - chargingPoints/plugTypes detail (operator, price, plug type)
// isn't surfaced yet.

const EV_CHARGING_URL = "https://datamall2.mytransport.sg/ltaodataservice/EVChargingPoints";

let evCache = null;
let evCacheTime = 0;
let evCacheKey = null;
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

async function fetchEvChargingPoints(postalCode) {
  const accountKey = process.env.LTA_ACCOUNT_KEY;
  if (!accountKey) return [];

  const now = Date.now();
  if (evCache && evCacheKey === postalCode && now - evCacheTime < EV_CACHE_TTL_MS) {
    return evCache;
  }

  try {
    const url = `${EV_CHARGING_URL}?PostalCode=${encodeURIComponent(postalCode)}`;
    const res = await fetch(url, {
      headers: { AccountKey: accountKey, accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`LTA EVChargingPoints fetch failed: HTTP ${res.status}`);
      return [];
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
      records = [];
    } else if (!loggedSample) {
      loggedSample = true;
      console.warn(
        records.length > 0
          ? `LTA EVChargingPoints sample record (verify field names in lib/evCharging.js match this): ${JSON.stringify(records[0])}`
          : `LTA EVChargingPoints: request succeeded but returned zero records for postal code ${postalCode}.`
      );
    }

    const points = records.map(parseLatLon).filter(Boolean);
    evCache = points;
    evCacheTime = now;
    evCacheKey = postalCode;
    return points;
  } catch (err) {
    console.warn("LTA EVChargingPoints fetch error:", err.message);
    return [];
  }
}

module.exports = { fetchEvChargingPoints };

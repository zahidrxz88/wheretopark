// lib/evCharging.js
//
// Optional integration with LTA DataMall's "Electric Vehicle Charging
// Points" API. Requires a free LTA DataMall account key, set as the
// LTA_ACCOUNT_KEY environment variable (see README) - never commit this key
// to the repo. Without it configured, this module is a no-op and every
// carpark's `ev` flag stays false, same as before this integration existed.
//
// HONEST LIMITATION: LTA's exact JSON field names for this endpoint could
// not be verified from the environment this was written in (network policy
// blocked reaching datamall2.mytransport.sg to inspect a live response, and
// public mirrors of the API docs were also unreachable). Parsing below tries
// the field-name conventions LTA uses on its other DataMall endpoints
// defensively, and logs one sample raw record the first time a real response
// comes back so field names can be corrected quickly if the guess is wrong -
// check the Vercel function logs after deploying with a real account key.

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
    const records = json?.value || json?.results || [];

    if (!loggedSample && records.length > 0) {
      loggedSample = true;
      console.warn(
        "LTA EVChargingPoints sample record (verify field names in lib/evCharging.js match this):",
        JSON.stringify(records[0])
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

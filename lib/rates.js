// lib/rates.js
//
// HDB short-term parking rates, confirmed current as of 2026:
//   Non-Central Area: $0.60 / half-hour, day cap (7am-10:30pm) $12, night cap (10:30pm-7am) $5
//   Central Area:     $1.20 / half-hour, day cap (7am-10:30pm) $20, night cap (10:30pm-7am) $5
//   Free on Sundays & Public Holidays, 7am-10:30pm (HDB Free Parking Scheme)
//
// Source: HDB "Short-Term Parking Charges" (hdb.gov.sg/car-parks/shortterm-parking)
//
// IMPORTANT HONEST LIMITATION:
// "Central Area" is a specific URA/HDB gazetted boundary (Downtown Core, Marina,
// Orchard, River Valley, Museum, Rochor, Outram, Singapore River, Straits View,
// part of Novena/Newton). We approximate it below with a bounding polygon since
// there's no free public API that returns "is this point in the Central Area"
// directly. This is a reasonable approximation for ranking purposes, not a
// legally authoritative boundary - always confirm the actual signboard rate
// on arrival.

// Rough Central Area polygon (lat, lon) - approximates the CBD/Orchard/Marina/
// River Valley/Museum/Rochor/Outram belt.
const CENTRAL_AREA_POLYGON = [
  [1.3010, 103.8245], // Orchard (Somerset area)
  [1.3120, 103.8300], // Newton fringe
  [1.3175, 103.8455], // Novena fringe
  [1.3105, 103.8620], // Kallang fringe
  [1.2995, 103.8640], // Nicoll Highway
  [1.2820, 103.8620], // Marina East
  [1.2720, 103.8555], // Marina South
  [1.2705, 103.8420], // Keppel/Telok Blangah fringe
  [1.2755, 103.8280], // Outram
  [1.2870, 103.8230], // Chinatown/Havelock
  [1.2960, 103.8230], // River Valley
];

function isPointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    const intersect =
      lonI > lon !== lonJ > lon &&
      lat < ((latJ - latI) * (lon - lonI)) / (lonJ - lonI) + latI;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isCentralArea(lat, lon) {
  if (lat == null || lon == null) return false;
  return isPointInPolygon(lat, lon, CENTRAL_AREA_POLYGON);
}

// Estimate cost for a typical business-hours parking session at an HDB carpark.
// durationHours: how long the car will be parked (default assumes a full
// business-hours workday, ~9 hours, since the user parks for work).
function estimateHdbCost(lat, lon, { durationHours = 9, dayOfWeek, isPublicHoliday = false } = {}) {
  const central = isCentralArea(lat, lon);
  const isSunday = dayOfWeek === 0;

  if (isSunday || isPublicHoliday) {
    return {
      central,
      estimatedCost: 0,
      rateLabel: "Free (Sunday/Public Holiday, 7am-10:30pm)",
      confidence: "confirmed",
    };
  }

  const halfHourRate = central ? 1.2 : 0.6;
  const dayCap = central ? 20 : 12;
  const raw = durationHours * 2 * halfHourRate;
  const cost = Math.min(raw, dayCap);

  return {
    central,
    estimatedCost: Math.round(cost * 100) / 100,
    rateLabel: `${central ? "Central Area" : "Non-Central"}: $${halfHourRate.toFixed(
      2
    )}/half-hr, capped $${dayCap}/day (7am-10:30pm)`,
    confidence: "confirmed", // HDB rates are standardized, not scraped/guessed
  };
}

// Estimate cost for a private carpark given its rate model and a duration.
function estimatePrivateCost(carpark, durationHours) {
  const { rateModel } = carpark;

  if (rateModel === "flatEntry") {
    return { cost: carpark.flatCost, confidence: carpark.confidence };
  }

  if (rateModel === "hourly") {
    const { firstHourRate, extraHalfHourRate } = carpark;
    const extraHalfHours = Math.max(0, Math.ceil((durationHours - 1) * 2));
    const cost = firstHourRate + extraHalfHours * extraHalfHourRate;
    return { cost: Math.round(cost * 100) / 100, confidence: carpark.confidence };
  }

  if (rateModel === "perMinuteBlock") {
    const { blockMinutes, blockRate } = carpark;
    const totalMinutes = durationHours * 60;
    const blocks = Math.ceil(totalMinutes / blockMinutes);
    const cost = blocks * blockRate;
    return { cost: Math.round(cost * 100) / 100, confidence: carpark.confidence };
  }

  return { cost: null, confidence: "unconfirmed" };
}

module.exports = { isCentralArea, estimateHdbCost, estimatePrivateCost, CENTRAL_AREA_POLYGON };

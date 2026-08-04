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

// A "flatEntry" rate (e.g. "$4 per entry") is hand-curated from user
// reviews describing a typical shopping/dining visit - nobody has confirmed
// whether it still applies to a long or overnight stay, so treating it as
// duration-proof beyond this many hours would be guessing, not estimating.
const FLAT_ENTRY_MAX_HOURS = 12;

// Estimate cost for a private carpark given its rate model and a duration.
// startMin (minutes from midnight the parking session starts) picks between
// a carpark's day/evening flat entry fee when both are known - most
// flatEntry carparks only have one rate, so this is a no-op for those.
function estimatePrivateCost(carpark, durationHours, startMin) {
  const { rateModel } = carpark;

  if (rateModel === "flatEntry") {
    if (durationHours > FLAT_ENTRY_MAX_HOURS) {
      return { cost: null, confidence: "unconfirmed" };
    }
    const useEvening =
      startMin != null && carpark.eveningFlatCost != null && startMin >= (carpark.eveningCutoverMin ?? 17 * 60);
    const cost = useEvening ? carpark.eveningFlatCost : carpark.flatCost;
    return { cost, confidence: carpark.confidence };
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

// --- Motorcycle short-term parking ---
// HDB/URA motorcycle parking is a flat $0.65 per session, NOT metered like
// cars. There are two sessions: "day" (7:00am-10:30pm) and "night"
// (10:30pm-7:00am). If your parking window touches a session at all, that
// session's $0.65 charge applies - so a window spanning both day and night
// costs $1.30. This is the same flat fee everywhere (no Central Area
// distinction for motorcycles).
// Source: HDB short-term parking charges + multiple 2025-2026 rider guides,
// consistently citing $0.65/session.
const MOTORCYCLE_SESSION_RATE = 0.65;
const DAY_SESSION_START_MIN = 7 * 60; // 7:00am
const DAY_SESSION_END_MIN = 22 * 60 + 30; // 10:30pm

function estimateHdbMotorcycleCost({ startMin, endMin, dayOfWeek, isPublicHoliday = false } = {}) {
  const isSunday = dayOfWeek === 0;
  if (isSunday || isPublicHoliday) {
    return {
      estimatedCost: 0,
      rateLabel: "Free (Sunday/Public Holiday, 7am-10:30pm)",
      confidence: "confirmed",
    };
  }

  // Normalize a window that may wrap past midnight into a list of [start,end]
  // segments within a single 24h clock (0-1440).
  let segments;
  if (startMin == null || endMin == null) {
    // No specific clock times given - assume a single day-session visit.
    segments = [[DAY_SESSION_START_MIN, DAY_SESSION_START_MIN + 1]];
  } else if (endMin > startMin) {
    segments = [[startMin, endMin]];
  } else {
    // Wraps past midnight
    segments = [
      [startMin, 24 * 60],
      [0, endMin],
    ];
  }

  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

  let touchesDay = false;
  let touchesNight = false;
  for (const [s, e] of segments) {
    if (overlaps(s, e, DAY_SESSION_START_MIN, DAY_SESSION_END_MIN)) touchesDay = true;
    if (overlaps(s, e, DAY_SESSION_END_MIN, 24 * 60) || overlaps(s, e, 0, DAY_SESSION_START_MIN)) touchesNight = true;
  }

  const sessions = (touchesDay ? 1 : 0) + (touchesNight ? 1 : 0) || 1;
  const cost = Math.round(sessions * MOTORCYCLE_SESSION_RATE * 100) / 100;

  return {
    estimatedCost: cost,
    rateLabel: `Flat $${MOTORCYCLE_SESSION_RATE.toFixed(2)}/session (day 7am-10:30pm or night 10:30pm-7am)${
      sessions > 1 ? " - spans both sessions" : ""
    }`,
    confidence: "confirmed",
  };
}

// --- Official LTA-sourced private/commercial carpark rates ---
// Chooses the day-rate text or evening-rate text based on the parking
// start time (evening text typically kicks in ~5-6pm, varies per venue -
// approximated at 6pm here since exact cutovers differ slightly by venue),
// then parses it with the LTA rate-text parser.
const { parseLtaRateTextSafe } = require("./ltaRateParser");

function estimateLtaCarparkCost(carpark, durationHours, startMin) {
  const EVENING_CUTOVER_MIN = 18 * 60; // 6pm approximation
  const useEvening =
    startMin != null && startMin >= EVENING_CUTOVER_MIN && carpark.rateEveningText;
  const text = useEvening ? carpark.rateEveningText : carpark.rateDayText;

  const parsed = parseLtaRateTextSafe(text, durationHours);
  return {
    cost: parsed.cost,
    confidence: parsed.cost != null ? "confirmed" : "unconfirmed",
    rateLabel: text,
  };
}

module.exports = {
  isCentralArea,
  estimateHdbCost,
  estimatePrivateCost,
  estimateHdbMotorcycleCost,
  estimateLtaCarparkCost,
  CENTRAL_AREA_POLYGON,
};

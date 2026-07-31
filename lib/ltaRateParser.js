// lib/ltaRateParser.js
//
// LTA publishes real rates for ~357 commercial/private carparks islandwide as
// free-text strings (e.g. "$1.40 for 1st hr; $0.80 for sub. 30min or part
// thereof."), via the official "Carpark Rates" dataset (data.gov.sg,
// resource_id d_9f6056bdb6b1dfba57f063593e4f34ae, sourced from LTA).
//
// This parser turns those strings into a computed cost for a given duration.
// It only returns a confident numeric answer when the text clearly matches
// one of the common templates below - anything it can't parse cleanly comes
// back as unconfirmed rather than a guessed number, since a wrong "official"
// -looking price is worse than admitting we don't know.

function parseMoney(str) {
  const m = str.match(/\$\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// Converts phrases like "sub. 30min", "sub ½ hr", "sub 15 mins", "sub. hr"
// into a number of minutes.
function parseSubUnitMinutes(str) {
  if (/½\s*hr/i.test(str) || /\b30\s*min/i.test(str)) return 30;
  if (/\b15\s*min/i.test(str)) return 15;
  if (/\b10\s*min/i.test(str)) return 10;
  if (/\bhr\b/i.test(str) && !/min/i.test(str)) return 60;
  const m = str.match(/(\d+)\s*min/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Attempt to parse one LTA rate-text string and compute a cost for a given
 * duration in hours. Returns { cost, confidence, matchedPattern } or
 * { cost: null, confidence: 'unconfirmed' } if the text doesn't match a
 * template we trust.
 */
function parseLtaRateText(text, durationHours) {
  if (!text || text === "-" || /closed/i.test(text)) {
    return { cost: null, confidence: "unconfirmed" };
  }

  const durationMinutes = durationHours * 60;

  // Pattern: "Free" (whole string or "Daily free: 7am-11pm" etc.)
  if (/^free/i.test(text.trim()) || /^daily free/i.test(text.trim())) {
    return { cost: 0, confidence: "confirmed", matchedPattern: "free" };
  }

  // Pattern: "$X for 1st hr; $Y for sub. Zmin" (the most common template)
  const tieredMatch = text.match(
    /S?\$\s*([\d.]+)\s*for\s*1st\s*(hr|½\s*hr|\d+\s*min)[^$]*?S?\$\s*([\d.]+)\s*(?:for\s*sub\.?|every)\s*([^.;]*)/i
  );
  if (tieredMatch) {
    const firstRate = parseFloat(tieredMatch[1]);
    const firstUnit = /hr/i.test(tieredMatch[2]) && !/½/.test(tieredMatch[2]) ? 60 : 30;
    const subRate = tieredMatch[3] != null ? parseFloat(tieredMatch[3]) : null;
    const subUnitMin = parseSubUnitMinutes(tieredMatch[4] || "");

    if (subRate != null && subUnitMin) {
      const remainingMin = Math.max(0, durationMinutes - firstUnit);
      const subBlocks = Math.ceil(remainingMin / subUnitMin);
      const cost = firstRate + subBlocks * subRate;
      return { cost: Math.round(cost * 100) / 100, confidence: "confirmed", matchedPattern: "tiered" };
    }
  }

  // Pattern: "$X per entry" (flat regardless of duration)
  const perEntryMatch = text.match(/\$\s*([\d.]+)\s*per\s*entry/i);
  if (perEntryMatch) {
    return { cost: parseFloat(perEntryMatch[1]), confidence: "confirmed", matchedPattern: "flatEntry" };
  }

  // Pattern: "$X per min" (continuous per-minute charging, optional cap)
  const perMinMatch = text.match(/\$\s*([\d.]+)\s*\/?\s*per\s*min/i) || text.match(/\$\s*([\d.]+)\s*\/\s*min/i);
  if (perMinMatch) {
    const rate = parseFloat(perMinMatch[1]);
    let cost = rate * durationMinutes;
    const capMatch = text.match(/capped\s*at\s*\$\s*([\d.]+)/i) || text.match(/max\/?\s*day:?\s*\$\s*([\d.]+)/i);
    if (capMatch) cost = Math.min(cost, parseFloat(capMatch[1]));
    return { cost: Math.round(cost * 100) / 100, confidence: "confirmed", matchedPattern: "perMinute" };
  }

  // Pattern: "$X per ½ hr" / "$X per 30 mins" / "$X per 30 Mins" (flat repeating unit)
  const perHalfHourMatch = text.match(/\$\s*([\d.]+)\s*(?:\/|per)\s*½\s*hr/i) || text.match(/\$\s*([\d.]+)\s*(?:\/|per)\s*30\s*min/i);
  if (perHalfHourMatch) {
    const rate = parseFloat(perHalfHourMatch[1]);
    const blocks = Math.ceil(durationMinutes / 30);
    return { cost: Math.round(rate * blocks * 100) / 100, confidence: "confirmed", matchedPattern: "perHalfHour" };
  }

  // Pattern: "$X per hr" (flat repeating hourly, no tiering)
  const perHourMatch = text.match(/\$\s*([\d.]+)\s*per\s*hr\b/i);
  if (perHourMatch) {
    const rate = parseFloat(perHourMatch[1]);
    const blocks = Math.ceil(durationHours);
    return { cost: Math.round(rate * blocks * 100) / 100, confidence: "confirmed", matchedPattern: "perHour" };
  }

  // Couldn't confidently parse this text - don't guess.
  return { cost: null, confidence: "unconfirmed" };
}

/**
 * Parse LTA rate text with a safety guard against silently-wrong matches:
 * if the text looks structurally complex (multiple tiers/dollar amounts,
 * or explicit "1st"/"2nd"/"3rd" tier language) but doesn't cleanly match
 * our trusted 2-tier "tiered" template, we refuse to fall back to a looser
 * pattern that might only match a substring - an unconfirmed result is
 * safer than a confidently wrong one.
 */
function parseLtaRateTextSafe(text, durationHours) {
  if (!text || text === "-") return { cost: null, confidence: "unconfirmed" };

  const dollarCount = (text.match(/\$/g) || []).length;
  const looksMultiTier = /\b(2nd|3rd|second|third)\b/i.test(text) || dollarCount >= 3;

  const result = parseLtaRateText(text, durationHours);

  if (looksMultiTier && result.matchedPattern !== "tiered") {
    return { cost: null, confidence: "unconfirmed" };
  }

  return result;
}

module.exports = { parseLtaRateText, parseLtaRateTextSafe, parseMoney, parseSubUnitMinutes };

/**
 * Address quality validation (completeness for delivery — not real-world geocoding).
 *
 * Accepts a full address string or structured fields.
 * Configuration: config/addressValidation.defaults.js + config/addressValidation.json
 *
 * Extension point: wrap or replace `validateAddress` later with Google/courier adapters
 * without changing call sites that consume the result shape.
 */

const {
  loadAddressValidationConfig,
} = require("../config/addressValidation");

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[\s,|/\\-]+/)
    .map((t) => t.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);
}

function meaningfulWords(text, stopWords = []) {
  const stops = new Set(
    (stopWords || []).map((w) => String(w).toLowerCase()),
  );
  return tokenize(text).filter((w) => w.length > 1 && !stops.has(w));
}

function hasDigit(text) {
  return /\d/.test(String(text || ""));
}

function hasRepeatedCharacters(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (compact.length < 8) return false;
  // Same char repeated (aaa… / 111…)
  if (/^(.)\1{7,}$/i.test(compact)) return true;
  // High repetition of one character
  const counts = {};
  for (const ch of compact.toLowerCase()) {
    counts[ch] = (counts[ch] || 0) + 1;
  }
  const max = Math.max(...Object.values(counts), 0);
  return max / compact.length >= 0.85;
}

function looksLikeNonsenseToken(token) {
  if (!token || token.length < 3) return false;
  if (/^\d+$/.test(token)) return false;
  // Low vowel ratio for latin words
  const vowels = (token.match(/[aeiou]/gi) || []).length;
  if (token.length >= 4 && vowels / token.length < 0.15) return true;
  // Alternating mash patterns
  if (/^(asd|qwe|zxc|qaz|wsx|rfv)+$/i.test(token)) return true;
  return false;
}

function detectGibberish(text, cfg) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return true;
  const nonsense = tokens.filter(looksLikeNonsenseToken);
  const ratio = nonsense.length / tokens.length;
  const avgLen =
    tokens.reduce((s, t) => s + t.length, 0) / Math.max(tokens.length, 1);
  const minAvg = cfg?.gibberish?.minAvgTokenLength ?? 2.5;
  const maxRatio = cfg?.gibberish?.nonsenseTokenRatio ?? 0.5;
  return ratio >= maxRatio || (tokens.length >= 2 && avgLen < minAvg && ratio > 0.3);
}

function countDuplicateWordPenalty(words) {
  if (words.length < 2) return { penalty: 0, duplicates: [] };
  const counts = {};
  for (const w of words) {
    counts[w] = (counts[w] || 0) + 1;
  }
  const duplicates = Object.entries(counts)
    .filter(([, c]) => c >= 3)
    .map(([w]) => w);
  // Also flag immediate triple repeats conceptually via count >= 3
  const penalty = Math.min(25, duplicates.length * 12);
  return { penalty, duplicates };
}

function findCity(text, cities) {
  const hay = ` ${normalizeText(text).toLowerCase()} `;
  let found = null;
  let bestLen = 0;
  for (const city of cities || []) {
    const c = String(city).toLowerCase().trim();
    if (!c) continue;
    if (hay.includes(` ${c} `) || hay.startsWith(`${c} `) || hay.endsWith(` ${c}`) || hay.trim() === c) {
      if (c.length >= bestLen) {
        bestLen = c.length;
        found = c;
      }
    }
  }
  return found;
}

function findCountry(text, countries) {
  const hay = ` ${normalizeText(text).toLowerCase()} `;
  for (const country of countries || []) {
    const c = String(country).toLowerCase().trim();
    if (!c) continue;
    const re = new RegExp(`(?:^|[\\s,])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s,])`, "i");
    if (re.test(hay)) return c;
  }
  return null;
}

function hasStreetKeyword(text, keywords) {
  const tokens = new Set(tokenize(text));
  for (const kw of keywords || []) {
    const k = String(kw).toLowerCase().trim();
    if (!k) continue;
    if (tokens.has(k)) return k;
    // multi-word keywords
    if (k.includes(" ") && normalizeText(text).toLowerCase().includes(k)) {
      return k;
    }
  }
  return null;
}

function matchBlacklist(text, blacklist) {
  const lower = normalizeText(text).toLowerCase();
  const hits = [];
  for (const item of blacklist || []) {
    const b = String(item).toLowerCase().trim();
    if (!b) continue;
    if (b.includes(" ")) {
      if (lower.includes(b)) hits.push(b);
    } else {
      const tokens = tokenize(lower);
      if (tokens.includes(b) || lower === b) hits.push(b);
    }
  }
  return hits;
}

function extractPostalCandidate(text) {
  // Prefer standalone 5-digit or ZIP+4 or UK-like tokens
  const s = normalizeText(text);
  const zip4 = s.match(/\b\d{5}-\d{4}\b/);
  if (zip4) return zip4[0];
  const five = s.match(/\b\d{5}\b/);
  if (five) return five[0];
  const uk = s.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  if (uk) return uk[0].toUpperCase();
  return null;
}

function validatePostalCode(postal, countryKey, patterns) {
  if (!postal) return { ok: false, reason: "missing" };
  const key = String(countryKey || "default").toLowerCase();
  const patternStr =
    patterns?.[key] || patterns?.default || "^[A-Z0-9][A-Z0-9\\s\\-]{2,10}$";
  let re;
  try {
    re = new RegExp(patternStr, "i");
  } catch {
    re = /^[A-Z0-9][A-Z0-9\s\-]{2,10}$/i;
  }
  const ok = re.test(String(postal).trim());
  return { ok, reason: ok ? null : "invalid" };
}

function buildFullAddressFromParts(parts = {}) {
  const {
    house,
    building,
    street,
    area,
    city,
    postalCode,
    postal_code,
    zip,
    country,
    address,
  } = parts;
  if (address && normalizeText(address)) return normalizeText(address);
  return [
    house || building,
    street,
    area,
    city,
    postalCode || postal_code || zip,
    country,
  ]
    .map((x) => normalizeText(x))
    .filter(Boolean)
    .join(", ");
}

function emptyResult(extra = {}) {
  return {
    isValid: false,
    score: 0,
    confidence: "LOW",
    warnings: [],
    missingFields: [],
    suggestions: [],
    ...extra,
  };
}

/**
 * @param {string|object} input - full address string OR structured fields
 * @param {object} [options]
 * @param {object} [options.config] - partial config overrides
 * @returns {{
 *   isValid: boolean,
 *   score: number,
 *   confidence: "LOW"|"MEDIUM"|"HIGH",
 *   warnings: string[],
 *   missingFields: string[],
 *   suggestions: string[],
 *   details?: object
 * }}
 */
function validateAddress(input, options = {}) {
  const cfg = loadAddressValidationConfig(options.config || null);
  const weights = { ...cfg.weights };

  const structured =
    input != null && typeof input === "object" && !Array.isArray(input) ?
      input
    : null;
  const fullAddress =
    typeof input === "string" ?
      normalizeText(input)
    : buildFullAddressFromParts(structured || {});

  const warnings = [];
  const missingFields = [];
  const suggestions = [];
  const details = {
    hasHouseNumber: false,
    hasStreet: false,
    hasArea: false,
    hasCity: false,
    hasPostalCode: false,
    hasCountry: false,
    city: null,
    country: null,
    postalCode: null,
  };

  // 1. Empty
  if (!fullAddress) {
    return emptyResult({
      warnings: ["Address is empty."],
      missingFields: ["house", "street", "area", "city"],
      suggestions: ["Please enter a complete delivery address."],
      details,
    });
  }

  // 9. Repeated characters (hard reject)
  if (hasRepeatedCharacters(fullAddress)) {
    return emptyResult({
      warnings: ["Address looks like repeated characters."],
      suggestions: ["Please enter a real street address."],
      details,
    });
  }

  // 2. Minimum length
  if (fullAddress.length < (cfg.minimumLength || 15)) {
    return emptyResult({
      score: 10,
      warnings: ["Address is too short."],
      missingFields: ["street", "area", "city"],
      suggestions: [
        `Please provide a fuller address (at least ${cfg.minimumLength} characters).`,
      ],
      details,
    });
  }

  const words = meaningfulWords(fullAddress, cfg.stopWords);

  // 3. Word count
  if (words.length < (cfg.minimumWords || 4)) {
    return emptyResult({
      score: 20,
      warnings: ["Address has too few meaningful words."],
      missingFields: ["street", "area", "city"].filter((f) => {
        if (f === "city") return !findCity(fullAddress, cfg.cities);
        return true;
      }),
      suggestions: [
        "Please include house/building, street, area, and city.",
      ],
      details,
    });
  }

  // 8. Blacklist
  const blackHits = matchBlacklist(fullAddress, cfg.blacklist);
  if (blackHits.length) {
    warnings.push(
      `Suspicious or placeholder wording detected: ${blackHits.join(", ")}.`,
    );
  }

  // 10. Gibberish
  const gibberish = detectGibberish(fullAddress, cfg);
  if (gibberish) {
    warnings.push("Address may be gibberish or random characters.");
    suggestions.push("Please use clear street and area names.");
  }

  // 11. Duplicate words
  const { penalty: dupPenalty, duplicates } = countDuplicateWordPenalty(words);
  if (duplicates.length) {
    warnings.push(
      `Repeated words detected: ${duplicates.join(", ")}.`,
    );
  }

  // Structured helpers
  const housePart = normalizeText(
    structured?.house || structured?.building || "",
  );
  const streetPart = normalizeText(structured?.street || "");
  const areaPart = normalizeText(structured?.area || "");
  const cityPart = normalizeText(structured?.city || "");
  const postalPart = normalizeText(
    structured?.postalCode ||
      structured?.postal_code ||
      structured?.zip ||
      "",
  );
  const countryPart = normalizeText(structured?.country || "");

  // 4. House / building number
  details.hasHouseNumber =
    hasDigit(housePart) ||
    hasDigit(fullAddress) ||
    /\b(house|plot|flat|apt|apartment|shop)\s*#?\s*\d+/i.test(fullAddress);
  if (!details.hasHouseNumber) {
    warnings.push("No house/building number found.");
    suggestions.push("Please include your house number.");
    missingFields.push("house");
  }

  // 5. Street
  const streetKw =
    hasStreetKeyword(streetPart, cfg.streetKeywords) ||
    hasStreetKeyword(fullAddress, cfg.streetKeywords);
  details.hasStreet = Boolean(streetKw || (streetPart && streetPart.length >= 3));
  if (!details.hasStreet) {
    warnings.push("Street-related wording not found.");
    suggestions.push("Street name appears missing.");
    missingFields.push("street");
  }

  // Area (heuristic: has a non-city locality token or structured area)
  details.hasArea =
    Boolean(areaPart) ||
    /\b(block|sector|phase|colony|town|society|pechs|dha|gulshan|bahria|scheme)\b/i.test(
      fullAddress,
    );
  if (!details.hasArea) {
    missingFields.push("area");
    suggestions.push("Consider adding area / locality (e.g. Block, Sector, Phase).");
  }

  // 6. City
  const cityFound =
    (cityPart && findCity(cityPart, cfg.cities)) ||
    findCity(fullAddress, cfg.cities) ||
    (cityPart ? cityPart.toLowerCase() : null);
  // If structured city provided but not in list, still count as present (configurable list is soft)
  details.hasCity = Boolean(
    cityPart || findCity(fullAddress, cfg.cities),
  );
  details.city = cityFound || (cityPart ? cityPart.toLowerCase() : null);
  if (!details.hasCity) {
    warnings.push("City could not be identified.");
    suggestions.push("City could not be identified.");
    missingFields.push("city");
  } else if (cityPart && !findCity(cityPart, cfg.cities) && !findCity(fullAddress, cfg.cities)) {
    warnings.push(
      `City "${cityPart}" is not in the known city list (still accepted).`,
    );
  }

  // 7. Country + postal
  details.country =
    (countryPart && findCountry(countryPart, cfg.countries)) ||
    findCountry(fullAddress, cfg.countries) ||
    (countryPart ? countryPart.toLowerCase() : null);
  details.hasCountry = Boolean(details.country || countryPart);

  const postalCandidate =
    postalPart || extractPostalCandidate(fullAddress);
  details.postalCode = postalCandidate;
  const countryKey = details.country || "default";
  if (postalCandidate) {
    const postalCheck = validatePostalCode(
      postalCandidate,
      countryKey,
      cfg.postalCodePatterns,
    );
    details.hasPostalCode = postalCheck.ok;
    if (!postalCheck.ok) {
      warnings.push("Postal code is invalid for the selected country.");
      suggestions.push("Postal code is invalid.");
    }
  } else {
    details.hasPostalCode = false;
    missingFields.push("postalCode");
    suggestions.push("Consider adding a postal / ZIP code.");
  }

  if (!details.hasCountry) {
    // soft — often omitted for domestic
    suggestions.push("Adding a country improves delivery routing.");
  }

  // 13. Score
  let score = 0;
  if (details.hasHouseNumber) score += weights.houseNumber || 0;
  if (details.hasStreet) score += weights.street || 0;
  if (details.hasArea) score += weights.area || 0;
  if (details.hasCity) score += weights.city || 0;
  if (details.hasPostalCode) score += weights.postalCode || 0;
  if (details.hasCountry) score += weights.country || 0;

  if (blackHits.length) score -= Math.min(20, blackHits.length * 8);
  if (gibberish) score -= 25;
  if (dupPenalty) score -= dupPenalty;
  if (!details.hasHouseNumber) {
    /* already zero weight */
  }

  score = clampScore(score);

  const highMin = cfg.confidence?.highMin ?? 90;
  const mediumMin = cfg.confidence?.mediumMin ?? 70;
  let confidence = "LOW";
  if (score >= highMin) confidence = "HIGH";
  else if (score >= mediumMin) confidence = "MEDIUM";

  // Hard rejects already returned. Soft validity: not empty + min length/words passed + score threshold
  const minScore = cfg.minimumScore ?? 40;
  const isValid =
    score >= minScore &&
    !gibberish &&
    blackHits.length === 0 &&
    details.hasCity &&
    (details.hasStreet || details.hasHouseNumber);

  // Deduplicate suggestion/warning lists
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];

  return {
    isValid,
    score,
    confidence,
    warnings: uniq(warnings),
    missingFields: uniq(missingFields),
    suggestions: uniq(suggestions),
    details,
    normalizedAddress: fullAddress,
  };
}

/**
 * Convenience: validate order-like document fields.
 */
function validateOrderAddressFields(orderLike, options = {}) {
  return validateAddress(
    {
      address: orderLike?.address,
      city: orderLike?.city,
      state: orderLike?.state,
      zip: orderLike?.zip || orderLike?.postal_code || orderLike?.postalCode,
      country: orderLike?.country,
    },
    options,
  );
}

module.exports = {
  validateAddress,
  validateOrderAddressFields,
  buildFullAddressFromParts,
};

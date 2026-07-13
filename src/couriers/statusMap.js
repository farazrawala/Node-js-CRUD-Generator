/**
 * Maps provider-specific status strings/codes into unified statuses.
 * @module src/couriers/statusMap
 */

const { UNIFIED_STATUSES } = require("./constants");

/**
 * @typedef {{ pattern: RegExp|string, status: string }} StatusRule
 */

/** @type {StatusRule[]} */
const COMMON_RULES = [
  { pattern: /deliver(ed|y complete)/i, status: UNIFIED_STATUSES.DELIVERED },
  { pattern: /\bok\b/i, status: UNIFIED_STATUSES.DELIVERED },
  { pattern: /out[\s_-]*for[\s_-]*delivery/i, status: UNIFIED_STATUSES.OUT_FOR_DELIVERY },
  { pattern: /arriv(ed|al)/i, status: UNIFIED_STATUSES.ARRIVED },
  { pattern: /in[\s_-]*transit|dispatched|departed|on[\s_-]*route/i, status: UNIFIED_STATUSES.IN_TRANSIT },
  { pattern: /picked[\s_-]*up|pickup|collected/i, status: UNIFIED_STATUSES.PICKED },
  { pattern: /booked|created|shipment created|consignment/i, status: UNIFIED_STATUSES.BOOKED },
  { pattern: /return(ed|ing)|rto/i, status: UNIFIED_STATUSES.RETURNED },
  { pattern: /cancel(led|ation)?/i, status: UNIFIED_STATUSES.CANCELLED },
  { pattern: /fail(ed|ure)|undeliver/i, status: UNIFIED_STATUSES.FAILED },
  { pattern: /exception|hold|delay|damage|lost/i, status: UNIFIED_STATUSES.EXCEPTION },
];

/** TCS-specific code overrides (from Delivery Status List / tracking codes). */
const TCS_CODE_MAP = Object.freeze({
  OK: UNIFIED_STATUSES.DELIVERED,
  OFD: UNIFIED_STATUSES.OUT_FOR_DELIVERY,
  IC: UNIFIED_STATUSES.IN_TRANSIT,
  SM: UNIFIED_STATUSES.BOOKED,
  PU: UNIFIED_STATUSES.PICKED,
  RT: UNIFIED_STATUSES.RETURNED,
  CN: UNIFIED_STATUSES.CANCELLED,
});

/** Leopard / LCS common packet statuses. */
const LEOPARD_CODE_MAP = Object.freeze({
  Dispatched: UNIFIED_STATUSES.IN_TRANSIT,
  "Assigned for Delivery": UNIFIED_STATUSES.OUT_FOR_DELIVERY,
  Delivered: UNIFIED_STATUSES.DELIVERED,
  Returned: UNIFIED_STATUSES.RETURNED,
  Cancelled: UNIFIED_STATUSES.CANCELLED,
  "Parcel Received at Origin": UNIFIED_STATUSES.PICKED,
  Booked: UNIFIED_STATUSES.BOOKED,
});

/**
 * @param {string|null|undefined} text
 * @param {StatusRule[]} [extraRules]
 * @returns {string}
 */
function mapByRules(text, extraRules = []) {
  const value = String(text || "").trim();
  if (!value) return UNIFIED_STATUSES.BOOKED;

  for (const rule of [...extraRules, ...COMMON_RULES]) {
    const { pattern, status } = rule;
    if (pattern instanceof RegExp) {
      if (pattern.test(value)) return status;
    } else if (String(pattern).toLowerCase() === value.toLowerCase()) {
      return status;
    }
  }
  return UNIFIED_STATUSES.EXCEPTION;
}

/**
 * Map a TCS tracking status/code to a unified status.
 * @param {{ status?: string, code?: string, description?: string }} event
 * @returns {string}
 */
function mapTcsStatus(event = {}) {
  const code = String(event.code || event.statuscode || "").trim().toUpperCase();
  if (code && TCS_CODE_MAP[code]) return TCS_CODE_MAP[code];
  return mapByRules(event.status || event.description || code);
}

/**
 * Map a Leopard tracking status to a unified status.
 * @param {{ status?: string, packet_status?: string, TrackingDetail?: string }} event
 * @returns {string}
 */
function mapLeopardStatus(event = {}) {
  const raw =
    event.status ||
    event.packet_status ||
    event.TrackingDetail ||
    event.booked_packet_status ||
    "";
  const key = String(raw).trim();
  if (key && LEOPARD_CODE_MAP[key]) return LEOPARD_CODE_MAP[key];
  return mapByRules(key);
}

/**
 * Generic mapper used by future providers until they supply their own.
 * @param {string} providerStatus
 * @returns {string}
 */
function mapGenericStatus(providerStatus) {
  return mapByRules(providerStatus);
}

module.exports = {
  mapTcsStatus,
  mapLeopardStatus,
  mapGenericStatus,
  mapByRules,
  TCS_CODE_MAP,
  LEOPARD_CODE_MAP,
};

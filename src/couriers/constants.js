/**
 * Shared courier integration constants.
 * @module src/couriers/constants
 */

/** Unified shipment lifecycle statuses (provider-agnostic). */
const UNIFIED_STATUSES = Object.freeze({
  BOOKED: "Booked",
  PICKED: "Picked",
  IN_TRANSIT: "In Transit",
  ARRIVED: "Arrived",
  OUT_FOR_DELIVERY: "Out For Delivery",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  EXCEPTION: "Exception",
  FAILED: "Failed",
});

/** Statuses that should stop background tracking sync. */
const TERMINAL_STATUSES = Object.freeze([
  UNIFIED_STATUSES.DELIVERED,
  UNIFIED_STATUSES.RETURNED,
  UNIFIED_STATUSES.CANCELLED,
  UNIFIED_STATUSES.FAILED,
]);

/** Supported provider keys (factory registration keys). */
const PROVIDERS = Object.freeze({
  TCS: "TCS",
  LEOPARD: "Leopard",
  BLUEEX: "BlueEX",
  MNP: "M&P",
  CALL_COURIER: "Call Courier",
  TRAX: "Trax",
});

const PROVIDER_ALIASES = Object.freeze({
  tcs: PROVIDERS.TCS,
  TCS: PROVIDERS.TCS,
  leopard: PROVIDERS.LEOPARD,
  Leopard: PROVIDERS.LEOPARD,
  leopards: PROVIDERS.LEOPARD,
  LCS: PROVIDERS.LEOPARD,
  blueex: PROVIDERS.BLUEEX,
  BlueEX: PROVIDERS.BLUEEX,
  "blue-ex": PROVIDERS.BLUEEX,
  mnp: PROVIDERS.MNP,
  "m&p": PROVIDERS.MNP,
  "M&P": PROVIDERS.MNP,
  mp: PROVIDERS.MNP,
  callcourier: PROVIDERS.CALL_COURIER,
  "call courier": PROVIDERS.CALL_COURIER,
  "Call Courier": PROVIDERS.CALL_COURIER,
  trax: PROVIDERS.TRAX,
  Trax: PROVIDERS.TRAX,
});

/**
 * Normalize a preferredCourier / provider string to a canonical PROVIDERS value.
 * @param {string} value
 * @returns {string|null}
 */
function normalizeProviderKey(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (PROVIDER_ALIASES[raw]) return PROVIDER_ALIASES[raw];
  if (PROVIDER_ALIASES[lower]) return PROVIDER_ALIASES[lower];
  return raw;
}

module.exports = {
  UNIFIED_STATUSES,
  TERMINAL_STATUSES,
  PROVIDERS,
  PROVIDER_ALIASES,
  normalizeProviderKey,
};

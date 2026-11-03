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
  POSTEX: "PostEx",
  FLAGSHIP: "Flagship",
  OTHER: "Other",
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
  postex: PROVIDERS.POSTEX,
  PostEx: PROVIDERS.POSTEX,
  "post-ex": PROVIDERS.POSTEX,
  "post ex": PROVIDERS.POSTEX,
  flagship: PROVIDERS.FLAGSHIP,
  Flagship: PROVIDERS.FLAGSHIP,
  "flag-ship": PROVIDERS.FLAGSHIP,
  "flag ship": PROVIDERS.FLAGSHIP,
  flaship: PROVIDERS.FLAGSHIP,
  Flaship: PROVIDERS.FLAGSHIP,
  "flash-ip": PROVIDERS.FLAGSHIP,
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

  const folded = lower.replace(/[^a-z0-9&]+/g, " ").replace(/\s+/g, " ").trim();
  const tokens = folded.split(" ").filter(Boolean);
  const hasToken = (word) => tokens.includes(word);
  if (tokens.some((token) => token === "lcs" || token.startsWith("leopard"))) {
    return PROVIDERS.LEOPARD;
  }
  if (hasToken("tcs")) return PROVIDERS.TCS;
  if (hasToken("blueex") || folded.includes("blue ex")) return PROVIDERS.BLUEEX;
  if (hasToken("postex") || folded.includes("post ex")) return PROVIDERS.POSTEX;
  if (hasToken("trax")) return PROVIDERS.TRAX;
  if (hasToken("flagship") || hasToken("flaship")) return PROVIDERS.FLAGSHIP;
  if (hasToken("mnp") || folded.includes("m&p") || folded.includes("m p")) {
    return PROVIDERS.MNP;
  }
  if (folded.includes("call courier")) return PROVIDERS.CALL_COURIER;
  return raw;
}

/** POS `courier.type` for each bookable provider. `Other` is handled separately. */
const COURIER_TYPE_BY_PROVIDER = Object.freeze({
  [PROVIDERS.TCS]: "tcs",
  [PROVIDERS.LEOPARD]: "leopard",
  [PROVIDERS.BLUEEX]: "blueex",
  [PROVIDERS.MNP]: "mnp",
  [PROVIDERS.CALL_COURIER]: "call_courier",
  [PROVIDERS.TRAX]: "trax",
  [PROVIDERS.POSTEX]: "postex",
  [PROVIDERS.FLAGSHIP]: "flagship",
});

/**
 * How a Shopify courier label should be stored.
 * Known names reuse that courier type. Anything else gets a basic Other row
 * named exactly as Shopify sent it.
 */
function planImportedCourier(courierName) {
  const label = String(courierName || "").trim();
  if (!label) return null;
  const provider = normalizeProviderKey(label);
  const known =
    Object.values(PROVIDERS).includes(provider) && provider !== PROVIDERS.OTHER;
  if (known) {
    return {
      type: COURIER_TYPE_BY_PROVIDER[provider],
      name: provider,
      provider,
    };
  }
  return {
    type: "other",
    name: label.slice(0, 120),
    provider: PROVIDERS.OTHER,
  };
}

/**
 * Global courier sandbox switch from `.env` (`COURIER_SANDBOX`).
 * Used by all courier drivers (TCS, Leopard, PostEx, …).
 *
 * - `true` / `1` / `yes` / `on` → sandbox endpoints
 * - `false` / `0` / `no` / `off` → production endpoints
 * - unset → fall back to per-courier `config.sandbox` (default sandbox)
 *
 * @returns {boolean|null} null when env is unset
 */
function readCourierSandboxEnv() {
  const raw = process.env.COURIER_SANDBOX;
  if (raw == null || String(raw).trim() === "") return null;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}

/**
 * Resolve sandbox mode for a courier config.
 * `.env` COURIER_SANDBOX wins when set; otherwise uses config.sandbox.
 * @param {object} [config]
 * @returns {boolean}
 */
function isCourierSandbox(config = {}) {
  const fromEnv = readCourierSandboxEnv();
  if (fromEnv != null) return fromEnv;
  if (config.sandbox === false || config.sandbox === "false") return false;
  return true;
}

module.exports = {
  UNIFIED_STATUSES,
  TERMINAL_STATUSES,
  PROVIDERS,
  PROVIDER_ALIASES,
  COURIER_TYPE_BY_PROVIDER,
  normalizeProviderKey,
  planImportedCourier,
  readCourierSandboxEnv,
  isCourierSandbox,
};

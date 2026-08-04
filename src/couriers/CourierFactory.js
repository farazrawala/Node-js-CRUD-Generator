/**
 * Courier provider factory — register drivers here only.
 * Adding a courier: implement BaseCourier + CourierFactory.register(...).
 * @module src/couriers/CourierFactory
 */

const TCSCourier = require("./TCSCourier");
const LeopardCourier = require("./LeopardCourier");
const PostExCourier = require("./PostExCourier");
const { PROVIDERS, normalizeProviderKey } = require("./constants");
const { unsupportedCourier, configMissing } = require("./errors");
const {
  decryptProviderSecrets,
} = require("../utils/encryptCredentials");

/** @type {Map<string, typeof import('./BaseCourier')>} */
const registry = new Map();

/**
 * Register a provider constructor.
 * @param {string} key
 * @param {typeof import('./BaseCourier')} CourierClass
 */
function register(key, CourierClass) {
  const normalized = normalizeProviderKey(key) || key;
  registry.set(normalized, CourierClass);
}

register(PROVIDERS.TCS, TCSCourier);
register(PROVIDERS.LEOPARD, LeopardCourier);
register(PROVIDERS.POSTEX, PostExCourier);

/**
 * Resolve preferred provider key from a company document / settings.
 * @param {object} company
 * @returns {string}
 */
function resolvePreferredProvider(company = {}) {
  const fromField =
    company.preferred_courier ||
    company.preferredCourier ||
    company.shipping_settings?.preferredCourier ||
    company.shipping_settings?.preferred_courier;

  if (fromField) {
    return normalizeProviderKey(fromField) || fromField;
  }

  // product_settings-style JSON string fallback
  try {
    const raw = company.shipping_settings;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = JSON.parse(raw);
      const p = parsed.preferredCourier || parsed.preferred_courier;
      if (p) return normalizeProviderKey(p) || p;
    }
  } catch {
    /* ignore */
  }

  return PROVIDERS.TCS;
}

/**
 * @param {object} company
 * @param {object} [providerConfig] decrypted or encrypted mongoose doc
 * @param {string} [providerOverride]
 * @returns {import('./BaseCourier')}
 */
function get(company, providerConfig, providerOverride) {
  const providerKey =
    normalizeProviderKey(providerOverride) ||
    normalizeProviderKey(providerConfig?.provider) ||
    resolvePreferredProvider(company);

  const CourierClass = registry.get(providerKey);
  if (!CourierClass) {
    throw unsupportedCourier(providerKey);
  }

  if (!providerConfig) {
    throw configMissing(providerKey, company?._id || company?.id);
  }

  const decrypted = decryptProviderSecrets(providerConfig);
  return new CourierClass(decrypted, { company });
}

/**
 * List registered provider keys.
 * @returns {string[]}
 */
function listProviders() {
  return [...registry.keys()];
}

/**
 * True when a provider class is registered.
 * @param {string} key
 */
function isRegistered(key) {
  return registry.has(normalizeProviderKey(key) || key);
}

module.exports = {
  get,
  register,
  resolvePreferredProvider,
  listProviders,
  isRegistered,
  registry,
};

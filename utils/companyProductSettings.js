/**
 * Helpers for `company.product_settings`.
 *
 * `product_settings` is stored as a JSON string on the company document, e.g.
 *   '{"allow_add_to_cart_when_stock_insufficient":true}'
 * These helpers parse it defensively (string or already-parsed object) and
 * expose individual feature flags.
 */

/** Parse `company.product_settings` into a plain object (never throws). */
function parseProductSettings(company) {
  const raw =
    company && typeof company === "object" ? company.product_settings : company;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** Coerce a setting value (boolean, "true"/"1"/"yes"/"on", or number) to boolean. */
function toBooleanFlag(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * True when the company allows selling / adding to cart even if on-hand stock is
 * insufficient (oversell → inventory may go negative). Accepts the flag stored
 * as a boolean or as a truthy string ("true", "1", "yes", "on").
 */
function allowAddToCartWhenStockInsufficient(company) {
  return toBooleanFlag(
    parseProductSettings(company).allow_add_to_cart_when_stock_insufficient,
  );
}

module.exports = {
  parseProductSettings,
  allowAddToCartWhenStockInsufficient,
};

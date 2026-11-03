/**
 * Accept only a real Shopify shop domain.
 * Merchants may paste a shop name, myshopify host, or admin.shopify.com URL.
 * @module src/shopify/shopDomain
 */

const { normalizeShopifyDomain } = require("../../utils/shopifyTokenRefresh");

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function normalizeShopDomain(input) {
  const shop = normalizeShopifyDomain(input);
  if (!shop || !SHOP_RE.test(shop)) return null;
  if (shop === "myshopify.com" || shop.startsWith("admin.")) return null;
  return shop;
}

module.exports = {
  SHOP_RE,
  normalizeShopDomain,
};

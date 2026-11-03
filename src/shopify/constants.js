/**
 * Shopify Admin API version and OAuth scopes.
 * 2026-10 is the stable quarterly version for this release.
 * Override with SHOPIFY_API_VERSION when upgrading. Bump shopify.app.toml
 * [webhooks].api_version in the same change.
 * @module src/shopify/constants
 */

const API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2026-10").trim();

/** Scopes required for products, inventory, orders, and merchant-managed fulfillment. */
const CORE_SCOPES = [
  "read_products",
  "write_products",
  "read_inventory",
  "write_inventory",
  "read_locations",
  "read_orders",
  "write_orders",
  "read_merchant_managed_fulfillment_orders",
  "write_merchant_managed_fulfillment_orders",
];

function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Optional scopes are requested only for features this module implements.
 * read_all_orders stays off until Shopify approves it for the app.
 * read_analytics is intentionally absent. Sales reports use read_reports
 * (ShopifyQL) or OrdersHub order totals.
 */
function installedScopes() {
  const scopes = [...CORE_SCOPES];
  if (envFlag("SHOPIFY_SCOPE_THIRD_PARTY_FULFILLMENT", true)) {
    scopes.push(
      "read_third_party_fulfillment_orders",
      "write_third_party_fulfillment_orders",
    );
  }
  if (envFlag("SHOPIFY_SCOPE_READ_REPORTS", true)) {
    scopes.push("read_reports");
  }
  if (envFlag("SHOPIFY_SCOPE_READ_ALL_ORDERS", false)) {
    scopes.push("read_all_orders");
  }
  return scopes;
}

const WEBHOOK_TOPICS = [
  { graphql: "PRODUCTS_CREATE", rest: "products/create" },
  { graphql: "PRODUCTS_UPDATE", rest: "products/update" },
  { graphql: "PRODUCTS_DELETE", rest: "products/delete" },
  { graphql: "ORDERS_CREATE", rest: "orders/create" },
  { graphql: "ORDERS_UPDATED", rest: "orders/updated" },
  { graphql: "ORDERS_CANCELLED", rest: "orders/cancelled" },
  { graphql: "INVENTORY_LEVELS_UPDATE", rest: "inventory_levels/update" },
  { graphql: "LOCATIONS_CREATE", rest: "locations/create" },
  { graphql: "LOCATIONS_UPDATE", rest: "locations/update" },
  { graphql: "APP_UNINSTALLED", rest: "app/uninstalled" },
];

const INVENTORY_DIRECTIONS = [
  "pos_to_shopify",
  "shopify_to_pos",
  "bidirectional",
];

const DEFAULT_SYNC_SETTINGS = {
  product_sync_enabled: true,
  inventory_sync_direction: "pos_to_shopify",
  order_import_enabled: true,
  fulfillment_sync_enabled: true,
  auto_sync_interval_minutes: 30,
};

function orderHistoryDays(grantedScopes) {
  const scopes = Array.isArray(grantedScopes) ? grantedScopes : [];
  if (scopes.includes("read_all_orders")) {
    const days = Number(process.env.SHOPIFY_ORDER_HISTORY_DAYS || 3650);
    return Number.isFinite(days) && days > 0 ? days : 3650;
  }
  return 60;
}

module.exports = {
  API_VERSION,
  CORE_SCOPES,
  WEBHOOK_TOPICS,
  INVENTORY_DIRECTIONS,
  DEFAULT_SYNC_SETTINGS,
  installedScopes,
  orderHistoryDays,
};

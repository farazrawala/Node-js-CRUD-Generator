const mongoose = require("mongoose");
const {
  extractShopifyImageUrls,
  syncFetchProductImages,
} = require("../utils/fetchProductImages");
const {
  extractShopifyBarcode,
  resolveFetchProductBarcode,
} = require("../utils/fetchProductBarcode");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Company = require("../models/company");
const Product = require("../models/product");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const { recordOrderStatusUpdate } = require("../utils/orderStatusHistory");
const SyncCategory = require("../models/sync_category");
const SyncProduct = require("../models/sync_product");
const WarehouseInventory = require("../models/warehouse_inventory");
const { generateTransactionNumber } = require("../utils/transactionNumber");
require("@shopify/shopify-api/adapters/node");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");
const {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  resolveBatchPagination,
  resolveLatestOrderBatchLimit,
  findExistingCategoryByName,
  findExistingCategory,
  findExistingBrand,
  findExistingProduct,
  findExistingProductBySku,
  findExistingProductByName,
  findPosProductBySyncReference,
  upsertSyncProductMapping,
  finishFetchCategoryBatch,
  finishFetchBrandBatch,
  finishFetchProductBatch,
  finishFetchOrderBatch,
  finishFetchLatestOrderBatch,
  failFetchCategoryBatch,
  failFetchBrandBatch,
  failFetchProductBatch,
  failFetchOrderBatch,
  markProcessOutcome,
  coalesceObjectId,
  orderExternalRef,
  findExistingOrderByExternalRef,
  findExistingImportedOrder,
  resolveIntegrationOrderId,
  resolvePosProductForRemoteLine,
  buildPosOrderLineItemsFromRemote,
  backfillPosOrderLinesIfEmpty,
  resolveFetchOrderImportStatus,
  mapShopifyOrderStatus,
  resolveOrderWebsiteStatus,
  createFetchOrderStats,
  createPullOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
  formatPullOrderBatchRemarks,
  logFetchOrderImported,
  logFetchOrderBatchFailed,
  fallbackRemoteOrderLinesSubtotal,
  findOrCreatePosCustomerFromBilling,
  mapRemoteOrderAddressFields,
  resolveSyncStockTotals,
  syncStockQuantity,
  formatSyncStockFieldRemark,
  applyFetchOrderOutboundInventory,
  updatePosOrderFromRemote,
  resolveRemoteOrderIdFromPosOrder,
  finishPullOrderBatch,
  failPullOrderBatch,
  resolvePosOrderTrackingForPush,
  mapPosOrderStatusToShopifyFulfillmentAction,
  mapTrackingStatusToShopifyFulfillmentEvent,
} = require("../utils/processHelpers");
const {
  resolvePosProductSku,
  resolveSyncProductPrice,
  buildShopifyProductSyncPayload,
  buildShopifyImageResources,
  buildShopifyVariantSyncPayload,
  buildShopifyVariableOptionPlan,
  formatShopifyVariantOptionValue,
  hasSyncPayloadFields,
  isIntegrationSyncEnabled,
  formatProductSyncFieldRemarks,
} = require("../utils/integrationProductSync");
const {
  isShopifyAuthError,
  formatShopifyErrorPayload,
  formatShopifyFulfillmentScopeError,
  resolveShopifyClientCredentials,
  refreshShopifyAccessToken,
} = require("../utils/shopifyTokenRefresh");

function toPlainIntegration(integration) {
  if (!integration) return null;
  if (typeof integration.toObject === "function") {
    return integration.toObject();
  }
  return { ...integration };
}

function buildShopifyClient(integration, { requireToken = true } = {}) {
  const rawUrl =
    typeof integration.url === "string" ? integration.url.trim() : "";
  let shopDomain = rawUrl.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  if (!shopDomain) {
    return { error: "Shopify store URL is missing from the integration." };
  }

  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
      shopDomain = `${shopDomain}.myshopify.com`;
    } else {
      return {
        error:
          "Invalid Shopify store URL. Provide the myshopify.com domain or the shop name.",
      };
    }
  }

  const resolved = resolveShopifyClientCredentials(integration);
  const apiKey = resolved.clientId;
  // Rest custom-app calls only need the access token; keep a placeholder if
  // secret was misfiled as the Admin API token so the SDK can still init.
  const apiSecret = resolved.clientSecret || "unused-when-using-admin-token";
  const accessToken = resolved.accessToken;

  if (!apiKey) {
    return {
      error:
        "Incomplete Shopify credentials. Please verify key (Client ID / API key).",
    };
  }

  if (requireToken && !accessToken) {
    return {
      error:
        "Incomplete Shopify credentials. Set Admin API access token in integration.token (or put Client Secret in secret so it can be refreshed).",
    };
  }

  const shopify = shopifyApi({
    apiKey,
    apiSecretKey: apiSecret,
    adminApiAccessToken: accessToken || "pending-refresh",
    scopes: [
      "read_products",
      "write_products",
      "read_inventory",
      "write_inventory",
      "read_locations",
      "read_merchant_managed_fulfillment_orders",
      "write_merchant_managed_fulfillment_orders",
    ],
    hostName: shopDomain,
    apiVersion: ApiVersion.October24,
    isCustomStoreApp: true,
  });

  const session = shopify.session.customAppSession(shopDomain);
  session.accessToken = accessToken;

  return {
    client: accessToken ? new shopify.clients.Rest({ session }) : null,
    graphql: accessToken ? new shopify.clients.Graphql({ session }) : null,
    shopDomain,
    accessToken: accessToken || null,
  };
}

async function obtainAndPersistShopifyToken(integration, process) {
  const integrationId =
    resolveIntegrationId(process) ||
    integration?._id ||
    integration?.id ||
    null;
  const refreshed = await refreshShopifyAccessToken(integration, integrationId);
  const next = refreshed.integration || {
    ...toPlainIntegration(integration),
    token: refreshed.access_token,
  };

  if (process?.integration_id && typeof process.integration_id === "object") {
    process.integration_id.token = refreshed.access_token;
    if (next.key) process.integration_id.key = next.key;
    if (Object.prototype.hasOwnProperty.call(next, "secret")) {
      process.integration_id.secret = next.secret;
    }
  }

  console.warn(
    refreshed.repaired_from_secret ?
      `Shopify access token recovered from integration.secret and saved on integration ${integrationId}.`
    : `Shopify access token refreshed and saved on integration ${integrationId}.`,
  );

  return next;
}

/**
 * Run a Shopify Admin API call; on missing/expired token refresh in DB and retry once.
 */
async function runWithShopifyClient(integration, process, handler) {
  let activeIntegration = toPlainIntegration(integration);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = resolveShopifyClientCredentials(activeIntegration);
    activeIntegration = {
      ...activeIntegration,
      token: resolved.accessToken || activeIntegration.token,
      // Prefer real client secret when available for refresh; keep original otherwise.
      secret: resolved.clientSecret || activeIntegration.secret,
      key: resolved.clientId || activeIntegration.key,
    };

    if (!resolved.accessToken && resolved.canRefreshWithClientCredentials) {
      try {
        activeIntegration = await obtainAndPersistShopifyToken(
          activeIntegration,
          process,
        );
      } catch (refreshError) {
        throw new Error(
          `Shopify token missing and refresh failed: ${refreshError.message || refreshError}`,
        );
      }
    } else if (!resolved.accessToken && resolved.secretHeldAccessToken) {
      // Should be covered by resolve, but keep a safe path.
      activeIntegration = await obtainAndPersistShopifyToken(
        activeIntegration,
        process,
      );
    }

    const { client, graphql, error } = buildShopifyClient(activeIntegration);
    if (error || !client) {
      throw new Error(error || "Failed to build Shopify client.");
    }

    try {
      return await handler(client, activeIntegration, graphql);
    } catch (apiError) {
      if (attempt === 0 && isShopifyAuthError(apiError)) {
        try {
          activeIntegration = await obtainAndPersistShopifyToken(
            activeIntegration,
            process,
          );
          console.warn(
            "Shopify auth failed; obtained/repaired access token and retrying request.",
          );
          continue;
        } catch (refreshError) {
          console.error(
            "Shopify token refresh failed:",
            refreshError.message || refreshError,
          );
          throw new Error(
            `Shopify auth failed and token refresh failed: ${refreshError.message || refreshError}`,
          );
        }
      }
      throw apiError;
    }
  }

  throw new Error("Shopify request failed after token refresh retry.");
}

/**
 * Extract a human-readable detail string from a Shopify client error.
 * Handles HttpResponseError (status + body), JSON-parse failures on empty
 * bodies ("...end of input at position 0"), and plain Error messages.
 */
function describeShopifyError(error) {
  const status =
    error?.response?.code ?? error?.response?.statusCode ?? error?.code ?? null;

  const body = error?.response?.body ?? error?.response?.data ?? null;

  let bodyText = "";
  if (body != null) {
    if (typeof body === "string") {
      bodyText = body;
    } else {
      try {
        bodyText = JSON.stringify(body);
      } catch {
        bodyText = String(body);
      }
    }
  }

  const message = error?.message || "";
  const parts = [];
  if (status != null) parts.push(`status=${status}`);
  if (bodyText) parts.push(`body=${bodyText}`);
  if (message) parts.push(`message=${message}`);

  return parts.join(" | ") || String(error);
}

/**
 * Replace Shopify product images with the POS featured + gallery files.
 * Shopify PUT product.images appends and leaves the old featured image in
 * place — delete then upload (local file as attachment when present).
 */
async function replaceShopifyProductImages(
  client,
  shopifyProductId,
  product,
  integration,
) {
  if (!client || !shopifyProductId) return;
  if (!isIntegrationSyncEnabled(integration, "sync_product_image")) return;

  const images = buildShopifyImageResources(product);
  if (!images.length) return;

  let existing = [];
  try {
    const resp = await client.get({
      path: `products/${shopifyProductId}`,
    });
    existing =
      Array.isArray(resp?.body?.product?.images) ?
        resp.body.product.images
      : [];
  } catch (err) {
    if (isShopifyAuthError(err)) throw err;
    console.warn(
      `Failed to list Shopify images for product ${shopifyProductId}:`,
      describeShopifyError(err),
    );
  }

  for (const image of existing) {
    if (!image?.id) continue;
    try {
      await client.delete({
        path: `products/${shopifyProductId}/images/${image.id}`,
      });
    } catch (err) {
      if (isShopifyAuthError(err)) throw err;
      console.warn(
        `Failed to delete Shopify image ${image.id}:`,
        describeShopifyError(err),
      );
    }
  }

  for (const image of images) {
    await client.post({
      path: `products/${shopifyProductId}/images`,
      data: { image },
      type: "application/json",
    });
  }
}

function validateShopifyIntegration(integration, res) {
  if (!integration || integration.store_type !== "shopify") {
    res.status(400).json({
      success: false,
      message: "Shopify integration details are missing or invalid.",
    });
    return false;
  }
  if (
    integration.deletedAt ||
    String(integration.status || "").toLowerCase() !== "active"
  ) {
    res.status(400).json({
      success: false,
      skipped: true,
      code: "INTEGRATION_INACTIVE",
      message: "Shopify integration is inactive. Sync skipped.",
    });
    return false;
  }
  return true;
}

function mapShopifyProductType(productType) {
  return String(productType || "").toLowerCase() === "variable" ?
      "Variable"
    : "Single";
}

function isShopifyVariableProduct(remoteProduct) {
  const variants =
    Array.isArray(remoteProduct?.variants) ? remoteProduct.variants : [];
  if (variants.length > 1) {
    return true;
  }
  const options =
    Array.isArray(remoteProduct?.options) ? remoteProduct.options : [];
  return options.some((opt) => {
    const values = Array.isArray(opt?.values) ? opt.values : [];
    return values.filter(Boolean).length > 1;
  });
}

function formatShopifyVariantLabel(variant) {
  const parts = [variant?.option1, variant?.option2, variant?.option3]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.toLowerCase() !== "default title");
  return parts.join(" / ");
}

function buildShopifyVariationProductName(parentName, variant) {
  const label = formatShopifyVariantLabel(variant);
  if (!label) {
    return parentName;
  }
  return `${parentName} [${label}]`;
}

function buildShopifyVariationSku(parentSku, shopifyProductId, variantId) {
  const base =
    String(parentSku || "").trim() ||
    (shopifyProductId ? `shopify-${shopifyProductId}` : "shopify-var");
  return `${base}-var-${variantId}`;
}

async function recordShopifyProductSyncMapping(
  process,
  companyId,
  posProductId,
  websiteProductId,
  stats,
) {
  try {
    const row = await upsertSyncProductMapping({
      productId: posProductId,
      integrationId: resolveIntegrationId(process),
      companyId,
      referenceId: websiteProductId,
      createdBy: process.created_by?._id || process.created_by,
    });
    if (row && stats) {
      stats.sync_product_mapped = (stats.sync_product_mapped || 0) + 1;
    }
    return row;
  } catch (error) {
    console.warn(
      `sync_product mapping failed for Shopify product ${websiteProductId}:`,
      error?.message || error,
    );
    return null;
  }
}

async function findPosProductForShopifyImport({
  process,
  companyId,
  shopifyReferenceId,
  sku,
  name,
}) {
  const integrationId = resolveIntegrationId(process);
  if (shopifyReferenceId && integrationId) {
    const bySync = await findPosProductBySyncReference(
      integrationId,
      companyId,
      shopifyReferenceId,
    );
    if (bySync) {
      return bySync;
    }
  }

  if (sku) {
    const bySku = await findExistingProductBySku(sku, companyId);
    if (bySku) {
      return bySku;
    }
  }

  if (name) {
    return findExistingProductByName(name, companyId);
  }

  return null;
}

async function syncShopifyVariantWarehouseStock({
  warehouseId,
  companyId,
  process,
  posId,
  variant,
  client,
  stats,
}) {
  if (!warehouseId || !variant || !posId) {
    return;
  }
  const stockQty = await resolveShopifyVariantStockQuantity(variant, client);
  const stockResult = await syncShopifyProductWarehouseStock({
    productId: posId,
    companyId,
    warehouseId,
    targetQty: stockQty,
    userId: coalesceObjectId(process.created_by?._id || process.created_by),
  });
  if (stockResult.synced) {
    stats.stock_synced = (stats.stock_synced || 0) + 1;
    if (!stockResult.unchanged) {
      stats.stock_updated = (stats.stock_updated || 0) + 1;
    }
  }
}

function mapShopifyVariantPrice(variant) {
  if (variant?.price == null || variant.price === "") {
    return 0;
  }
  const price = Number(variant.price);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function roundImportQty(value) {
  return Math.round(Number(value) * 100) / 100;
}

function mapShopifyVariantInventoryQuantity(variant) {
  if (!variant) {
    return 0;
  }
  const raw = variant.inventory_quantity;
  if (raw == null || raw === "") {
    return 0;
  }
  const qty = Number(raw);
  return Number.isFinite(qty) ? Math.max(0, roundImportQty(qty)) : 0;
}

/** When Shopify token lacks read_inventory, skip inventory_levels for the rest of the process. */
let shopifyInventoryLevelsUnavailable = false;

function isShopifyInventoryScopeError(error) {
  const body = error?.response?.body;
  const text = JSON.stringify(
    body || error?.message || error || "",
  ).toLowerCase();
  return text.includes("read_inventory") || text.includes("inventory scope");
}

/** Prefer summed `inventory_levels.available`; fall back to variant `inventory_quantity`. */
async function resolveShopifyVariantStockQuantity(variant, client) {
  if (!variant) {
    return 0;
  }
  if (
    variant.inventory_management != null &&
    variant.inventory_management !== "shopify"
  ) {
    return 0;
  }

  const itemId = variant.inventory_item_id;
  if (client && itemId && !shopifyInventoryLevelsUnavailable) {
    try {
      const response = await client.get({
        path: "inventory_levels",
        query: { inventory_item_ids: String(itemId), limit: 250 },
      });
      const levels =
        Array.isArray(response?.body?.inventory_levels) ?
          response.body.inventory_levels
        : [];
      if (levels.length > 0) {
        const total = levels.reduce(
          (sum, row) => sum + (Number(row.available) || 0),
          0,
        );
        return Math.max(0, roundImportQty(total));
      }
    } catch (error) {
      if (isShopifyInventoryScopeError(error)) {
        shopifyInventoryLevelsUnavailable = true;
        console.warn(
          "[shopify fetch_product] read_inventory scope missing — using variant inventory_quantity for stock.",
        );
      } else {
        console.warn(
          `Shopify inventory_levels lookup failed for item ${itemId}:`,
          error?.response?.body || error?.message || error,
        );
      }
    }
  }

  return mapShopifyVariantInventoryQuantity(variant);
}

/** Per-run flags so a 403 on one job does not disable stock for every later sync. */
let shopifyInventoryWriteUnavailable = false;

function resetShopifyInventorySyncFlags() {
  shopifyInventoryLevelsUnavailable = false;
  shopifyInventoryWriteUnavailable = false;
}

/** POS qty for sync push: max(origin_qty, warehouse_inventory.quantity) plus source field. */
async function resolveShopifyStockTotals(productIds, companyId) {
  return resolveSyncStockTotals(productIds, companyId);
}

function shopifyGidNumericId(gid) {
  const raw = String(gid || "").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const last = raw.split("/").pop();
  return last && /^\d+$/.test(last) ? last : null;
}

function shopifyGraphqlData(result) {
  return result?.data || result?.body?.data || null;
}

function shopifyProductGid(productId) {
  const numeric = shopifyGidNumericId(productId);
  return numeric ? `gid://shopify/Product/${numeric}` : null;
}

function shopifySkuSearchQuery(sku) {
  const trimmed = String(sku || "").trim();
  if (!trimmed) return null;
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `sku:"${escaped}"`;
}

/**
 * Shopify REST `GET /variants.json?sku=` ignores `sku` and returns the first
 * page of store variants. Lookup must use GraphQL and then exact-match SKU.
 */
async function findShopifyProductIdByExactSku(graphql, sku) {
  const query = shopifySkuSearchQuery(sku);
  if (!graphql || !query) return null;
  const wanted = String(sku).trim().toLowerCase();
  try {
    const result = await graphql.request(
      `query ProductVariantsBySku($query: String!) {
        productVariants(first: 10, query: $query) {
          nodes {
            sku
            product { id legacyResourceId }
          }
        }
      }`,
      { variables: { query } },
    );
    const nodes = shopifyGraphqlData(result)?.productVariants?.nodes || [];
    const match = nodes.find(
      (row) =>
        String(row?.sku || "")
          .trim()
          .toLowerCase() === wanted,
    );
    return (
      shopifyGidNumericId(match?.product?.legacyResourceId) ||
      shopifyGidNumericId(match?.product?.id) ||
      null
    );
  } catch (err) {
    if (isShopifyAuthError(err)) throw err;
    console.warn(
      `Shopify GraphQL SKU lookup failed for "${sku}":`,
      describeShopifyError(err),
    );
    return null;
  }
}

async function findShopifyProductIdByExactSkus(graphql, skus = []) {
  const seen = new Set();
  for (const sku of skus) {
    const trimmed = String(sku || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const productId = await findShopifyProductIdByExactSku(graphql, trimmed);
    if (productId) return productId;
  }
  return null;
}

async function isShopifyProductMappedToOtherPosProduct({
  shopifyProductId,
  integrationId,
  companyId,
  allowedPosProductIds = [],
}) {
  const remoteId = String(shopifyProductId || "").trim();
  if (!remoteId || !integrationId || !companyId) return false;
  const allowed = new Set(
    (allowedPosProductIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const rows = await SyncProduct.find({
    integration_id: integrationId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
    $or: [
      { refference_id: remoteId },
      { refference_id: { $regex: `^${remoteId}:` } },
    ],
  })
    .select("product_id")
    .lean();
  return rows.some((row) => {
    const posId = String(row?.product_id || "").trim();
    return Boolean(posId) && !allowed.has(posId);
  });
}

/**
 * REST PUT products (API 2024-10) often keeps title/handle but ignores
 * `body_html`. GraphQL `productUpdate.descriptionHtml` is the write that
 * actually updates the Admin description editor.
 */
async function pushShopifyProductDescriptionHtml(
  graphql,
  shopifyProductId,
  bodyHtml,
) {
  if (!graphql || bodyHtml == null) return false;
  const productGid = shopifyProductGid(shopifyProductId);
  if (!productGid) return false;

  const result = await graphql.request(
    `mutation ProductUpdateDescription($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id descriptionHtml }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        product: {
          id: productGid,
          descriptionHtml: String(bodyHtml),
        },
      },
    },
  );

  const data = shopifyGraphqlData(result);
  const gqlErrors = result?.errors || result?.body?.errors || [];
  const errors = [
    ...(Array.isArray(gqlErrors) ? gqlErrors : []),
    ...(data?.productUpdate?.userErrors || []),
  ];
  if (errors.length) {
    throw new Error(
      `Shopify description update failed: ${errors
        .map((row) => row?.message)
        .filter(Boolean)
        .join("; ")}`,
    );
  }
  if (!data?.productUpdate?.product) {
    throw new Error(
      "Shopify description update failed: empty productUpdate response.",
    );
  }
  return true;
}

function shopifyInventoryItemGid(inventoryItemId) {
  const raw = String(inventoryItemId || "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://")) return raw;
  const numeric = shopifyGidNumericId(raw);
  return numeric ? `gid://shopify/InventoryItem/${numeric}` : null;
}

async function resolveShopifyLocationFromRest(client) {
  if (!client) return null;
  try {
    const resp = await client.get({ path: "locations" });
    const locations =
      Array.isArray(resp?.body?.locations) ? resp.body.locations : [];
    const active = locations.find((loc) => loc?.active) || locations[0];
    return active?.id != null ? String(active.id) : null;
  } catch (error) {
    console.warn(
      "Shopify REST locations lookup failed:",
      describeShopifyError(error),
    );
    return null;
  }
}

async function resolveShopifyLocationFromGraphql(graphql) {
  if (!graphql) return null;
  const queries = [
    `query { locations(first: 20) { nodes { id isActive } } }`,
    `query { shop { primaryLocation { id } } }`,
  ];
  for (const query of queries) {
    try {
      const result = await graphql.request(query);
      const nodes = result?.data?.locations?.nodes;
      if (Array.isArray(nodes) && nodes.length) {
        const active = nodes.find((row) => row?.isActive) || nodes[0];
        const id = shopifyGidNumericId(active?.id);
        if (id) return id;
      }
      const primaryId = shopifyGidNumericId(
        result?.data?.shop?.primaryLocation?.id,
      );
      if (primaryId) return primaryId;
    } catch (error) {
      console.warn(
        "Shopify GraphQL location lookup failed:",
        describeShopifyError(error),
      );
    }
  }
  return null;
}

async function resolveShopifyLocationFromInventoryItem(
  client,
  inventoryItemId,
) {
  if (!client || !inventoryItemId) return null;
  try {
    const response = await client.get({
      path: "inventory_levels",
      query: { inventory_item_ids: String(inventoryItemId), limit: 50 },
    });
    const levels =
      Array.isArray(response?.body?.inventory_levels) ?
        response.body.inventory_levels
      : [];
    const row = levels.find((level) => level?.location_id != null) || levels[0];
    return row?.location_id != null ? String(row.location_id) : null;
  } catch (error) {
    console.warn(
      "Shopify inventory_levels location lookup failed:",
      describeShopifyError(error),
    );
    return null;
  }
}

async function resolveShopifyLocationFromVariantGraphql(graphql, variant) {
  const itemGid = shopifyInventoryItemGid(variant?.inventory_item_id);
  if (!graphql || !itemGid) return null;
  try {
    const result = await graphql.request(
      `query InventoryItemLocation($id: ID!) {
        inventoryItem(id: $id) {
          inventoryLevels(first: 10) {
            nodes { location { id } }
          }
        }
      }`,
      { variables: { id: itemGid } },
    );
    const nodes =
      shopifyGraphqlData(result)?.inventoryItem?.inventoryLevels?.nodes || [];
    const locationGid = nodes.find((row) => row?.location?.id)?.location?.id;
    return shopifyGidNumericId(locationGid);
  } catch (error) {
    console.warn(
      "Shopify inventoryItem location query failed:",
      describeShopifyError(error),
    );
    return null;
  }
}

async function resolveShopifyVariantLocation(client, graphql, variant) {
  const fromItemGraphql = await resolveShopifyLocationFromVariantGraphql(
    graphql,
    variant,
  );
  if (fromItemGraphql) return fromItemGraphql;

  const fromItemRest = await resolveShopifyLocationFromInventoryItem(
    client,
    variant?.inventory_item_id,
  );
  if (fromItemRest) return fromItemRest;

  return resolveShopifyPrimaryLocationId(client, graphql, [
    variant?.inventory_item_id,
  ]);
}

/**
 * Prefer a location already attached to inventory items (read_inventory).
 * GET /locations needs read_locations, which this app version does not have.
 */
async function resolveShopifyPrimaryLocationId(
  client,
  graphql = null,
  inventoryItemIds = [],
) {
  const fromRest = await resolveShopifyLocationFromRest(client);
  if (fromRest) return fromRest;

  const itemIds = (
    Array.isArray(inventoryItemIds) ? inventoryItemIds : [inventoryItemIds])
    .map((id) => (id != null ? String(id) : ""))
    .filter(Boolean);
  for (const itemId of itemIds) {
    const fromItem = await resolveShopifyLocationFromInventoryItem(
      client,
      itemId,
    );
    if (fromItem) return fromItem;
  }

  return resolveShopifyLocationFromGraphql(graphql);
}

async function setShopifyVariantInventoryGraphql(
  graphql,
  variant,
  quantity,
  locationId,
) {
  const inventoryItemId = variant?.inventory_item_id;
  if (!graphql || !inventoryItemId || !locationId) return false;
  const available = Math.max(0, Math.round(Number(quantity) || 0));
  try {
    const result = await graphql.request(
      `mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            name: "available",
            reason: "correction",
            ignoreCompareQuantity: true,
            quantities: [
              {
                inventoryItemId: shopifyInventoryItemGid(inventoryItemId),
                locationId: `gid://shopify/Location/${shopifyGidNumericId(locationId)}`,
                quantity: available,
              },
            ],
          },
        },
      },
    );
    const payload = shopifyGraphqlData(result)?.inventorySetQuantities;
    const errors = payload?.userErrors || [];
    if (errors.length) {
      console.warn(
        "Shopify inventorySetQuantities:",
        errors.map((row) => row.message).join("; "),
      );
      return false;
    }
    if (result?.errors?.length) {
      console.warn(
        "Shopify inventorySetQuantities:",
        result.errors.map((row) => row.message || String(row)).join("; "),
      );
      return false;
    }
    return Boolean(payload);
  } catch (error) {
    console.warn(
      `Shopify GraphQL inventory set failed for item ${inventoryItemId}:`,
      describeShopifyError(error),
    );
    return false;
  }
}

async function enableShopifyInventoryItemTracked({
  client,
  graphql,
  variant,
  locationId = null,
}) {
  const inventoryItemId = variant?.inventory_item_id;
  if (!inventoryItemId) return false;
  const itemGid = shopifyInventoryItemGid(inventoryItemId);
  const itemNumeric = Number(
    shopifyGidNumericId(inventoryItemId) || inventoryItemId,
  );
  const locationGid =
    locationId ?
      `gid://shopify/Location/${shopifyGidNumericId(locationId)}`
    : null;

  if (client && itemNumeric) {
    try {
      await client.put({
        path: `inventory_items/${itemNumeric}`,
        data: { inventory_item: { id: itemNumeric, tracked: true } },
        type: "application/json",
      });
    } catch (error) {
      console.warn(
        `Failed to mark Shopify inventory item ${inventoryItemId} tracked:`,
        describeShopifyError(error),
      );
    }
  }

  if (graphql && itemGid) {
    try {
      const result = await graphql.request(
        `mutation InventoryItemTracked($id: ID!) {
          inventoryItemUpdate(id: $id, input: { tracked: true }) {
            inventoryItem { id tracked }
            userErrors { field message }
          }
        }`,
        { variables: { id: itemGid } },
      );
      const errors =
        shopifyGraphqlData(result)?.inventoryItemUpdate?.userErrors || [];
      if (errors.length) {
        console.warn(
          "Shopify inventoryItemUpdate:",
          errors.map((row) => row.message).join("; "),
        );
      }
    } catch (error) {
      console.warn(
        `Shopify GraphQL inventoryItemUpdate failed for item ${inventoryItemId}:`,
        describeShopifyError(error),
      );
    }
  }

  if (graphql && itemGid && locationGid) {
    try {
      const result = await graphql.request(
        `mutation InventoryActivate($inventoryItemId: ID!, $updates: [InventoryBulkToggleActivationInput!]!) {
          inventoryBulkToggleActivation(
            inventoryItemId: $inventoryItemId
            inventoryItemUpdates: $updates
          ) {
            userErrors { field message }
          }
        }`,
        {
          variables: {
            inventoryItemId: itemGid,
            updates: [{ locationId: locationGid, activate: true }],
          },
        },
      );
      const errors =
        shopifyGraphqlData(result)?.inventoryBulkToggleActivation?.userErrors ||
        [];
      if (errors.length) {
        console.warn(
          "Shopify inventoryBulkToggleActivation:",
          errors.map((row) => row.message).join("; "),
        );
      }
    } catch (error) {
      console.warn(
        `Shopify inventory activate failed for item ${inventoryItemId}:`,
        describeShopifyError(error),
      );
    }
  }

  if (client && itemNumeric && locationId) {
    try {
      await client.post({
        path: "inventory_levels/connect",
        data: {
          location_id: Number(shopifyGidNumericId(locationId)),
          inventory_item_id: itemNumeric,
        },
        type: "application/json",
      });
    } catch (error) {
      const text = JSON.stringify(
        error?.response?.body || error?.message || "",
      ).toLowerCase();
      if (!text.includes("already") && !text.includes("stocked")) {
        console.warn(
          `Shopify inventory_levels/connect failed for item ${inventoryItemId}:`,
          describeShopifyError(error),
        );
      }
    }
  }

  variant.inventory_management = "shopify";
  return true;
}

/**
 * Set a Shopify variant's available inventory at the given location. Enables
 * Shopify inventory tracking on the variant first if needed. Returns true when
 * the level was set. Disables further stock pushes if write_inventory is missing.
 */
async function setShopifyVariantInventory({
  client,
  graphql,
  variant,
  quantity,
  locationId,
}) {
  if (shopifyInventoryWriteUnavailable || !locationId || !variant?.id) {
    return false;
  }
  const inventoryItemId = variant?.inventory_item_id;
  if (!inventoryItemId) {
    return false;
  }
  const available = Math.max(0, Math.round(Number(quantity) || 0));
  const locationNumeric = Number(shopifyGidNumericId(locationId) || locationId);
  const itemNumeric = Number(
    shopifyGidNumericId(inventoryItemId) || inventoryItemId,
  );

  await enableShopifyInventoryItemTracked({
    client,
    graphql,
    variant,
    locationId,
  });

  const graphqlSet = await setShopifyVariantInventoryGraphql(
    graphql,
    variant,
    quantity,
    locationId,
  );
  if (graphqlSet) return true;

  try {
    try {
      await client.post({
        path: "inventory_levels/set",
        data: {
          location_id: locationNumeric,
          inventory_item_id: itemNumeric,
          available,
        },
        type: "application/json",
      });
      return true;
    } catch (setError) {
      const setText = JSON.stringify(
        setError?.response?.body || setError?.message || "",
      ).toLowerCase();
      if (
        setText.includes("not stocked") ||
        setText.includes("not found") ||
        setText.includes("tracking enabled")
      ) {
        await enableShopifyInventoryItemTracked({
          client,
          graphql,
          variant,
          locationId,
        });
        const retryGraphql = await setShopifyVariantInventoryGraphql(
          graphql,
          variant,
          quantity,
          locationId,
        );
        if (retryGraphql) return true;
        try {
          await client.post({
            path: "inventory_levels/connect",
            data: {
              location_id: locationNumeric,
              inventory_item_id: itemNumeric,
            },
            type: "application/json",
          });
        } catch (connectError) {
          const connectText = JSON.stringify(
            connectError?.response?.body || connectError?.message || "",
          ).toLowerCase();
          if (
            !connectText.includes("already") &&
            !connectText.includes("stocked")
          ) {
            throw connectError;
          }
        }
        await client.post({
          path: "inventory_levels/set",
          data: {
            location_id: locationNumeric,
            inventory_item_id: itemNumeric,
            available,
          },
          type: "application/json",
        });
        return true;
      }
      throw setError;
    }
  } catch (error) {
    const text = JSON.stringify(
      error?.response?.body || error?.message || error || "",
    ).toLowerCase();
    if (
      isShopifyInventoryScopeError(error) ||
      text.includes("write_inventory")
    ) {
      shopifyInventoryWriteUnavailable = true;
      console.warn(
        "[shopify sync] write_inventory scope missing — skipping REST stock sync.",
      );
    } else {
      console.warn(
        `Shopify inventory set failed for item ${inventoryItemId}:`,
        describeShopifyError(error),
      );
    }
  }

  return false;
}

async function resolveCompanyDefaultWarehouseId(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid) {
    return null;
  }
  const company = await Company.findOne({
    _id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("warehouse_id default_account_receivable_account")
    .lean();
  const wid = company?.warehouse_id;
  if (wid != null && mongoose.Types.ObjectId.isValid(String(wid))) {
    return coalesceObjectId(wid);
  }
  return null;
}

async function resolveCompanyDefaultArAccountId(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid) return null;
  const company = await Company.findOne({
    _id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("default_account_receivable_account")
    .lean();
  return coalesceObjectId(company?.default_account_receivable_account);
}

/** Set POS warehouse qty to match Shopify (absolute sync, not delta-only on create). */
async function syncShopifyProductWarehouseStock({
  productId,
  companyId,
  warehouseId,
  targetQty,
  userId = null,
}) {
  const target = Math.max(0, roundImportQty(targetQty));
  const filter = WarehouseInventory.activeRowFilter(
    productId,
    warehouseId,
    companyId,
  );
  if (!filter) {
    return { synced: false, reason: "invalid_ids" };
  }

  const row = await WarehouseInventory.findOne(filter)
    .select("quantity")
    .lean();
  const current = row ? Number(row.quantity) || 0 : 0;
  const delta = roundImportQty(target - current);
  if (delta === 0) {
    return { synced: true, unchanged: true, quantity: current };
  }

  await WarehouseInventory.applyQuantityDelta({
    productId,
    warehouseId,
    companyId,
    qtyDelta: delta,
    userId,
    logContext: {
      reference_type: "shopify_import",
      reference_id: String(productId),
    },
  });
  return {
    synced: true,
    unchanged: false,
    quantity: target,
    previous: current,
  };
}

function buildPosFieldsFromShopify(
  remoteProduct,
  variant,
  productPrice,
  productTypeOverride,
) {
  const fields = {
    product_name: String(remoteProduct?.title || "").trim(),
    product_price: productPrice,
    product_description: remoteProduct?.body_html || "",
    product_type:
      productTypeOverride || mapShopifyProductType(remoteProduct?.product_type),
  };

  if (variant?.weight != null && variant.weight !== "") {
    fields.weight = Number(variant.weight);
  }

  return fields;
}

async function ensurePosCategoryByName(
  name,
  { companyId, process, referenceId, stats },
) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const slug = categorySlugFromName(trimmed);
  const integrationId = resolveIntegrationId(process);

  if (referenceId && integrationId) {
    const syncRow = await SyncCategory.findOne({
      integration_id: integrationId,
      company_id: companyId,
      refference_id: String(referenceId),
      deletedAt: null,
    }).lean();
    if (syncRow?.category_id) {
      return coalesceObjectId(syncRow.category_id);
    }
  }

  const existing =
    (await findExistingCategoryByName(trimmed, companyId)) ||
    (await findExistingCategory(trimmed, slug, companyId));

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    if (referenceId) {
      await upsertSyncCategoryMapping({
        categoryId: posId,
        integrationId,
        companyId,
        referenceId,
        createdBy: process.created_by?._id || process.created_by,
      });
    }
    stats.categories_found = (stats.categories_found || 0) + 1;
    return posId;
  }

  const created = await Category.create({
    name: trimmed,
    slug,
    description: trimmed,
    company_id: companyId,
    status: "active",
    isActive: true,
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });
  const posId = coalesceObjectId(created._id);
  if (referenceId) {
    await upsertSyncCategoryMapping({
      categoryId: posId,
      integrationId,
      companyId,
      referenceId,
      createdBy: process.created_by?._id || process.created_by,
    });
  }
  stats.categories_inserted = (stats.categories_inserted || 0) + 1;
  return posId;
}

async function resolvePosCategoryIdsFromShopifyProduct(
  remoteProduct,
  client,
  categoryCtx,
) {
  const posIds = [];
  const seen = new Set();
  const shopifyId = remoteProduct?.id;

  const addPosId = (posId) => {
    if (!posId) {
      return;
    }
    const key = String(posId);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    posIds.push(posId);
  };

  if (shopifyId) {
    try {
      const collectsResponse = await client.get({
        path: "collects",
        query: { product_id: shopifyId, limit: 250 },
      });
      const collects =
        Array.isArray(collectsResponse?.body?.collects) ?
          collectsResponse.body.collects
        : [];

      for (const collect of collects) {
        const collectionId = collect?.collection_id;
        if (!collectionId) {
          continue;
        }

        let collectionTitle = "";
        try {
          const collectionResponse = await client.get({
            path: `custom_collections/${collectionId}`,
          });
          collectionTitle = String(
            collectionResponse?.body?.custom_collection?.title || "",
          ).trim();
        } catch (error) {
          console.warn(
            `Shopify collection ${collectionId} lookup failed:`,
            error?.response?.body || error?.message || error,
          );
        }

        if (!collectionTitle) {
          continue;
        }

        const posId = await ensurePosCategoryByName(collectionTitle, {
          ...categoryCtx,
          referenceId: collectionId,
        });
        addPosId(posId);
      }
    } catch (error) {
      console.warn(
        `Shopify collects lookup failed for product ${shopifyId}:`,
        error?.response?.body || error?.message || error,
      );
    }
  }

  if (posIds.length === 0) {
    const productType = String(remoteProduct?.product_type || "").trim();
    if (productType) {
      const posId = await ensurePosCategoryByName(productType, categoryCtx);
      addPosId(posId);
    }
  }

  return posIds;
}

async function upsertShopifyProductRow({
  remoteProduct,
  variant,
  name,
  sku,
  productType,
  productPrice,
  categoryIds,
  parentProductId,
  companyId,
  process,
  stats,
  shopifyReferenceId,
  isVariation = false,
  warehouseId = null,
  client = null,
}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    return null;
  }

  const categoryField = categoryIds
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  const existing = await findPosProductForShopifyImport({
    process,
    companyId,
    shopifyReferenceId,
    sku,
    name: trimmedName,
  });

  const payload = {
    ...buildPosFieldsFromShopify(
      remoteProduct,
      variant,
      productPrice,
      productType,
    ),
    product_name: trimmedName,
    sku,
    product_code: sku,
    category_id: categoryField,
  };

  if (parentProductId) {
    payload.parent_product_id = coalesceObjectId(parentProductId);
  }

  const barcode = await resolveFetchProductBarcode({
    remoteBarcode: extractShopifyBarcode(variant),
    existingProduct: existing,
    companyId,
    stats,
  });
  const existingHasBarcode = Boolean(String(existing?.barcode || "").trim());
  if (barcode && (!existing || !existingHasBarcode)) {
    payload.barcode = barcode;
  }

  let posId;

  if (existing) {
    posId = coalesceObjectId(existing._id);
    await Product.updateOne({ _id: posId }, { $set: payload });
    if (isVariation) {
      stats.variations_updated = (stats.variations_updated || 0) + 1;
    } else {
      stats.updated = (stats.updated || 0) + 1;
    }
  } else {
    const created = await Product.create({
      ...payload,
      unit: "Piece",
      company_id: companyId,
      status: "active",
      created_by: coalesceObjectId(
        process.created_by?._id || process.created_by,
      ),
    });
    posId = coalesceObjectId(created._id);
    if (isVariation) {
      stats.variations_inserted = (stats.variations_inserted || 0) + 1;
    } else {
      stats.inserted += 1;
    }
  }

  if (shopifyReferenceId) {
    await recordShopifyProductSyncMapping(
      process,
      companyId,
      posId,
      shopifyReferenceId,
      stats,
    );
  }

  if (categoryField.length) {
    stats.products_category_linked = (stats.products_category_linked || 0) + 1;
  }

  await syncShopifyVariantWarehouseStock({
    warehouseId,
    companyId,
    process,
    posId,
    variant,
    client,
    stats,
  });

  const imageUrls = extractShopifyImageUrls(remoteProduct, {
    variant,
    isVariation,
  });
  if (imageUrls.length) {
    await syncFetchProductImages(posId, imageUrls, existing);
  }

  return posId;
}

async function importShopifyVariableProductToPos(
  remoteProduct,
  {
    companyId,
    process,
    stats,
    productPrice,
    categoryIds = [],
    warehouseId = null,
    client = null,
  },
) {
  const shopifyProductId = Number(remoteProduct?.id);
  const parentName = String(remoteProduct?.title || "").trim();
  if (!shopifyProductId || !parentName) {
    return null;
  }

  const variants =
    Array.isArray(remoteProduct?.variants) ? remoteProduct.variants : [];
  stats.variations_fetched = (stats.variations_fetched || 0) + variants.length;

  const parentSku = `shopify-${shopifyProductId}`;

  const variantPrices = variants
    .map((row) => mapShopifyVariantPrice(row))
    .filter((price) => price > 0);
  const parentDisplayPrice =
    variantPrices.length > 0 ? Math.min(...variantPrices) : productPrice;

  const parentPosId = await upsertShopifyProductRow({
    remoteProduct,
    variant: null,
    name: parentName,
    sku: parentSku,
    productType: "Variable",
    productPrice: parentDisplayPrice,
    categoryIds,
    parentProductId: null,
    companyId,
    process,
    stats,
    shopifyReferenceId: String(shopifyProductId),
    isVariation: false,
    warehouseId: null,
    client,
  });

  if (!parentPosId) {
    return null;
  }

  for (const variant of variants) {
    const variantId = Number(variant?.id);
    if (!variantId) {
      continue;
    }

    const variationName = buildShopifyVariationProductName(parentName, variant);
    const variationSku =
      String(variant?.sku || "").trim() ||
      buildShopifyVariationSku(parentSku, shopifyProductId, variantId);
    const variationPrice = mapShopifyVariantPrice(variant);
    const resolvedVariationPrice =
      variationPrice > 0 ? variationPrice : parentDisplayPrice;

    await upsertShopifyProductRow({
      remoteProduct,
      variant,
      name: variationName,
      sku: variationSku,
      productType: "Single",
      productPrice: resolvedVariationPrice,
      categoryIds,
      parentProductId: parentPosId,
      companyId,
      process,
      stats,
      shopifyReferenceId: `${shopifyProductId}:${variantId}`,
      isVariation: true,
      warehouseId,
      client,
    });
  }

  return parentPosId;
}

async function importShopifyProductToPos(
  remoteProduct,
  {
    companyId,
    process,
    stats,
    productPrice,
    categoryIds = [],
    warehouseId = null,
    client = null,
  },
) {
  const shopifyId = Number(remoteProduct?.id);
  const name = String(remoteProduct?.title || "").trim();
  if (!name) {
    return null;
  }

  if (isShopifyVariableProduct(remoteProduct)) {
    return importShopifyVariableProductToPos(remoteProduct, {
      companyId,
      process,
      stats,
      productPrice,
      categoryIds,
      warehouseId,
      client,
    });
  }

  const variant =
    Array.isArray(remoteProduct?.variants) ? remoteProduct.variants[0] : null;
  const sku =
    String(variant?.sku || "").trim() ||
    (shopifyId ? `shopify-${shopifyId}` : "");
  const price =
    productPrice !== undefined ? productPrice : mapShopifyVariantPrice(variant);

  return upsertShopifyProductRow({
    remoteProduct,
    variant,
    name,
    sku,
    productType: "Single",
    productPrice: price,
    categoryIds,
    parentProductId: null,
    companyId,
    process,
    stats,
    shopifyReferenceId: shopifyId ? String(shopifyId) : "",
    isVariation: false,
    warehouseId,
    client,
  });
}

/**
 * Import categories from Shopify into POS (batch).
 */
async function fetch_category(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { limit, offset } = resolveBatchPagination(process);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const query = { limit, order: "id asc" };
      if (offset > 0) {
        query.since_id = offset;
      }

      const listResponse = await client.get({
        path: "custom_collections",
        query,
      });
      const remoteCategories =
        Array.isArray(listResponse?.body?.custom_collections) ?
          listResponse.body.custom_collections
        : [];

      let inserted = 0;
      let skipped = 0;

      for (const remote of remoteCategories) {
        const name = String(remote?.title || "").trim();
        if (!name) {
          skipped += 1;
          continue;
        }

        const existing = await findExistingCategoryByName(name, companyId);
        if (existing) {
          skipped += 1;
          await upsertSyncCategoryMapping({
            categoryId: existing._id,
            integrationId: resolveIntegrationId(process),
            companyId,
            referenceId: remote.id,
            createdBy: process.created_by?._id || process.created_by,
          });
          continue;
        }

        const created = await Category.create({
          name,
          slug: categorySlugFromName(name),
          description: remote.body_html || "",
          company_id: companyId,
          status: "active",
          isActive: remote.published !== false,
          created_by: coalesceObjectId(
            process.created_by?._id || process.created_by,
          ),
        });
        await upsertSyncCategoryMapping({
          categoryId: created._id,
          integrationId: resolveIntegrationId(process),
          companyId,
          referenceId: remote.id,
          createdBy: process.created_by?._id || process.created_by,
        });
        inserted += 1;
      }

      const fetched = remoteCategories.length;
      const isComplete = fetched < limit;
      const lastRemoteId =
        fetched > 0 ? remoteCategories[fetched - 1]?.id : offset;
      const remarks =
        isComplete ?
          `Category import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}. Total processed ${(Number(process.count) || 0) + inserted + skipped}.`
        : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}. Call execute-process again for the next batch.`;

      return finishFetchCategoryBatch(req, res, process, {
        fetched,
        inserted,
        skipped,
        isComplete,
        nextOffset: lastRemoteId || 0,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify category fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to fetch categories from Shopify.",
    );
    return failFetchCategoryBatch(process, res, errorMessage, errorMessage);
  }
}

/**
 * Push one POS product to Shopify.
 */
/**
 * Resolve the "root" product to sync. If a variable parent is passed it's
 * returned as-is; if a variation child is passed, its variable parent is
 * returned so the whole product (with all variants) syncs together.
 */
async function resolveShopifySyncRootProduct(product, companyId) {
  const productId = coalesceObjectId(product?._id);
  if (!productId) {
    return { rootProduct: product };
  }

  if (
    typeof product?.product_type === "string" &&
    product.product_type.toLowerCase() === "variable"
  ) {
    return { rootProduct: product };
  }

  const parentId = coalesceObjectId(product?.parent_product_id);
  if (!parentId || String(parentId) === String(productId)) {
    return { rootProduct: product };
  }

  const parent = await Product.findOne({
    _id: parentId,
    company_id: companyId,
    deletedAt: null,
  }).lean();

  if (
    parent &&
    typeof parent.product_type === "string" &&
    parent.product_type.toLowerCase() === "variable"
  ) {
    return { rootProduct: parent };
  }

  return { rootProduct: product };
}

/** Load the POS variation children (Single products) of a variable parent. */
async function loadPosVariationChildren(parentProductId, companyId) {
  const parentId = coalesceObjectId(parentProductId);
  if (!parentId) {
    return [];
  }

  return Product.find({
    company_id: companyId,
    parent_product_id: parentId,
    deletedAt: null,
    product_type: "Single",
    _id: { $ne: parentId },
  })
    .sort({ product_name: 1 })
    .lean();
}

/** Split a stored Shopify sync reference of the form `productId:variantId`. */
function parseShopifySyncReference(referenceId) {
  const raw = String(referenceId || "").trim();
  if (!raw) {
    return { productId: null, variantId: null };
  }
  if (raw.includes(":")) {
    const [productId, variantId] = raw.split(":");
    return {
      productId: String(productId || "").trim() || null,
      variantId: String(variantId || "").trim() || null,
    };
  }
  return { productId: raw, variantId: null };
}

function shopifyVariantOptionKey(variant) {
  return [variant?.option1, variant?.option2, variant?.option3]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .join("|");
}

function shopifyVariantCombinedLabel(variant) {
  return formatShopifyVariantOptionValue(
    [variant?.option1, variant?.option2, variant?.option3]
      .map((value) => String(value || "").trim())
      .filter((value) => value && value.toLowerCase() !== "default title")
      .join("-"),
  );
}

async function deleteShopifyExtraProductOptions(
  graphql,
  shopifyProductId,
  keepCount = 1,
) {
  if (!graphql || !shopifyProductId) return;
  const productGid = `gid://shopify/Product/${shopifyProductId}`;
  let options = [];
  try {
    const listed = await graphql.request(
      `query ProductOptions($id: ID!) {
        product(id: $id) { options { id name } }
      }`,
      { variables: { id: productGid } },
    );
    options = listed?.data?.product?.options || [];
  } catch (err) {
    console.warn(
      `Failed to list Shopify product options for ${shopifyProductId}:`,
      describeShopifyError(err),
    );
    return;
  }

  const extras = options.slice(Math.max(1, keepCount)).filter((row) => row?.id);
  if (!extras.length) return;

  try {
    const result = await graphql.request(
      `mutation ProductOptionsDelete($productId: ID!, $options: [ID!]!) {
        productOptionsDelete(productId: $productId, options: $options, strategy: FORCE) {
          deletedOptionsIds
          userErrors { field message }
        }
      }`,
      {
        variables: {
          productId: productGid,
          options: extras.map((row) => row.id),
        },
      },
    );
    const errors = result?.data?.productOptionsDelete?.userErrors || [];
    if (errors.length) {
      console.warn(
        "Shopify productOptionsDelete:",
        errors.map((row) => row.message).join("; "),
      );
    }
  } catch (err) {
    if (isShopifyAuthError(err)) throw err;
    console.warn(
      `Failed to delete extra Shopify options for product ${shopifyProductId}:`,
      describeShopifyError(err),
    );
  }
}

function isDefaultShopifyVariant(variant) {
  const option1 = String(variant?.option1 || "")
    .trim()
    .toLowerCase();
  return !option1 || option1 === "default title";
}

function buildShopifyVariantWritePayload(
  child,
  integration,
  optionFields,
  { mode, syncRow, quantity } = {},
) {
  const payload = {
    ...(buildShopifyVariantSyncPayload(child, integration, {
      mode,
      syncRow,
    }) || {}),
    ...(optionFields || {}),
  };
  const sku = resolvePosProductSku(child);
  if (sku) payload.sku = sku;
  payload.inventory_management = "shopify";
  if (
    mode === "create" &&
    quantity != null &&
    Number.isFinite(Number(quantity))
  ) {
    payload.inventory_quantity = Math.max(0, Math.round(Number(quantity)));
  }
  return payload;
}

/**
 * Push a variable POS product to Shopify: create the parent if needed, then
 * create/update a Shopify variant for every POS child.
 */
async function syncShopifyVariableProductToStore(
  req,
  res,
  process,
  { client, graphql, integration, parentProduct, companyId, integrationId },
) {
  const parentId = coalesceObjectId(parentProduct._id);
  const parentSku = resolvePosProductSku(parentProduct);

  const children = await loadPosVariationChildren(parentId, companyId);
  const childIds = children
    .map((row) => coalesceObjectId(row._id))
    .filter(Boolean);

  const stockSyncEnabled = isIntegrationSyncEnabled(
    integration,
    "sync_product_stock",
  );
  const childStockTotals = await resolveShopifyStockTotals(childIds, companyId);

  const syncRows = await SyncProduct.find({
    integration_id: integrationId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
    product_id: { $in: [parentId, ...childIds] },
  }).lean();

  const parentSyncRow = syncRows.find(
    (row) => String(row.product_id) === String(parentId),
  );
  const childSyncByProductId = new Map(
    syncRows
      .filter((row) => String(row.product_id) !== String(parentId))
      .map((row) => [String(row.product_id), row]),
  );

  const { options: shopifyOptions, variantOptionsByChildId } =
    buildShopifyVariableOptionPlan(children, parentSku);

  const stats = {
    variations_updated: 0,
    variations_created: 0,
    variations_skipped: 0,
    variations_unmatched: 0,
    inventory_updated: 0,
  };

  // Resolve the Shopify product id from the parent mapping, then any child
  // mapping, then finally by looking up a known SKU on Shopify.
  let shopifyProductId =
    parseShopifySyncReference(parentSyncRow?.refference_id).productId || null;
  if (!shopifyProductId) {
    for (const row of syncRows) {
      const pid = parseShopifySyncReference(row?.refference_id).productId;
      if (pid) {
        shopifyProductId = pid;
        break;
      }
    }
  }

  let remoteParent = null;
  if (shopifyProductId) {
    try {
      const resp = await client.get({ path: `products/${shopifyProductId}` });
      remoteParent = resp?.body?.product || null;
    } catch (err) {
      if (isShopifyAuthError(err)) throw err;
      console.warn(
        `Shopify parent ${shopifyProductId} not found; will try SKU lookup:`,
        describeShopifyError(err),
      );
      shopifyProductId = null;
      remoteParent = null;
    }
  }

  if (!remoteParent) {
    const skuCandidates = [
      parentSku,
      ...children.map((c) => resolvePosProductSku(c)),
    ].filter(Boolean);
    const foundId = await findShopifyProductIdByExactSkus(
      graphql,
      skuCandidates,
    );
    if (foundId) {
      const ownedByOther = await isShopifyProductMappedToOtherPosProduct({
        shopifyProductId: foundId,
        integrationId,
        companyId,
        allowedPosProductIds: [parentId, ...childIds],
      });
      if (!ownedByOther) {
        try {
          const resp = await client.get({ path: `products/${foundId}` });
          remoteParent = resp?.body?.product || null;
          if (remoteParent) shopifyProductId = foundId;
        } catch (err) {
          if (isShopifyAuthError(err)) throw err;
          console.warn(
            `Shopify parent ${foundId} from SKU lookup not found:`,
            describeShopifyError(err),
          );
          shopifyProductId = null;
          remoteParent = null;
        }
      }
    }
  }

  let productFieldsPayload = null;
  if (!remoteParent || !shopifyProductId) {
    if (!children.length) {
      await markProcessOutcome(
        process._id,
        "failed",
        `Failed to sync Product Name : ${parentProduct.product_name} to Shopify — no variation children found.`,
      );
      return res.status(400).json({
        success: false,
        message: `Variable product "${parentProduct.product_name}" has no child products to sync.`,
      });
    }

    const createPayload = buildShopifyProductSyncPayload(
      parentProduct,
      integration,
      { mode: "create", syncRow: parentSyncRow },
    );
    productFieldsPayload = createPayload;
    if (!createPayload.title) {
      createPayload.title =
        parentProduct.product_name || parentSku || "Product";
    }

    const createdVariants = children.map((child) =>
      buildShopifyVariantWritePayload(
        child,
        integration,
        variantOptionsByChildId.get(String(child._id)) || {},
        {
          mode: "create",
          syncRow: childSyncByProductId.get(String(child._id)),
          quantity: syncStockQuantity(childStockTotals, child._id),
        },
      ),
    );

    const createdResponse = await client.post({
      path: "products",
      data: {
        product: {
          ...createPayload,
          status: createPayload.status || "active",
          options: shopifyOptions,
          variants: createdVariants,
        },
      },
      type: "application/json",
    });
    remoteParent = createdResponse?.body?.product || null;
    shopifyProductId =
      remoteParent?.id != null ? String(remoteParent.id) : null;
    if (!shopifyProductId) {
      throw new Error(
        "Shopify did not return a product id for the variable parent.",
      );
    }
  } else {
    const parentUpdatePayload = buildShopifyProductSyncPayload(
      parentProduct,
      integration,
      { mode: "update", syncRow: parentSyncRow },
    );
    productFieldsPayload = parentUpdatePayload;
    if (hasSyncPayloadFields(parentUpdatePayload)) {
      const updatedResponse = await client.put({
        path: `products/${shopifyProductId}`,
        data: {
          product: { ...parentUpdatePayload, id: shopifyProductId },
        },
        type: "application/json",
      });
      remoteParent = updatedResponse?.body?.product || remoteParent;
    }
  }

  await replaceShopifyProductImages(
    client,
    shopifyProductId,
    parentProduct,
    integration,
  );
  await recordShopifyProductSyncMapping(
    process,
    companyId,
    parentId,
    shopifyProductId,
  );

  const remoteVariants =
    Array.isArray(remoteParent?.variants) ? [...remoteParent.variants] : [];
  const usedVariantIds = new Set();
  let locationId = null;
  let stockSkipReason = "";
  if (stockSyncEnabled) {
    locationId = await resolveShopifyPrimaryLocationId(
      client,
      graphql,
      remoteVariants.map((row) => row?.inventory_item_id).filter(Boolean),
    );
    if (!locationId) {
      stockSkipReason = "no Shopify location";
    }
  }

  const takeMatchingVariant = (child, childSyncRow, optionFields) => {
    const childSku = resolvePosProductSku(child);
    const optionKey = shopifyVariantOptionKey(optionFields);
    const refVariantId = parseShopifySyncReference(
      childSyncRow?.refference_id,
    ).variantId;

    const unused = () =>
      remoteVariants.filter((row) => !usedVariantIds.has(String(row.id)));

    if (refVariantId) {
      const byRef = unused().find(
        (row) => String(row.id) === String(refVariantId),
      );
      if (byRef) return byRef;
    }
    if (childSku) {
      const skuKey = String(childSku).trim().toLowerCase();
      const bySku = unused().find(
        (row) =>
          String(row.sku || "")
            .trim()
            .toLowerCase() === skuKey,
      );
      if (bySku) return bySku;
    }
    if (optionKey) {
      const byOptions = unused().find(
        (row) => shopifyVariantOptionKey(row) === optionKey,
      );
      if (byOptions) return byOptions;
    }
    const wanted = formatShopifyVariantOptionValue(optionFields?.option1);
    if (wanted) {
      const byCombined = unused().find(
        (row) => shopifyVariantCombinedLabel(row) === wanted,
      );
      if (byCombined) return byCombined;
    }
    return (
      unused().find((row) => isDefaultShopifyVariant(row)) ||
      (unused().length === 1 ? unused()[0] : null)
    );
  };

  for (const child of children) {
    try {
      const childId = coalesceObjectId(child._id);
      const childSyncRow = childSyncByProductId.get(String(child._id)) || null;
      const optionFields = variantOptionsByChildId.get(String(child._id)) || {};
      let variant = takeMatchingVariant(child, childSyncRow, optionFields);
      const childQty = syncStockQuantity(childStockTotals, child._id);
      const variantPayload = buildShopifyVariantWritePayload(
        child,
        integration,
        optionFields,
        {
          mode: variant?.id ? "update" : "create",
          syncRow: childSyncRow,
          quantity: childQty,
        },
      );

      if (variant?.id) {
        const updated = await client.put({
          path: `variants/${variant.id}`,
          data: { variant: { ...variantPayload, id: variant.id } },
          type: "application/json",
        });
        variant = updated?.body?.variant || variant;
        usedVariantIds.add(String(variant.id));
        stats.variations_updated += 1;
      } else {
        const created = await client.post({
          path: `products/${shopifyProductId}/variants`,
          data: { variant: variantPayload },
          type: "application/json",
        });
        variant = created?.body?.variant || null;
        if (!variant?.id) {
          stats.variations_unmatched += 1;
          continue;
        }
        remoteVariants.push(variant);
        usedVariantIds.add(String(variant.id));
        stats.variations_created += 1;
      }

      await enableShopifyInventoryItemTracked({
        client,
        graphql,
        variant,
        locationId,
      });

      if (stockSyncEnabled) {
        const variantLocationId =
          locationId ||
          (await resolveShopifyVariantLocation(client, graphql, variant));
        if (variantLocationId) {
          locationId = variantLocationId;
          stockSkipReason = "";
          const inventorySet = await setShopifyVariantInventory({
            client,
            graphql,
            variant,
            quantity: childQty,
            locationId: variantLocationId,
          });
          if (inventorySet) {
            stats.inventory_updated += 1;
          } else if (!stockSkipReason) {
            stockSkipReason = "inventory write failed";
          }
        } else if (!stockSkipReason) {
          stockSkipReason = "no Shopify location";
        }
      }

      await recordShopifyProductSyncMapping(
        process,
        companyId,
        childId,
        `${shopifyProductId}:${variant.id}`,
      );
    } catch (error) {
      console.error(
        `Failed to sync Shopify variation for POS product ${child._id} (${child.product_name}):`,
        describeShopifyError(error),
      );
      stats.variations_skipped += 1;
    }
  }

  await deleteShopifyExtraProductOptions(
    graphql,
    shopifyProductId,
    shopifyOptions.length || 1,
  );

  if (shopifyOptions[0]) {
    try {
      const refreshed = await client.get({
        path: `products/${shopifyProductId}`,
      });
      const current = refreshed?.body?.product || {};
      const currentOptions =
        Array.isArray(current.options) ? current.options : [];
      const currentVariants =
        Array.isArray(current.variants) ? current.variants : [];
      const keepOption = currentOptions[0];
      if (keepOption?.id && currentVariants.length) {
        await client.put({
          path: `products/${shopifyProductId}`,
          data: {
            product: {
              id: shopifyProductId,
              options: [
                {
                  id: keepOption.id,
                  name: shopifyOptions[0].name,
                  values: shopifyOptions[0].values,
                },
              ],
              variants: currentVariants.map((row) => ({
                id: row.id,
                option1: row.option1,
              })),
            },
          },
          type: "application/json",
        });
      }
    } catch (err) {
      if (isShopifyAuthError(err)) throw err;
      console.warn(
        `Failed to rename Shopify options for product ${shopifyProductId}:`,
        describeShopifyError(err),
      );
    }
  }

  if (
    productFieldsPayload &&
    Object.prototype.hasOwnProperty.call(productFieldsPayload, "body_html")
  ) {
    await pushShopifyProductDescriptionHtml(
      graphql,
      shopifyProductId,
      productFieldsPayload.body_html,
    );
  }

  const qtyFieldRemark = formatSyncStockFieldRemark(childStockTotals, childIds);
  const variantsTouched =
    Number(stats.variations_created || 0) +
    Number(stats.variations_updated || 0);
  const stockRemark =
    stats.inventory_updated > 0 || !stockSkipReason ?
      `stock updated ${stats.inventory_updated}`
    : `stock updated ${stats.inventory_updated} (${stockSkipReason})`;
  const remarks =
    `Product Name : ${parentProduct.product_name} synced to Shopify ` +
    `(product ${shopifyProductId}, variants updated ${variantsTouched}, ` +
    `${stockRemark}, skipped ${stats.variations_skipped}, ` +
    `unmatched ${stats.variations_unmatched}, ${qtyFieldRemark}). ` +
    formatProductSyncFieldRemarks(integration);

  await markProcessOutcome(process._id, "completed", remarks);

  return res.status(200).json({
    success: true,
    data: {
      shopify_product_id: shopifyProductId,
      ...stats,
      variation_count: children.length,
    },
    message: remarks,
  });
}

async function sync_product(req, res, process) {
  const integration = process?.integration_id;
  const product = process?.product_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!product) {
    return res.status(400).json({
      success: false,
      message: "Product details are missing from the process payload.",
    });
  }

  const sku = resolvePosProductSku(product);
  if (!sku) {
    return res.status(400).json({
      success: false,
      message: "Product SKU or identifier is required to sync with Shopify.",
    });
  }

  const companyId = resolveCompanyId(process);
  const integrationId = resolveIntegrationId(process);
  const productId = coalesceObjectId(product._id);

  try {
    resetShopifyInventorySyncFlags();
    return await runWithShopifyClient(
      integration,
      process,
      async (client, _active, graphql) => {
        const { rootProduct } = await resolveShopifySyncRootProduct(
          product,
          companyId,
        );

        if (
          typeof rootProduct?.product_type === "string" &&
          rootProduct.product_type.toLowerCase() === "variable"
        ) {
          try {
            return await syncShopifyVariableProductToStore(req, res, process, {
              client,
              graphql,
              integration,
              parentProduct: rootProduct,
              companyId,
              integrationId,
            });
          } catch (error) {
            if (isShopifyAuthError(error)) throw error;
            const detail = describeShopifyError(error);
            console.error(
              `Shopify variable product sync failed for "${rootProduct.product_name}":`,
              detail,
            );
            await markProcessOutcome(
              process._id,
              "failed",
              `Failed to sync Product Name : ${rootProduct.product_name} to Shopify — ${detail}`,
            );
            return res.status(500).json({
              success: false,
              message: detail,
              detail,
            });
          }
        }

        const syncRow = await SyncProduct.findOne({
          product_id: productId,
          integration_id: integrationId,
          company_id: companyId,
          status: "active",
          deletedAt: null,
        }).lean();

        let step = "init";
        try {
          let remoteProduct = null;
          let remoteId =
            (
              syncRow?.refference_id != null &&
              String(syncRow.refference_id).trim() !== ""
            ) ?
              String(syncRow.refference_id).trim()
            : null;

          if (remoteId) {
            try {
              step = `GET products/${remoteId}`;
              const productResponse = await client.get({
                path: `products/${remoteId}`,
              });
              remoteProduct = productResponse?.body?.product || null;
            } catch (fetchErr) {
              if (isShopifyAuthError(fetchErr)) throw fetchErr;
              console.warn(
                `Shopify product ${remoteId} not found; will try SKU lookup:`,
                describeShopifyError(fetchErr),
              );
              remoteId = null;
            }
          }

          if (!remoteProduct) {
            step = `GraphQL productVariants sku=${sku}`;
            const foundId = await findShopifyProductIdByExactSku(graphql, sku);
            if (foundId) {
              const ownedByOther =
                await isShopifyProductMappedToOtherPosProduct({
                  shopifyProductId: foundId,
                  integrationId,
                  companyId,
                  allowedPosProductIds: [productId],
                });
              if (!ownedByOther) {
                try {
                  step = `GET products/${foundId} (via variant SKU)`;
                  const productResponse = await client.get({
                    path: `products/${foundId}`,
                  });
                  remoteProduct = productResponse?.body?.product || null;
                  if (remoteProduct) remoteId = foundId;
                } catch (fetchErr) {
                  if (isShopifyAuthError(fetchErr)) throw fetchErr;
                  console.warn(
                    "Failed to load Shopify product by variant SKU:",
                    describeShopifyError(fetchErr),
                  );
                }
              }
            }
          }

          if (remoteProduct && remoteId) {
            const updatePayload = buildShopifyProductSyncPayload(
              product,
              integration,
              { mode: "update", syncRow },
            );
            const variantPayload = buildShopifyVariantSyncPayload(
              product,
              integration,
              { mode: "update", syncRow },
            );
            const stockSyncEnabled = isIntegrationSyncEnabled(
              integration,
              "sync_product_stock",
            );

            if (
              !hasSyncPayloadFields(updatePayload) &&
              !variantPayload &&
              !stockSyncEnabled
            ) {
              const keepVariant = remoteProduct?.variants?.[0] || null;
              if (keepVariant?.id) {
                await enableShopifyInventoryItemTracked({
                  client,
                  graphql,
                  variant: keepVariant,
                });
              }
              await recordShopifyProductSyncMapping(
                process,
                companyId,
                productId,
                remoteId,
              );
              await markProcessOutcome(
                process._id,
                "completed",
                `Product Name : ${product.product_name} — no Shopify fields enabled for update.`,
              );
              return res.status(200).json({
                success: true,
                data: remoteProduct,
                message: `Product Name : ${product.product_name} — sync mapping kept; no fields enabled.`,
              });
            }

            let updatedProduct = remoteProduct;
            if (hasSyncPayloadFields(updatePayload)) {
              step = `PUT products/${remoteId}`;
              const updatedResponse = await client.put({
                path: `products/${remoteId}`,
                data: { product: updatePayload },
                type: "application/json",
              });
              updatedProduct = updatedResponse?.body?.product || updatedProduct;
              if (
                Object.prototype.hasOwnProperty.call(updatePayload, "body_html")
              ) {
                await pushShopifyProductDescriptionHtml(
                  graphql,
                  remoteId,
                  updatePayload.body_html,
                );
              }
            }

            const singleVariant =
              updatedProduct?.variants?.[0] ||
              remoteProduct?.variants?.[0] ||
              null;

            if (variantPayload && singleVariant?.id) {
              step = `PUT variants/${singleVariant.id}`;
              const updatedVariant = await client.put({
                path: `variants/${singleVariant.id}`,
                data: {
                  variant: {
                    ...variantPayload,
                    sku,
                    id: singleVariant.id,
                    inventory_management: "shopify",
                  },
                },
                type: "application/json",
              });
              if (updatedVariant?.body?.variant) {
                Object.assign(singleVariant, updatedVariant.body.variant);
              }
            }

            if (singleVariant?.id) {
              const locationId = await resolveShopifyPrimaryLocationId(
                client,
                graphql,
                [singleVariant.inventory_item_id],
              );
              await enableShopifyInventoryItemTracked({
                client,
                graphql,
                variant: singleVariant,
                locationId,
              });
            }

            let stockTotals = new Map();
            if (stockSyncEnabled && singleVariant?.id) {
              stockTotals = await resolveShopifyStockTotals(
                [productId],
                companyId,
              );
              const locationId = await resolveShopifyVariantLocation(
                client,
                graphql,
                singleVariant,
              );
              if (locationId) {
                step = `SET inventory for variant ${singleVariant.id}`;
                await setShopifyVariantInventory({
                  client,
                  graphql,
                  variant: singleVariant,
                  quantity: syncStockQuantity(stockTotals, productId),
                  locationId,
                });
              }
            }

            await recordShopifyProductSyncMapping(
              process,
              companyId,
              productId,
              remoteId,
            );

            step = `REPLACE images for product ${remoteId}`;
            await replaceShopifyProductImages(
              client,
              remoteId,
              product,
              integration,
            );

            const updateRemarks =
              `Product Name : ${product.product_name} updated on Shopify` +
              (stockTotals.size ?
                ` (${formatSyncStockFieldRemark(stockTotals, productId)}). `
              : ". ") +
              formatProductSyncFieldRemarks(integration);

            await markProcessOutcome(process._id, "completed", updateRemarks);

            return res.status(200).json({
              success: true,
              data: updatedProduct,
              message: updateRemarks,
            });
          }

          const variantPayload = buildShopifyVariantSyncPayload(
            product,
            integration,
            {
              mode: "create",
              syncRow,
            },
          ) || {
            price: resolveSyncProductPrice(product, syncRow),
            sku,
          };
          if (!variantPayload.sku) variantPayload.sku = sku;
          variantPayload.inventory_management = "shopify";

          const createPayload = buildShopifyProductSyncPayload(
            product,
            integration,
            {
              mode: "create",
              syncRow,
            },
          );
          if (!createPayload.title) {
            createPayload.title = product.product_name || sku;
          }

          step = "POST products";
          const createdProductResponse = await client.post({
            path: "products",
            data: {
              product: {
                ...createPayload,
                status: createPayload.status || "active",
                variants: [variantPayload],
              },
            },
            type: "application/json",
          });

          const createdProduct = createdProductResponse?.body?.product;
          const createdId = createdProduct?.id;
          if (
            createdId &&
            Object.prototype.hasOwnProperty.call(createPayload, "body_html")
          ) {
            await pushShopifyProductDescriptionHtml(
              graphql,
              createdId,
              createPayload.body_html,
            );
          }
          const createdVariant = createdProduct?.variants?.[0] || null;
          if (createdVariant?.id) {
            await enableShopifyInventoryItemTracked({
              client,
              graphql,
              variant: createdVariant,
            });
          }
          await recordShopifyProductSyncMapping(
            process,
            companyId,
            productId,
            createdId,
          );

          if (createdId) {
            step = `REPLACE images for product ${createdId}`;
            await replaceShopifyProductImages(
              client,
              createdId,
              product,
              integration,
            );
          }

          const createRemarks =
            `Product Name : ${product.product_name} created on Shopify. ` +
            formatProductSyncFieldRemarks(integration);

          await markProcessOutcome(
            process._id,
            "completed",
            createRemarks,
          );

          return res.status(201).json({
            success: true,
            data: createdProduct,
            message: createRemarks,
          });
        } catch (error) {
          if (isShopifyAuthError(error)) throw error;
          const detail = describeShopifyError(error);
          console.error(
            `Shopify product sync failed [step: ${step}] for "${product.product_name}" (sku=${sku}):`,
            detail,
          );

          await markProcessOutcome(
            process._id,
            "failed",
            `Failed to sync Product Name : ${product.product_name} to Shopify [step: ${step}] — ${detail}`,
          );

          const errorMessage = formatShopifyErrorPayload(
            error,
            `Failed to sync Product Name : ${product.product_name} to Shopify.`,
          );

          return res.status(500).json({
            success: false,
            step,
            message: errorMessage,
            detail,
            error: errorMessage,
          });
        }
      },
    );
  } catch (error) {
    const errorMessage = formatShopifyErrorPayload(
      error,
      `Failed to sync Product Name : ${product.product_name} to Shopify.`,
    );
    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: errorMessage,
    });
  }
}

/**
 * Push one POS category to Shopify.
 */
async function sync_category(req, res, process) {
  const integration = process?.integration_id;
  const category = process?.category_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!category) {
    return res.status(400).json({
      success: false,
      message:
        "Category is required for sync_category. Set category_id on the process (Admin → Process) or pass ?category_id=<id> on execute-process.",
    });
  }

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const title = category.name?.trim();
      if (!title) {
        return res.status(400).json({
          success: false,
          message: "Category name is required to sync with Shopify.",
        });
      }

      const companyId = resolveCompanyId(process);
      const listResponse = await client.get({
        path: "custom_collections",
        query: { title },
      });
      const existing =
        Array.isArray(listResponse?.body?.custom_collections) ?
          listResponse.body.custom_collections
        : [];

      if (existing.length > 0) {
        await upsertSyncCategoryMapping({
          categoryId: category._id,
          integrationId: resolveIntegrationId(process),
          companyId,
          referenceId: existing[0].id,
          createdBy: process.created_by?._id || process.created_by,
        });

        await markProcessOutcome(
          process._id,
          "completed",
          `Category : ${title} already existed on Shopify — skipped creation.`,
        );

        return res.status(200).json({
          success: true,
          data: existing[0],
          message: `Category : ${title} already exists on Shopify.`,
        });
      }

      const createdResponse = await client.post({
        path: "custom_collections",
        data: {
          custom_collection: {
            title,
            body_html: category.description || "",
            published: category.isActive !== false,
          },
        },
        type: "application/json",
      });

      const createdCollection =
        createdResponse?.body?.custom_collection || createdResponse?.body;

      await upsertSyncCategoryMapping({
        categoryId: category._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId: createdCollection?.id,
        createdBy: process.created_by?._id || process.created_by,
      });

      await markProcessOutcome(
        process._id,
        "completed",
        `Category : ${title} created on Shopify.`,
      );

      return res.status(201).json({
        success: true,
        data: createdCollection,
        message: `Category : ${title} synced to Shopify successfully.`,
      });
    });
  } catch (error) {
    console.error(
      "Shopify category sync failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Category : ${category.name} to Shopify.`,
    );

    const errorMessage = formatShopifyErrorPayload(
      error,
      `Failed to sync Category : ${category.name} to Shopify.`,
    );

    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: errorMessage,
    });
  }
}

/**
 * Import product vendors from Shopify as POS brands (batch). Store → POS.
 */
async function fetch_brand(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { limit, offset, page } = resolveBatchPagination(process);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const query = { limit, fields: "id,vendor", order: "id asc" };
      if (offset > 0) {
        query.since_id = offset;
      }

      const listResponse = await client.get({ path: "products", query });
      const products =
        Array.isArray(listResponse?.body?.products) ?
          listResponse.body.products
        : [];

      const vendorByKey = new Map();
      for (const product of products) {
        const vendor = String(product?.vendor || "").trim();
        if (vendor) {
          vendorByKey.set(vendor.toLowerCase(), vendor);
        }
      }

      let inserted = 0;
      let skipped = 0;
      let sync_brand_mapped = 0;

      for (const name of vendorByKey.values()) {
        const slug = categorySlugFromName(name);
        const referenceId = `vendor:${slug}`;
        const existing = await findExistingBrand(name, slug, companyId);

        if (existing) {
          skipped += 1;
          const mapped = await upsertSyncBrandMapping({
            brandId: existing._id,
            integrationId: resolveIntegrationId(process),
            companyId,
            referenceId,
            createdBy: process.created_by?._id || process.created_by,
          });
          if (mapped) {
            sync_brand_mapped += 1;
          }
          continue;
        }

        const created = await Brand.create({
          name,
          slug,
          description: name,
          company_id: companyId,
          status: "active",
          created_by: coalesceObjectId(
            process.created_by?._id || process.created_by,
          ),
        });
        inserted += 1;
        const mapped = await upsertSyncBrandMapping({
          brandId: created._id,
          integrationId: resolveIntegrationId(process),
          companyId,
          referenceId,
          createdBy: process.created_by?._id || process.created_by,
        });
        if (mapped) {
          sync_brand_mapped += 1;
        }
      }

      const fetched = products.length;
      const isComplete = fetched < limit;
      const lastRemoteId = fetched > 0 ? products[fetched - 1]?.id : offset;
      const remarks =
        isComplete ?
          `Brand import completed: products scanned ${fetched}, vendors inserted ${inserted}, skipped ${skipped}, sync mapped ${sync_brand_mapped}.`
        : `Batch complete: products scanned ${fetched}, vendors inserted ${inserted}, skipped ${skipped}. Call execute-process again for page ${page + 1}.`;

      return finishFetchBrandBatch(req, res, process, {
        fetched,
        inserted,
        skipped,
        sync_brand_mapped,
        isComplete,
        nextOffset: lastRemoteId || 0,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify brand fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to fetch brands from Shopify product vendors.",
    );
    return failFetchBrandBatch(process, res, errorMessage, errorMessage);
  }
}

async function importShopifyOrderToPos(remoteOrder, ctx) {
  const { companyId, process, stats, req } = ctx;
  const logCtx = { req, process, companyId };
  const integrationId = resolveIntegrationId(process);
  const remoteId = remoteOrder?.id;
  const externalRef = orderExternalRef("shopify", remoteId);
  const integrationOrderId = resolveIntegrationOrderId(
    "shopify",
    remoteOrder,
    remoteId,
  );

  if (!externalRef) {
    recordOrderSkip(
      stats,
      {
        store: "shopify",
        remote_id: remoteId,
        order_number: remoteOrder?.order_number,
        reason: "missing_remote_id",
        detail: "Shopify order has no id",
      },
      logCtx,
    );
    return;
  }

  const existing = await findExistingImportedOrder(companyId, {
    externalRef,
    integrationId,
    integrationOrderId,
  });
  if (existing) {
    if (!existing.customer_id) {
      const billing = remoteOrder?.billing_address || {};
      const shipping = remoteOrder?.shipping_address || {};
      const customer = remoteOrder?.customer || {};
      const customerName = [billing.first_name, billing.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const shippingName = [shipping.first_name, shipping.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const resolvedName =
        customerName ||
        shippingName ||
        [customer.first_name, customer.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        existing.name ||
        "";
      const backfillCustomerId = await findOrCreatePosCustomerFromBilling({
        name: resolvedName,
        email:
          remoteOrder?.email ||
          customer.email ||
          billing.email ||
          shipping.email ||
          existing.email ||
          "",
        phone:
          billing.phone ||
          shipping.phone ||
          customer.phone ||
          existing.phone ||
          "",
        companyId,
        createdBy: process.created_by?._id || process.created_by,
      });
      if (backfillCustomerId) {
        await Order.updateOne(
          { _id: existing._id },
          { $set: { customer_id: backfillCustomerId } },
        );
      }
    }
    const backfill = await backfillPosOrderLinesIfEmpty(
      existing,
      remoteOrder,
      "shopify",
      ctx,
    );
    if (backfill?.backfilled) {
      stats.updated = (stats.updated || 0) + 1;
      return;
    }
    recordOrderSkip(
      stats,
      {
        store: "shopify",
        remote_id: remoteId,
        order_number: remoteOrder?.order_number,
        reason: "already_imported",
        detail:
          existing.order_no ?
            `POS ${existing.order_no}`
          : `POS order ${existing._id}`,
      },
      logCtx,
    );
    return;
  }

  const {
    orderItemsPayload,
    linesSubtotal,
    linesSkipped,
    remoteBillableLines,
  } = await buildPosOrderLineItemsFromRemote(remoteOrder, "shopify", ctx);

  const billing = remoteOrder?.billing_address || {};
  const shipping = remoteOrder?.shipping_address || {};
  const customer = remoteOrder?.customer || {};
  const customerName = [billing.first_name, billing.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const shippingName = [shipping.first_name, shipping.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const resolvedName =
    customerName ||
    shippingName ||
    [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim();
  const customerEmail =
    remoteOrder?.email ||
    customer.email ||
    billing.email ||
    shipping.email ||
    "";
  const customerPhone = billing.phone || shipping.phone || customer.phone || "";

  const discount = Number(remoteOrder?.total_discounts) || 0;
  const shipment =
    Number(remoteOrder?.total_shipping_price_set?.shop_money?.amount) ||
    Number(remoteOrder?.total_shipping_price_set?.presentment_money?.amount) ||
    0;

  const customerId = await findOrCreatePosCustomerFromBilling({
    name: resolvedName,
    email: customerEmail,
    phone: customerPhone,
    companyId,
    createdBy: process.created_by?._id || process.created_by,
  });

  const addressFields = mapRemoteOrderAddressFields(remoteOrder, "shopify");

  const orderPayload = {
    name: resolvedName || `Shopify #${remoteOrder?.order_number || remoteId}`,
    email: customerEmail,
    phone: customerPhone,
    address: addressFields.address,
    city: addressFields.city,
    state: addressFields.state,
    zip: addressFields.zip,
    country: addressFields.country,
    description: externalRef,
    integration_order_id: integrationOrderId,
    discount,
    shipment,
    lines_subtotal: linesSubtotal,
    amount_received: Number(remoteOrder?.total_price) || 0,
    order_status: resolveFetchOrderImportStatus({
      linesSkipped,
      linesInserted: orderItemsPayload.length,
      remoteBillableLines,
      remoteOrder,
      store: "shopify",
    }),
    order_type: "website",
    order_website_status: resolveOrderWebsiteStatus(remoteOrder, "shopify"),
    transaction_number: generateTransactionNumber(),
    integration_id: integrationId,
    company_id: companyId,
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
    status: "active",
  };
  const arAccountId = await resolveCompanyDefaultArAccountId(companyId);
  if (arAccountId) {
    orderPayload.payment_method_accounts_id = arAccountId;
  }
  if (customerId) {
    orderPayload.customer_id = customerId;
  }

  const order = await Order.create(orderPayload);

  await recordOrderStatusUpdate({
    orderId: order._id,
    orderStatus: order.order_status || orderPayload.order_status || "placed",
    companyId,
    userId: orderPayload.created_by,
  });

  for (const item of orderItemsPayload) {
    await OrderItem.create({ ...item, order_id: order._id });
    stats.lines_inserted += 1;
  }

  if (orderItemsPayload.length > 0) {
    await applyFetchOrderOutboundInventory({
      req,
      process,
      companyId,
      order,
      lines: orderItemsPayload.map((item) => ({
        product_id: item.product_id,
        qty: item.qty,
        price: item.price,
      })),
      store: "shopify",
      stats,
    });
  }

  stats.inserted += 1;

  if (req) {
    void logFetchOrderImported(req, {
      process,
      companyId,
      store: "shopify",
      remoteId,
      orderNumber: remoteOrder?.order_number,
      posOrderId: order._id,
      posOrderNo: order.order_no,
      lineCount: orderItemsPayload.length,
    });
  }
}

/**
 * Pull one Shopify order into POS — update if already imported, else insert.
 */
async function pullShopifyOrderToPos(remoteOrder, ctx) {
  const { companyId, process, stats, req } = ctx;
  const logCtx = { req, process, companyId };
  const integrationId = resolveIntegrationId(process);
  const remoteId = remoteOrder?.id;
  const externalRef = orderExternalRef("shopify", remoteId);
  const integrationOrderId = resolveIntegrationOrderId(
    "shopify",
    remoteOrder,
    remoteId,
  );

  if (!externalRef) {
    recordOrderSkip(
      stats,
      {
        store: "shopify",
        remote_id: remoteId,
        order_number: remoteOrder?.order_number,
        reason: "missing_remote_id",
        detail: "Shopify order has no id",
      },
      logCtx,
    );
    return;
  }

  const existing = await findExistingImportedOrder(companyId, {
    externalRef,
    integrationId,
    integrationOrderId,
  });

  if (existing) {
    await updatePosOrderFromRemote(existing, remoteOrder, "shopify", {
      companyId,
      process,
      integrationId,
    });
    stats.updated += 1;
    return;
  }

  await importShopifyOrderToPos(remoteOrder, ctx);
}

/**
 * Pull orders from Shopify into POS (batch or single). Updates existing POS rows.
 */
async function pull_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  const posOrder = process?.order_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const orderFields =
    "id,order_number,email,financial_status,fulfillment_status,line_items,total_price,total_discounts,total_shipping_price_set,billing_address,shipping_address,customer";

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const stats = createPullOrderStats();
      const importCtx = { companyId, process, stats, req };

      if (posOrder) {
        const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "shopify");
        if (!remoteId) {
          return res.status(400).json({
            success: false,
            message:
              "POS order has no Shopify reference (description or integration_order_id).",
          });
        }

        const detailResponse = await client.get({
          path: `orders/${remoteId}`,
          query: { fields: orderFields },
        });
        const remote = detailResponse?.body?.order;
        if (!remote?.id) {
          return res.status(404).json({
            success: false,
            message: `Shopify order ${remoteId} not found.`,
          });
        }

        try {
          await pullShopifyOrderToPos(remote, importCtx);
        } catch (err) {
          recordOrderSkip(
            stats,
            {
              store: "shopify",
              remote_id: remoteId,
              order_number: remote?.order_number,
              reason: "import_error",
              detail: err?.message || String(err),
            },
            importCtx,
          );
        }

        const {
          inserted,
          updated,
          skipped,
          lines_inserted,
          lines_skipped,
          skipped_orders,
        } = stats;
        const remarks = formatPullOrderBatchRemarks({
          fetched: 1,
          inserted,
          updated,
          skipped,
          lines_inserted,
          lines_skipped,
          skipped_orders,
          isComplete: true,
          page: 1,
        });

        return finishPullOrderBatch(req, res, process, {
          fetched: 1,
          inserted,
          updated,
          skipped,
          lines_inserted,
          lines_skipped,
          skipped_orders,
          isComplete: true,
          remarks,
        });
      }

      const { limit, offset, page } = resolveBatchPagination(process);
      const query = {
        limit,
        status: "any",
        fields: orderFields,
        order: "id asc",
      };
      if (offset > 0) {
        query.since_id = offset;
      }

      const listResponse = await client.get({ path: "orders", query });
      const remoteOrders =
        Array.isArray(listResponse?.body?.orders) ?
          listResponse.body.orders
        : [];

      for (const remote of remoteOrders) {
        try {
          await pullShopifyOrderToPos(remote, importCtx);
        } catch (err) {
          console.error(
            `Failed to pull Shopify order ${remote?.id}:`,
            err?.message || err,
          );
          recordOrderSkip(
            stats,
            {
              store: "shopify",
              remote_id: remote?.id,
              order_number: remote?.order_number,
              reason: "import_error",
              detail: err?.message || String(err),
            },
            importCtx,
          );
        }
      }

      const {
        inserted,
        updated,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      } = stats;
      const fetched = remoteOrders.length;
      const isComplete = fetched < limit;
      const lastRemoteId = fetched > 0 ? remoteOrders[fetched - 1]?.id : offset;
      const remarks = formatPullOrderBatchRemarks({
        fetched,
        inserted,
        updated,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        isComplete,
        page: page + 1,
      });

      return finishPullOrderBatch(req, res, process, {
        fetched,
        inserted,
        updated,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        isComplete,
        nextOffset: lastRemoteId || 0,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify order pull failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to pull orders from Shopify.",
    );
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "shopify",
      errorMessage,
    });
    return failPullOrderBatch(process, res, errorMessage, errorMessage);
  }
}

/**
 * Push one POS order status to Shopify via Fulfillment Orders API
 * (hold / release hold / fulfill / cancel).
 */
async function listShopifyFulfillmentOrders(client, remoteOrderId) {
  const response = await client.get({
    path: `orders/${remoteOrderId}/fulfillment_orders`,
  });
  return Array.isArray(response?.body?.fulfillment_orders) ?
      response.body.fulfillment_orders
    : [];
}

function shopifyFulfillmentOrderSupports(fulfillmentOrder, action) {
  const actions =
    Array.isArray(fulfillmentOrder?.supported_actions) ?
      fulfillmentOrder.supported_actions
    : [];
  return actions.includes(action);
}

async function holdShopifyFulfillmentOrders(
  client,
  fulfillmentOrders,
  reasonNotes = "OMS on hold",
) {
  const held = [];
  for (const fo of fulfillmentOrders) {
    const status = String(fo?.status || "").toLowerCase();
    if (status === "closed") {
      continue;
    }
    if (status === "on_hold") {
      held.push(fo.id);
      continue;
    }
    if (!shopifyFulfillmentOrderSupports(fo, "hold")) {
      continue;
    }
    await client.post({
      path: `fulfillment_orders/${fo.id}/hold`,
      data: {
        fulfillment_hold: {
          reason: "other",
          reason_notes: reasonNotes,
        },
      },
      type: "application/json",
    });
    held.push(fo.id);
  }
  return held;
}

async function releaseShopifyFulfillmentHolds(client, fulfillmentOrders) {
  const released = [];
  for (const fo of fulfillmentOrders) {
    const status = String(fo?.status || "").toLowerCase();
    if (status !== "on_hold") {
      continue;
    }
    if (!shopifyFulfillmentOrderSupports(fo, "release_hold")) {
      continue;
    }
    await client.post({
      path: `fulfillment_orders/${fo.id}/release_hold`,
      data: {},
      type: "application/json",
    });
    released.push(fo.id);
  }
  return released;
}

async function listShopifyOrderFulfillments(client, remoteOrderId) {
  const response = await client.get({
    path: `orders/${remoteOrderId}/fulfillments`,
  });
  return Array.isArray(response?.body?.fulfillments) ?
      response.body.fulfillments
    : [];
}

function buildShopifyFulfillmentTrackingInfo(tracking) {
  const number = String(tracking?.tracking_number || "").trim();
  if (!number) {
    return null;
  }
  const company = String(tracking?.courier_name || "").trim() || undefined;
  const url = String(tracking?.tracking_url || "").trim() || undefined;
  return { number, company, url };
}

async function updateShopifyFulfillmentTracking(
  client,
  fulfillmentId,
  trackingInfo,
) {
  await client.post({
    path: `fulfillments/${fulfillmentId}/update_tracking`,
    data: {
      fulfillment: {
        notify_customer: false,
        tracking_info: trackingInfo,
      },
    },
    type: "application/json",
  });
}

async function markShopifyFulfillmentsDelivered(client, remoteOrderId) {
  const fulfillments = await listShopifyOrderFulfillments(
    client,
    remoteOrderId,
  );
  const marked = [];
  for (const fulfillment of fulfillments) {
    const shipmentStatus = String(
      fulfillment?.shipment_status || "",
    ).toLowerCase();
    if (shipmentStatus === "delivered") {
      continue;
    }
    try {
      await client.post({
        path: `orders/${remoteOrderId}/fulfillments/${fulfillment.id}/events`,
        data: { event: { status: "delivered" } },
        type: "application/json",
      });
      marked.push(fulfillment.id);
    } catch (error) {
      console.warn(
        `[shopify push_order] mark delivered failed for fulfillment ${fulfillment.id}:`,
        describeShopifyError(error),
      );
    }
  }
  return marked;
}

async function postShopifyFulfillmentShipmentEvent(
  client,
  remoteOrderId,
  fulfillmentId,
  tracking,
  orderStatus,
) {
  const eventStatus = mapTrackingStatusToShopifyFulfillmentEvent(
    tracking?.tracking_status,
    orderStatus,
  );
  if (!eventStatus) {
    return null;
  }

  const message = String(tracking?.tracking_status || "").trim() || undefined;
  await client.post({
    path: `orders/${remoteOrderId}/fulfillments/${fulfillmentId}/events`,
    data: {
      event: {
        status: eventStatus,
        ...(message ? { message } : {}),
      },
    },
    type: "application/json",
  });

  return {
    fulfillment_id: fulfillmentId,
    event_status: eventStatus,
    message: message || null,
  };
}

async function syncShopifyFulfillmentShipmentEvents(
  client,
  remoteOrderId,
  tracking,
  orderStatus,
) {
  const fulfillments = await listShopifyOrderFulfillments(
    client,
    remoteOrderId,
  );
  const events = [];

  for (const fulfillment of fulfillments) {
    const status = String(fulfillment?.status || "").toLowerCase();
    if (status !== "success") {
      continue;
    }
    try {
      const event = await postShopifyFulfillmentShipmentEvent(
        client,
        remoteOrderId,
        fulfillment.id,
        tracking,
        orderStatus,
      );
      if (event) {
        events.push(event);
      }
    } catch (error) {
      console.warn(
        `[shopify push_order] shipment event failed for fulfillment ${fulfillment.id}:`,
        describeShopifyError(error),
      );
    }
  }

  return events;
}

/**
 * Create fulfillment with tracking (shows "In transit" in Shopify admin) or
 * update tracking on an existing open fulfillment.
 */
async function syncShopifyOrderShipmentTracking(
  client,
  remoteOrderId,
  fulfillmentOrders,
  tracking,
  orderStatus = "",
) {
  const trackingInfo = buildShopifyFulfillmentTrackingInfo(tracking);
  const result = {
    tracking: trackingInfo,
    fulfilled: [],
    tracking_updated: [],
  };

  await releaseShopifyFulfillmentHolds(client, fulfillmentOrders);
  const refreshedOrders = await listShopifyFulfillmentOrders(
    client,
    remoteOrderId,
  );

  const fulfillable = refreshedOrders.filter((fo) => {
    const status = String(fo?.status || "").toLowerCase();
    return (
      status !== "closed" &&
      shopifyFulfillmentOrderSupports(fo, "create_fulfillment")
    );
  });

  if (fulfillable.length > 0) {
    result.fulfilled = await fulfillShopifyFulfillmentOrders(
      client,
      fulfillable,
      tracking,
    );
    result.action = "fulfilled";
    result.shipment_events = await syncShopifyFulfillmentShipmentEvents(
      client,
      remoteOrderId,
      tracking,
      orderStatus,
    );
    if (result.shipment_events.length > 0) {
      result.shipment_event_status =
        result.shipment_events[0]?.event_status || null;
    }
    return result;
  }

  if (!trackingInfo) {
    result.action = "none";
    result.reason = "no_tracking_number";
    return result;
  }

  const existingFulfillments = await listShopifyOrderFulfillments(
    client,
    remoteOrderId,
  );
  const updatable = existingFulfillments.filter((row) => {
    const status = String(row?.status || "").toLowerCase();
    const shipmentStatus = String(row?.shipment_status || "").toLowerCase();
    return status === "success" && shipmentStatus !== "delivered";
  });

  for (const fulfillment of updatable) {
    await updateShopifyFulfillmentTracking(
      client,
      fulfillment.id,
      trackingInfo,
    );
    result.tracking_updated.push(fulfillment.id);
  }

  result.action =
    result.tracking_updated.length > 0 ? "tracking_updated" : "none";
  if (result.action === "none") {
    result.reason = "no_open_fulfillment_to_update";
  }

  result.shipment_events = await syncShopifyFulfillmentShipmentEvents(
    client,
    remoteOrderId,
    tracking,
    orderStatus,
  );
  if (result.shipment_events.length > 0) {
    result.shipment_event_status =
      result.shipment_events[0]?.event_status || null;
  }

  return result;
}

async function fulfillShopifyFulfillmentOrders(
  client,
  fulfillmentOrders,
  tracking = {},
) {
  const openOrders = fulfillmentOrders.filter((fo) => {
    const status = String(fo?.status || "").toLowerCase();
    return (
      status !== "closed" &&
      shopifyFulfillmentOrderSupports(fo, "create_fulfillment")
    );
  });

  if (openOrders.length === 0) {
    return [];
  }

  const fulfillmentPayload = {
    fulfillment: {
      notify_customer: false,
      line_items_by_fulfillment_order: openOrders.map((fo) => ({
        fulfillment_order_id: fo.id,
      })),
    },
  };

  const trackingNumber = String(tracking?.tracking_number || "").trim();
  const trackingInfo = buildShopifyFulfillmentTrackingInfo(tracking);
  if (trackingInfo) {
    fulfillmentPayload.fulfillment.tracking_info = trackingInfo;
  } else if (trackingNumber) {
    fulfillmentPayload.fulfillment.tracking_info = {
      number: trackingNumber,
      company: String(tracking?.courier_name || "").trim() || undefined,
    };
  }

  await client.post({
    path: "fulfillments",
    data: fulfillmentPayload,
    type: "application/json",
  });

  return openOrders.map((fo) => fo.id);
}

async function push_order(req, res, process) {
  const integration = process?.integration_id;
  const posOrder = process?.order_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!posOrder) {
    return res.status(400).json({
      success: false,
      message:
        "Order is required for push_order. Set order_id on the process (Admin → Process).",
    });
  }

  const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "shopify");
  if (!remoteId) {
    return res.status(400).json({
      success: false,
      message:
        "POS order has no Shopify reference (description or integration_order_id).",
    });
  }

  const posStatus = String(posOrder.order_status || "placed").trim();
  const fulfillmentAction =
    mapPosOrderStatusToShopifyFulfillmentAction(posStatus);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const syncResult = {
        action: fulfillmentAction,
        remote_id: remoteId,
        fulfillment_orders: [],
      };

      if (fulfillmentAction === "cancel") {
        await client.post({
          path: `orders/${remoteId}/cancel`,
          data: {},
        });
      } else if (fulfillmentAction === "none") {
        syncResult.skipped = true;
        syncResult.reason = "no_shopify_fulfillment_mapping";
      } else {
        const fulfillmentOrders = await listShopifyFulfillmentOrders(
          client,
          remoteId,
        );
        syncResult.fulfillment_orders = fulfillmentOrders.map((fo) => ({
          id: fo.id,
          status: fo.status,
          supported_actions: fo.supported_actions || [],
        }));

        if (fulfillmentOrders.length === 0) {
          const msg =
            "No Shopify fulfillment orders found for this order. " +
            "Ensure the custom app has read_merchant_managed_fulfillment_orders scope.";
          await markProcessOutcome(process._id, "failed", msg);
          return res.status(400).json({
            success: false,
            message: msg,
            data: syncResult,
          });
        }

        if (fulfillmentAction === "hold") {
          syncResult.held = await holdShopifyFulfillmentOrders(
            client,
            fulfillmentOrders,
            `OMS status: ${posStatus}`,
          );
        } else if (fulfillmentAction === "release_hold") {
          syncResult.released = await releaseShopifyFulfillmentHolds(
            client,
            fulfillmentOrders,
          );
        } else if (fulfillmentAction === "ship_with_tracking") {
          const tracking = await resolvePosOrderTrackingForPush(posOrder);
          syncResult.shipment = await syncShopifyOrderShipmentTracking(
            client,
            remoteId,
            fulfillmentOrders,
            tracking,
            posStatus,
          );
        } else if (fulfillmentAction === "deliver") {
          const tracking = await resolvePosOrderTrackingForPush(posOrder);
          await releaseShopifyFulfillmentHolds(client, fulfillmentOrders);
          const refreshedOrders = await listShopifyFulfillmentOrders(
            client,
            remoteId,
          );
          syncResult.fulfilled = await fulfillShopifyFulfillmentOrders(
            client,
            refreshedOrders,
            tracking,
          );
          syncResult.delivered = await markShopifyFulfillmentsDelivered(
            client,
            remoteId,
          );
        }
      }

      const label = posOrder.order_no || posOrder._id;
      const actionSummary =
        fulfillmentAction === "cancel" ? "cancelled"
        : fulfillmentAction === "hold" ?
          `held ${(syncResult.held || []).length} fulfillment order(s)`
        : fulfillmentAction === "release_hold" ?
          `released ${(syncResult.released || []).length} hold(s)`
        : fulfillmentAction === "ship_with_tracking" ?
          syncResult.shipment?.action === "fulfilled" ?
            `fulfilled with tracking (${syncResult.shipment?.tracking?.number || "—"})` +
            (syncResult.shipment?.shipment_event_status ?
              `, Shopify: ${syncResult.shipment.shipment_event_status.replace(/_/g, " ")}`
            : "")
          : syncResult.shipment?.action === "tracking_updated" ?
            `updated tracking on ${(syncResult.shipment?.tracking_updated || []).length} fulfillment(s)` +
            (syncResult.shipment?.shipment_event_status ?
              `, Shopify: ${syncResult.shipment.shipment_event_status.replace(/_/g, " ")}`
            : "")
          : syncResult.shipment?.shipment_events?.length ?
            `shipment status → ${syncResult.shipment.shipment_event_status?.replace(/_/g, " ") || "updated"}`
          : "no shipment tracking update"
        : fulfillmentAction === "deliver" ?
          `delivered (${(syncResult.delivered || []).length} fulfillment event(s))`
        : "no fulfillment action";
      const remarks = `Order ${label} pushed to Shopify #${remoteId} (OMS status: ${posStatus}, ${actionSummary}).`;
      await markProcessOutcome(process._id, "completed", remarks);

      return res.status(200).json({
        success: true,
        message: remarks,
        data: {
          order_id: posOrder._id,
          remote_id: remoteId,
          order_status: posStatus,
          shopify_fulfillment_action: fulfillmentAction,
          ...syncResult,
        },
      });
    });
  } catch (error) {
    console.error(
      "Shopify order push failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyFulfillmentScopeError(
      error,
      "Failed to push order to Shopify.",
    );
    await markProcessOutcome(process._id, "failed", errorMessage);
    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: error?.response?.body || error?.response?.data || error,
    });
  }
}

/**
 * Push POS courier / tracking to Shopify fulfillment (In transit + tracking link).
 */
async function push_order_tracking(req, res, process) {
  const integration = process?.integration_id;
  const posOrder = process?.order_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!posOrder) {
    return res.status(400).json({
      success: false,
      message:
        "Order is required for push_order_tracking. Set order_id on the process.",
    });
  }

  const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "shopify");
  if (!remoteId) {
    return res.status(400).json({
      success: false,
      message:
        "POS order has no Shopify reference (description or integration_order_id).",
    });
  }

  const tracking = await resolvePosOrderTrackingForPush(posOrder);
  if (
    !tracking.courier_name &&
    !tracking.tracking_number &&
    !tracking.tracking_status
  ) {
    const msg =
      "Nothing to push — set courier, tracking number, or tracking status on the POS order.";
    await markProcessOutcome(process._id, "failed", msg);
    return res.status(400).json({ success: false, message: msg });
  }

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const fulfillmentOrders = await listShopifyFulfillmentOrders(
        client,
        remoteId,
      );
      if (fulfillmentOrders.length === 0) {
        const msg =
          "No Shopify fulfillment orders found for this order. " +
          "Ensure the custom app has read_merchant_managed_fulfillment_orders scope.";
        await markProcessOutcome(process._id, "failed", msg);
        return res.status(400).json({ success: false, message: msg });
      }

      const shipment = await syncShopifyOrderShipmentTracking(
        client,
        remoteId,
        fulfillmentOrders,
        tracking,
        posOrder.order_status,
      );

      if (
        shipment.action === "none" &&
        !(
          Array.isArray(shipment.shipment_events) &&
          shipment.shipment_events.length > 0
        )
      ) {
        const msg =
          tracking.tracking_number ?
            `Could not update Shopify shipping — ${shipment.reason || "no fulfillment to fulfill or update"}. ` +
            "Check fulfillment scopes and that the order is not already fully fulfilled without tracking."
          : "Nothing to push — add a courier tracking number on the POS order.";
        await markProcessOutcome(process._id, "failed", msg);
        return res.status(400).json({
          success: false,
          message: msg,
          data: { shipment, tracking },
        });
      }

      const label = posOrder.order_no || posOrder._id;
      const trackingLabel = tracking.tracking_number || "—";
      const courierLabel = tracking.courier_name || "—";
      const shopifyStatus =
        shipment.shipment_event_status ?
          shipment.shipment_event_status.replace(/_/g, " ")
        : "";
      const omsStatus = tracking.tracking_status || "";
      const remarks =
        shipment.action === "fulfilled" ?
          `Order ${label} fulfilled on Shopify #${remoteId} with ${courierLabel} tracking ${trackingLabel}` +
          (shopifyStatus ? ` (${shopifyStatus})` : "") +
          (omsStatus ? `. OMS: ${omsStatus}` : ".")
        : shipment.action === "tracking_updated" ?
          `Order ${label} tracking updated on Shopify #${remoteId}: ${courierLabel} ${trackingLabel}` +
          (shopifyStatus ? ` (${shopifyStatus})` : "") +
          (omsStatus ? `. OMS: ${omsStatus}` : ".")
        : `Order ${label} shipment status updated on Shopify #${remoteId}` +
          (shopifyStatus ? `: ${shopifyStatus}` : "") +
          (omsStatus ? ` (OMS: ${omsStatus})` : ".");
      await markProcessOutcome(process._id, "completed", remarks);

      return res.status(200).json({
        success: true,
        message: remarks,
        data: {
          order_id: posOrder._id,
          remote_id: remoteId,
          tracking,
          shipment,
        },
      });
    });
  } catch (error) {
    console.error(
      "Shopify order tracking push failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyFulfillmentScopeError(
      error,
      "Failed to push order tracking to Shopify.",
    );
    await markProcessOutcome(process._id, "failed", errorMessage);
    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: error?.response?.body || error?.response?.data || error,
    });
  }
}

/**
 * Import orders from Shopify into POS (batch). Store → POS.
 */
async function fetch_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { limit, offset, page } = resolveBatchPagination(process);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const query = {
        limit,
        status: "any",
        fields:
          "id,order_number,email,financial_status,fulfillment_status,line_items,total_price,total_discounts,total_shipping_price_set,billing_address,shipping_address,customer",
        order: "id asc",
      };
      if (offset > 0) {
        query.since_id = offset;
      }

      const listResponse = await client.get({ path: "orders", query });
      const remoteOrders =
        Array.isArray(listResponse?.body?.orders) ?
          listResponse.body.orders
        : [];
      const stats = createFetchOrderStats();

      const importCtx = { companyId, process, stats, req };

      for (const remote of remoteOrders) {
        try {
          await importShopifyOrderToPos(remote, importCtx);
        } catch (err) {
          console.error(
            `Failed to import Shopify order ${remote?.id}:`,
            err?.message || err,
          );
          recordOrderSkip(
            stats,
            {
              store: "shopify",
              remote_id: remote?.id,
              order_number: remote?.order_number,
              reason: "import_error",
              detail: err?.message || String(err),
            },
            importCtx,
          );
        }
      }

      const {
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      } = stats;
      const fetched = remoteOrders.length;
      const isComplete = fetched < limit;
      const lastRemoteId = fetched > 0 ? remoteOrders[fetched - 1]?.id : offset;
      const remarks = formatFetchOrderBatchRemarks({
        fetched,
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        isComplete,
        page: page + 1,
      });

      return finishFetchOrderBatch(req, res, process, {
        fetched,
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        isComplete,
        nextOffset: lastRemoteId || 0,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify order fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to fetch orders from Shopify.",
    );
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "shopify",
      errorMessage,
    });
    return failFetchOrderBatch(process, res, errorMessage, errorMessage);
  }
}

/**
 * Poll newest Shopify orders (newest first) and import any not yet in POS.
 * One execute-process call; process stays active for recurring cron runs.
 * `limit` = how many recent store orders to check (default 20, max 100).
 */
async function fetch_latest_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const perPage = resolveLatestOrderBatchLimit(process);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const listResponse = await client.get({
        path: "orders",
        query: {
          limit: perPage,
          status: "any",
          fields:
            "id,order_number,email,financial_status,fulfillment_status,line_items,total_price,subtotal_price,total_discounts,total_shipping_price_set,billing_address,shipping_address,customer",
          order: "id desc",
        },
      });
      const remoteOrders =
        Array.isArray(listResponse?.body?.orders) ?
          listResponse.body.orders
        : [];
      const stats = createFetchOrderStats();
      const importCtx = { companyId, process, stats, req };

      for (const remote of remoteOrders) {
        try {
          await importShopifyOrderToPos(remote, importCtx);
        } catch (err) {
          console.error(
            `Failed to import Shopify order ${remote?.id}:`,
            err?.message || err,
          );
          recordOrderSkip(
            stats,
            {
              store: "shopify",
              remote_id: remote?.id,
              order_number: remote?.order_number,
              reason: "import_error",
              detail: err?.message || String(err),
            },
            importCtx,
          );
        }
      }

      const {
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
      } = stats;
      const fetched = remoteOrders.length;
      const remarks = formatFetchLatestOrderRemarks({
        fetched,
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        limit: perPage,
      });

      return finishFetchLatestOrderBatch(req, res, process, {
        fetched,
        inserted,
        skipped,
        lines_inserted,
        lines_skipped,
        skipped_orders,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify latest order fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to fetch latest orders from Shopify.",
    );
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "shopify",
      errorMessage,
    });
    return failFetchOrderBatch(process, res, errorMessage, errorMessage);
  }
}

/**
 * Import products from Shopify into POS (batch). Store → POS.
 */
async function fetch_product(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { limit, offset, page } = resolveBatchPagination(process);

  try {
    return await runWithShopifyClient(integration, process, async (client) => {
      const query = {
        limit,
        order: "id asc",
      };
      if (offset > 0) {
        query.since_id = offset;
      }

      // fetch_product imports catalog only — do not resolve warehouse or sync qty/stock.
      const listResponse = await client.get({ path: "products", query });
      const remoteProducts =
        Array.isArray(listResponse?.body?.products) ?
          listResponse.body.products
        : [];
      const stats = {
        inserted: 0,
        updated: 0,
        skipped: 0,
        categories_found: 0,
        categories_inserted: 0,
        products_category_linked: 0,
        sync_product_mapped: 0,
        variations_fetched: 0,
        variations_inserted: 0,
        variations_updated: 0,
      };
      const categoryCtx = { companyId, process, stats };

      for (const remote of remoteProducts) {
        const name = String(remote?.title || "").trim();
        if (!name) {
          stats.skipped += 1;
          continue;
        }

        try {
          const variant =
            Array.isArray(remote?.variants) ? remote.variants[0] : null;
          const productPrice = mapShopifyVariantPrice(variant);
          const categoryIds = await resolvePosCategoryIdsFromShopifyProduct(
            remote,
            client,
            categoryCtx,
          );
          await importShopifyProductToPos(remote, {
            companyId,
            process,
            stats,
            productPrice,
            categoryIds,
            warehouseId: null,
            client,
          });
        } catch (err) {
          console.error(
            `Failed to import Shopify product ${remote?.id} (${name}):`,
            err?.message || err,
          );
          stats.skipped += 1;
        }
      }

      const {
        inserted,
        updated = 0,
        skipped,
        categories_found = 0,
        categories_inserted = 0,
        products_category_linked = 0,
        variations_fetched = 0,
        variations_inserted = 0,
        variations_updated = 0,
      } = stats;
      const fetched = remoteProducts.length;
      const isComplete = fetched < limit;
      const lastRemoteId =
        fetched > 0 ? remoteProducts[fetched - 1]?.id : offset;
      const variationSummary =
        variations_fetched > 0 ?
          `, variations fetched ${variations_fetched}, inserted ${variations_inserted}, updated ${variations_updated}`
        : "";
      const remarks =
        isComplete ?
          `Product import completed: batch fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, stock not fetched${variationSummary}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}.`
        : `Batch complete: fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, stock not fetched${variationSummary}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}. Call execute-process again for page ${page + 1}.`;

      return finishFetchProductBatch(req, res, process, {
        fetched,
        inserted,
        updated,
        skipped,
        categories_found,
        categories_inserted,
        products_category_linked,
        variations_fetched,
        variations_inserted,
        variations_updated,
        isComplete,
        nextOffset: lastRemoteId || 0,
        remarks,
      });
    });
  } catch (error) {
    console.error(
      "Shopify product fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorMessage = formatShopifyErrorPayload(
      error,
      "Failed to fetch products from Shopify.",
    );
    return failFetchProductBatch(process, res, errorMessage, errorMessage);
  }
}

/**
 * Save Shopify vendor mapping for a POS brand (vendors are product-level on Shopify).
 */
async function sync_brand(req, res, process) {
  const integration = process?.integration_id;
  const brand = process?.brand_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!brand) {
    return res.status(400).json({
      success: false,
      message:
        "Brand is required for sync_brand. Set brand_id on the process or pass ?brand_id=<id> on execute-process.",
    });
  }

  const name = brand.name?.trim();
  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Brand name is required.",
    });
  }

  const companyId = resolveCompanyId(process);
  const referenceId = `vendor:${categorySlugFromName(name)}`;

  await upsertSyncBrandMapping({
    brandId: brand._id,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId,
    createdBy: process.created_by?._id || process.created_by,
  });

  await markProcessOutcome(
    process._id,
    "completed",
    `Brand vendor mapping saved for Shopify: ${name}.`,
  );

  return res.status(200).json({
    success: true,
    message: `Brand : ${name} mapped for Shopify vendor (use sync_product to push products with this vendor).`,
    data: { brand_id: brand._id, refference_id: referenceId },
  });
}

module.exports = {
  buildShopifyClient,
  fetch_category,
  fetch_brand,
  fetch_order,
  fetch_latest_order,
  pull_order,
  push_order,
  push_order_tracking,
  fetch_product,
  sync_product,
  sync_category,
  sync_brand,
};

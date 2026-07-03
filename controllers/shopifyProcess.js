const mongoose = require("mongoose");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Company = require("../models/company");
const Product = require("../models/product");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const SyncCategory = require("../models/sync_category");
const SyncProduct = require("../models/sync_product");
const WarehouseInventory = require("../models/warehouse_inventory");
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
  mapShopifyOrderStatus,
  createFetchOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
  logFetchOrderImported,
  logFetchOrderBatchFailed,
  fallbackRemoteOrderLinesSubtotal,
} = require("../utils/processHelpers");
const {
  resolvePosProductSku,
  buildShopifyProductSyncPayload,
  buildShopifyVariantSyncPayload,
  hasSyncPayloadFields,
  isIntegrationSyncEnabled,
} = require("../utils/integrationProductSync");

function buildShopifyClient(integration) {
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

  const apiKey =
    integration.key || integration.api_key || integration.public_key;
  const apiSecret =
    integration.secret ||
    integration.secret_key ||
    integration.private_key ||
    integration.client_secret;
  const accessToken =
    integration.token || integration.access_token || integration.password;

  if (!apiKey || !apiSecret || !accessToken) {
    return {
      error:
        "Incomplete Shopify credentials. Please verify key, secret, and access token.",
    };
  }

  const shopify = shopifyApi({
    apiKey,
    apiSecretKey: apiSecret,
    adminApiAccessToken: accessToken,
    scopes: [
      "read_products",
      "write_products",
      "read_inventory",
      "write_inventory",
    ],
    hostName: shopDomain,
    apiVersion: ApiVersion.October24,
    isCustomStoreApp: true,
  });

  const session = shopify.session.customAppSession(shopDomain);
  session.accessToken = accessToken;

  return {
    client: new shopify.clients.Rest({ session }),
    shopDomain,
  };
}

/**
 * Extract a human-readable detail string from a Shopify client error.
 * Handles HttpResponseError (status + body), JSON-parse failures on empty
 * bodies ("...end of input at position 0"), and plain Error messages.
 */
function describeShopifyError(error) {
  const status =
    error?.response?.code ??
    error?.response?.statusCode ??
    error?.code ??
    null;

  const body =
    error?.response?.body ?? error?.response?.data ?? null;

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

function validateShopifyIntegration(integration, res) {
  if (!integration || integration.store_type !== "shopify") {
    res.status(400).json({
      success: false,
      message: "Shopify integration details are missing or invalid.",
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
    .filter(
      (value) => value && value.toLowerCase() !== "default title",
    );
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
  const text = JSON.stringify(body || error?.message || error || "").toLowerCase();
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

/** When the token lacks write_inventory, skip pushing stock for the rest of the run. */
let shopifyInventoryWriteUnavailable = false;

/** Sum POS on-hand quantity per product from warehouse_inventory (push side). */
async function resolveShopifyStockTotals(productIds, companyId) {
  const ids = (Array.isArray(productIds) ? productIds : [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  if (!ids.length) {
    return new Map();
  }

  const matchFilter = {
    product_id: { $in: ids },
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  const scopedCompanyId = coalesceObjectId(companyId);
  if (scopedCompanyId) {
    matchFilter.company_id = scopedCompanyId;
  }

  try {
    const grouped = await WarehouseInventory.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$product_id", total: { $sum: "$quantity" } } },
    ]);
    return new Map(
      grouped.map((row) => [String(row._id), Number(row.total) || 0]),
    );
  } catch (error) {
    console.warn(
      "Failed to aggregate warehouse inventory for Shopify sync:",
      error?.message,
    );
    return new Map();
  }
}

/** Resolve the Shopify location to write inventory against (prefer active). */
async function resolveShopifyPrimaryLocationId(client) {
  try {
    const resp = await client.get({ path: "locations" });
    const locations =
      Array.isArray(resp?.body?.locations) ? resp.body.locations : [];
    const active = locations.find((loc) => loc?.active) || locations[0];
    return active?.id != null ? String(active.id) : null;
  } catch (error) {
    console.warn(
      "Shopify locations lookup failed; cannot push stock:",
      describeShopifyError(error),
    );
    return null;
  }
}

/**
 * Set a Shopify variant's available inventory at the given location. Enables
 * Shopify inventory tracking on the variant first if needed. Returns true when
 * the level was set. Disables further stock pushes if write_inventory is missing.
 */
async function setShopifyVariantInventory({
  client,
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

  try {
    if (variant.inventory_management !== "shopify") {
      await client.put({
        path: `variants/${variant.id}`,
        data: {
          variant: { id: variant.id, inventory_management: "shopify" },
        },
        type: "application/json",
      });
    }

    await client.post({
      path: "inventory_levels/set",
      data: {
        location_id: Number(locationId),
        inventory_item_id: Number(inventoryItemId),
        available,
      },
      type: "application/json",
    });
    return true;
  } catch (error) {
    const text = JSON.stringify(
      error?.response?.body || error?.message || error || "",
    ).toLowerCase();
    if (isShopifyInventoryScopeError(error) || text.includes("write_inventory")) {
      shopifyInventoryWriteUnavailable = true;
      console.warn(
        "[shopify sync] write_inventory scope missing — skipping stock sync.",
      );
    } else {
      console.warn(
        `Shopify inventory set failed for item ${inventoryItemId}:`,
        describeShopifyError(error),
      );
    }
    return false;
  }
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
    .select("warehouse_id")
    .lean();
  const wid = company?.warehouse_id;
  if (wid != null && mongoose.Types.ObjectId.isValid(String(wid))) {
    return coalesceObjectId(wid);
  }
  return null;
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

  const row = await WarehouseInventory.findOne(filter).select("quantity").lean();
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
    product_type: productTypeOverride || mapShopifyProductType(remoteProduct?.product_type),
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
          collectionTitle =
            String(
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

  const categoryField = categoryIds.map((id) => coalesceObjectId(id)).filter(Boolean);
  const existing = await findPosProductForShopifyImport({
    process,
    companyId,
    shopifyReferenceId,
    sku,
    name: trimmedName,
  });

  const payload = {
    ...buildPosFieldsFromShopify(remoteProduct, variant, productPrice, productType),
    product_name: trimmedName,
    sku,
    product_code: sku,
    category_id: categoryField,
  };

  if (parentProductId) {
    payload.parent_product_id = coalesceObjectId(parentProductId);
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
      created_by: coalesceObjectId(process.created_by?._id || process.created_by),
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
    variantPrices.length > 0 ?
      Math.min(...variantPrices)
    : productPrice;

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
    productPrice !== undefined ?
      productPrice
    : mapShopifyVariantPrice(variant);

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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset } = resolveBatchPagination(process);
  const query = { limit, order: "id asc" };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
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
  } catch (error) {
    console.error(
      "Shopify category fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch categories from Shopify.";
    return failFetchCategoryBatch(process, res, errorPayload, errorPayload);
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

/**
 * Push a variable POS product to Shopify: update the parent product fields and
 * each Shopify variant's price/weight from the matching POS variation child.
 * Children are matched to remote variants by their stored sync reference
 * (`productId:variantId`) first, then by SKU.
 */
async function syncShopifyVariableProductToStore(
  req,
  res,
  process,
  { client, integration, parentProduct, companyId, integrationId },
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
  const childStockTotals =
    stockSyncEnabled ?
      await resolveShopifyStockTotals(childIds, companyId)
    : new Map();

  const syncRows = await SyncProduct.find({
    integration_id: integrationId,
    company_id: companyId,
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

  const stats = {
    variations_updated: 0,
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
    for (const candidate of skuCandidates) {
      const variantResp = await client.get({
        path: "variants",
        query: { sku: candidate },
      });
      const vs =
        Array.isArray(variantResp?.body?.variants) ?
          variantResp.body.variants
        : [];
      if (vs.length && vs[0]?.product_id) {
        shopifyProductId = String(vs[0].product_id);
        const resp = await client.get({
          path: `products/${shopifyProductId}`,
        });
        remoteParent = resp?.body?.product || null;
        if (remoteParent) {
          break;
        }
      }
    }
  }

  if (!remoteParent || !shopifyProductId) {
    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Product Name : ${parentProduct.product_name} to Shopify — parent product not found on Shopify.`,
    );
    return res.status(404).json({
      success: false,
      message: `Parent product "${parentProduct.product_name}" was not found on Shopify. Create it there first.`,
    });
  }

  const parentUpdatePayload = buildShopifyProductSyncPayload(
    parentProduct,
    integration,
    { mode: "update" },
  );
  if (hasSyncPayloadFields(parentUpdatePayload)) {
    await client.put({
      path: `products/${shopifyProductId}`,
      data: { product: { ...parentUpdatePayload, id: shopifyProductId } },
      type: "application/json",
    });
  }
  await recordShopifyProductSyncMapping(
    process,
    companyId,
    parentId,
    shopifyProductId,
  );

  const remoteVariants =
    Array.isArray(remoteParent?.variants) ? remoteParent.variants : [];
  const variantById = new Map(
    remoteVariants.map((v) => [String(v.id), v]),
  );
  const variantBySku = new Map(
    remoteVariants
      .filter((v) => v?.sku)
      .map((v) => [String(v.sku).trim().toLowerCase(), v]),
  );

  const locationId =
    stockSyncEnabled ? await resolveShopifyPrimaryLocationId(client) : null;

  for (const child of children) {
    try {
      const childId = coalesceObjectId(child._id);
      const childSyncRow = childSyncByProductId.get(String(child._id)) || null;
      const childSku = resolvePosProductSku(child);

      let variant = null;
      const refVariantId = parseShopifySyncReference(
        childSyncRow?.refference_id,
      ).variantId;
      if (refVariantId && variantById.has(String(refVariantId))) {
        variant = variantById.get(String(refVariantId));
      }
      if (!variant && childSku) {
        variant =
          variantBySku.get(String(childSku).trim().toLowerCase()) || null;
      }

      if (!variant?.id) {
        stats.variations_unmatched += 1;
        continue;
      }

      const variantPayload = buildShopifyVariantSyncPayload(child, integration, {
        mode: "update",
      });
      if (variantPayload) {
        await client.put({
          path: `variants/${variant.id}`,
          data: { variant: { ...variantPayload, id: variant.id } },
          type: "application/json",
        });
        stats.variations_updated += 1;
      } else {
        stats.variations_skipped += 1;
      }

      if (stockSyncEnabled && locationId) {
        const quantity = childStockTotals.get(String(child._id)) ?? 0;
        const inventorySet = await setShopifyVariantInventory({
          client,
          variant,
          quantity,
          locationId,
        });
        if (inventorySet) {
          stats.inventory_updated += 1;
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

  const remarks =
    `Product Name : ${parentProduct.product_name} synced to Shopify ` +
    `(product ${shopifyProductId}, variants updated ${stats.variations_updated}, ` +
    `stock updated ${stats.inventory_updated}, ` +
    `skipped ${stats.variations_skipped}, unmatched ${stats.variations_unmatched}).`;

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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
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
        integration,
        parentProduct: rootProduct,
        companyId,
        integrationId,
      });
    } catch (error) {
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
    deletedAt: null,
  }).lean();

  let step = "init";
  try {
    let remoteProduct = null;
    let remoteId =
      syncRow?.refference_id != null && String(syncRow.refference_id).trim() !== "" ?
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
        console.warn(
          `Shopify product ${remoteId} not found; will try SKU lookup:`,
          describeShopifyError(fetchErr),
        );
        remoteId = null;
      }
    }

    if (!remoteProduct) {
      step = `GET variants?sku=${sku}`;
      const variantResponse = await client.get({
        path: "variants",
        query: { sku },
      });
      const existingVariants =
        Array.isArray(variantResponse?.body?.variants) ?
          variantResponse.body.variants
        : [];
      if (existingVariants.length > 0 && existingVariants[0]?.product_id) {
        remoteId = String(existingVariants[0].product_id);
        try {
          step = `GET products/${remoteId} (via variant SKU)`;
          const productResponse = await client.get({
            path: `products/${remoteId}`,
          });
          remoteProduct = productResponse?.body?.product || null;
        } catch (fetchErr) {
          console.warn(
            "Failed to load Shopify product by variant SKU:",
            describeShopifyError(fetchErr),
          );
        }
      }
    }

    if (remoteProduct && remoteId) {
      const updatePayload = buildShopifyProductSyncPayload(
        product,
        integration,
        { mode: "update" },
      );
      const variantPayload = buildShopifyVariantSyncPayload(
        product,
        integration,
        { mode: "update" },
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
      }

      const singleVariant =
        updatedProduct?.variants?.[0] || remoteProduct?.variants?.[0] || null;

      if (variantPayload && singleVariant?.id) {
        step = `PUT variants/${singleVariant.id}`;
        await client.put({
          path: `variants/${singleVariant.id}`,
          data: { variant: { ...variantPayload, sku } },
          type: "application/json",
        });
      }

      if (stockSyncEnabled && singleVariant?.id) {
        const locationId = await resolveShopifyPrimaryLocationId(client);
        if (locationId) {
          const stockTotals = await resolveShopifyStockTotals(
            [productId],
            companyId,
          );
          step = `SET inventory for variant ${singleVariant.id}`;
          await setShopifyVariantInventory({
            client,
            variant: singleVariant,
            quantity: stockTotals.get(String(productId)) ?? 0,
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

      await markProcessOutcome(
        process._id,
        "completed",
        `Product Name : ${product.product_name} updated on Shopify.`,
      );

      return res.status(200).json({
        success: true,
        data: updatedProduct,
        message: `Product Name : ${product.product_name} updated on Shopify.`,
      });
    }

    const variantPayload = buildShopifyVariantSyncPayload(product, integration, {
      mode: "create",
    }) || {
      price:
        product.product_price !== undefined && product.product_price !== null ?
          String(product.product_price)
        : "0.00",
      sku,
    };
    if (!variantPayload.sku) variantPayload.sku = sku;

    const createPayload = buildShopifyProductSyncPayload(product, integration, {
      mode: "create",
    });
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
    await recordShopifyProductSyncMapping(
      process,
      companyId,
      productId,
      createdId,
    );

    await markProcessOutcome(
      process._id,
      "completed",
      `Product Name : ${product.product_name} created on Shopify.`,
    );

    return res.status(201).json({
      success: true,
      data: createdProduct,
      message: `Product Name : ${product.product_name} synced to Shopify successfully.`,
    });
  } catch (error) {
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

    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      `Failed to sync Product Name : ${product.product_name} to Shopify.`;

    return res.status(500).json({
      success: false,
      step,
      message: errorPayload,
      detail,
      error: errorPayload,
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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  try {
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

    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      `Failed to sync Category : ${category.name} to Shopify.`;

    return res.status(500).json({
      success: false,
      message: errorPayload,
      error: errorPayload,
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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset, page } = resolveBatchPagination(process);
  const query = { limit, fields: "id,vendor", order: "id asc" };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
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
  } catch (error) {
    console.error(
      "Shopify brand fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch brands from Shopify product vendors.";
    return failFetchBrandBatch(process, res, errorPayload, errorPayload);
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
    recordOrderSkip(stats, {
      store: "shopify",
      remote_id: remoteId,
      order_number: remoteOrder?.order_number,
      reason: "missing_remote_id",
      detail: "Shopify order has no id",
    }, logCtx);
    return;
  }

  const existing = await findExistingImportedOrder(companyId, {
    externalRef,
    integrationId,
    integrationOrderId,
  });
  if (existing) {
    recordOrderSkip(stats, {
      store: "shopify",
      remote_id: remoteId,
      order_number: remoteOrder?.order_number,
      reason: "already_imported",
      detail: existing.order_no ?
          `POS ${existing.order_no}`
        : `POS order ${existing._id}`,
    }, logCtx);
    return;
  }

  const lineItems = Array.isArray(remoteOrder?.line_items) ?
      remoteOrder.line_items
    : [];
  const orderItemsPayload = [];
  let linesSubtotal = 0;

  for (const line of lineItems) {
    const qty = Number(line?.quantity) || 0;
    const price = Number(line?.price) || 0;
    if (qty <= 0) {
      continue;
    }

    const product = await resolvePosProductForRemoteLine({
      integrationId,
      companyId,
      remoteProductId: line?.product_id,
      sku: line?.sku,
      name: line?.name,
    });

    if (!product?._id) {
      stats.lines_skipped += 1;
      continue;
    }

    const subtotal = Math.round(price * qty * 100) / 100;
    linesSubtotal += subtotal;
    orderItemsPayload.push({
      product_id: product._id,
      name: String(line?.name || product.name || "Item").trim(),
      price,
      qty,
      subtotal,
      company_id: companyId,
      created_by: coalesceObjectId(
        process.created_by?._id || process.created_by,
      ),
      status: "active",
    });
  }

  if (linesSubtotal === 0) {
    linesSubtotal = fallbackRemoteOrderLinesSubtotal(remoteOrder, "shopify");
  }

  const billing = remoteOrder?.billing_address || {};
  const customer = remoteOrder?.customer || {};
  const customerName = [billing.first_name, billing.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  const discount = Number(remoteOrder?.total_discounts) || 0;
  const shipment =
    Number(remoteOrder?.total_shipping_price_set?.shop_money?.amount) ||
    Number(remoteOrder?.total_shipping_price_set?.presentment_money?.amount) ||
    0;

  const order = await Order.create({
    name:
      customerName ||
      [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() ||
      `Shopify #${remoteOrder?.order_number || remoteId}`,
    email: remoteOrder?.email || customer.email || billing.email || "",
    phone: billing.phone || customer.phone || "",
    address: [
      billing.address1,
      billing.address2,
      billing.city,
      billing.province,
      billing.zip,
      billing.country,
    ]
      .filter(Boolean)
      .join(", "),
    description: externalRef,
    integration_order_id: integrationOrderId,
    discount,
    shipment,
    lines_subtotal: linesSubtotal,
    amount_received: Number(remoteOrder?.total_price) || 0,
    order_status: mapShopifyOrderStatus(
      remoteOrder?.financial_status,
      remoteOrder?.fulfillment_status,
    ),
    integration_id: integrationId,
    company_id: companyId,
    created_by: coalesceObjectId(
      process.created_by?._id || process.created_by,
    ),
    status: "active",
  });

  for (const item of orderItemsPayload) {
    await OrderItem.create({ ...item, order_id: order._id });
    stats.lines_inserted += 1;
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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset, page } = resolveBatchPagination(process);
  const query = {
    limit,
    status: "any",
    fields:
      "id,order_number,email,financial_status,fulfillment_status,line_items,total_price,total_discounts,total_shipping_price_set,billing_address,customer",
    order: "id asc",
  };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
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
        recordOrderSkip(stats, {
          store: "shopify",
          remote_id: remote?.id,
          order_number: remote?.order_number,
          reason: "import_error",
          detail: err?.message || String(err),
        }, importCtx);
      }
    }

    const { inserted, skipped, lines_inserted, lines_skipped, skipped_orders } =
      stats;
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
  } catch (error) {
    console.error(
      "Shopify order fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch orders from Shopify.";
    const errorMessage =
      typeof errorPayload === "string" ?
        errorPayload
      : errorPayload?.message || JSON.stringify(errorPayload);
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "shopify",
      errorMessage,
    });
    return failFetchOrderBatch(process, res, errorPayload, errorPayload);
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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const perPage = resolveLatestOrderBatchLimit(process);

  try {
    const listResponse = await client.get({
      path: "orders",
      query: {
        limit: perPage,
        status: "any",
        fields:
          "id,order_number,email,financial_status,fulfillment_status,line_items,total_price,subtotal_price,total_discounts,total_shipping_price_set,billing_address,customer",
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
        recordOrderSkip(stats, {
          store: "shopify",
          remote_id: remote?.id,
          order_number: remote?.order_number,
          reason: "import_error",
          detail: err?.message || String(err),
        }, importCtx);
      }
    }

    const { inserted, skipped, lines_inserted, lines_skipped, skipped_orders } =
      stats;
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
  } catch (error) {
    console.error(
      "Shopify latest order fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch latest orders from Shopify.";
    const errorMessage =
      typeof errorPayload === "string" ?
        errorPayload
      : errorPayload?.message || JSON.stringify(errorPayload);
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "shopify",
      errorMessage,
    });
    return failFetchOrderBatch(process, res, errorPayload, errorPayload);
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

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset, page } = resolveBatchPagination(process);
  const query = {
    limit,
    order: "id asc",
  };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
    const warehouseId = await resolveCompanyDefaultWarehouseId(companyId);
    if (!warehouseId) {
      console.warn(
        "[shopify fetch_product] company has no default warehouse_id; products will import without stock.",
      );
    }

    const listResponse = await client.get({ path: "products", query });
    const remoteProducts =
      Array.isArray(listResponse?.body?.products) ?
        listResponse.body.products
      : [];
    const stats = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      stock_synced: 0,
      stock_updated: 0,
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
        const variant = Array.isArray(remote?.variants) ? remote.variants[0] : null;
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
          warehouseId,
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
      stock_synced = 0,
      stock_updated = 0,
      categories_found = 0,
      categories_inserted = 0,
      products_category_linked = 0,
      variations_fetched = 0,
      variations_inserted = 0,
      variations_updated = 0,
    } = stats;
    const fetched = remoteProducts.length;
    const isComplete = fetched < limit;
    const lastRemoteId = fetched > 0 ? remoteProducts[fetched - 1]?.id : offset;
    const stockSummary = warehouseId ?
        `, stock synced ${stock_synced} (${stock_updated} qty changed)`
      : ", stock skipped (no default warehouse on company)";
    const variationSummary =
      variations_fetched > 0 ?
        `, variations fetched ${variations_fetched}, inserted ${variations_inserted}, updated ${variations_updated}`
      : "";
    const remarks =
      isComplete ?
        `Product import completed: batch fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}${stockSummary}${variationSummary}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}${stockSummary}${variationSummary}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}. Call execute-process again for page ${page + 1}.`;

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
  } catch (error) {
    console.error(
      "Shopify product fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch products from Shopify.";
    return failFetchProductBatch(process, res, errorPayload, errorPayload);
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
  fetch_product,
  sync_product,
  sync_category,
  sync_brand,
};

const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const Category = require("../models/category");
const Brand = require("../models/brands");
const Product = require("../models/product");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const SyncCategory = require("../models/sync_category");
const {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  upsertSyncProductMapping,
  findPosProductBySyncReference,
  resolveBatchPagination,
  resolveLatestOrderBatchLimit,
  findExistingCategory,
  findExistingBrand,
  findExistingProduct,
  findExistingProductBySku,
  findExistingProductByName,
  sortWooCategoriesForImport,
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
  mapWooOrderStatus,
  createFetchOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
  logFetchOrderImported,
  logFetchOrderBatchFailed,
  fallbackRemoteOrderLinesSubtotal,
} = require("../utils/processHelpers");

async function recordBrandSyncMapping(
  process,
  companyId,
  posBrandId,
  websiteBrandId,
  stats,
) {
  try {
    const row = await upsertSyncBrandMapping({
      brandId: posBrandId,
      integrationId: resolveIntegrationId(process),
      companyId,
      referenceId: websiteBrandId,
      createdBy: process.created_by?._id || process.created_by,
    });
    if (row && stats) {
      stats.sync_brand_mapped = (stats.sync_brand_mapped || 0) + 1;
    }
    return row;
  } catch (error) {
    console.warn(
      `sync_brand mapping failed for brand ${websiteBrandId}:`,
      error?.message || error,
    );
    return null;
  }
}

async function importWooBrandToPos(
  remoteWooBrand,
  { companyId, process, wooToLocalBrandIds, stats },
) {
  const wooId = Number(remoteWooBrand?.id);
  if (!wooId) {
    return null;
  }

  if (wooToLocalBrandIds.has(wooId)) {
    return wooToLocalBrandIds.get(wooId);
  }

  const name = String(remoteWooBrand?.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(remoteWooBrand?.slug || "").trim() || categorySlugFromName(name);
  const existing = await findExistingBrand(name, slug, companyId);

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    wooToLocalBrandIds.set(wooId, posId);
    stats.skipped += 1;
    await recordBrandSyncMapping(process, companyId, posId, wooId, stats);
    return posId;
  }

  const created = await Brand.create({
    name,
    slug,
    description: remoteWooBrand.description || name,
    parent_id: null,
    company_id: companyId,
    status: "active",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  const posId = coalesceObjectId(created._id);
  wooToLocalBrandIds.set(wooId, posId);
  stats.inserted += 1;
  await recordBrandSyncMapping(process, companyId, posId, wooId, stats);
  return posId;
}

function mapWooProductType(remoteType) {
  return String(remoteType || "").toLowerCase() === "variable" ?
      "Variable"
    : "Single";
}

function mapWooProductPrice(remote) {
  const candidates = [
    remote?.regular_price,
    remote?.price,
    remote?.sale_price,
  ];
  for (const raw of candidates) {
    if (raw == null || raw === "") {
      continue;
    }
    const price = Number(raw);
    if (Number.isFinite(price) && price >= 0) {
      return price;
    }
  }
  return 0;
}

async function fetchWooProductById(client, wooId, remoteById) {
  const id = Number(wooId);
  if (!id) {
    return null;
  }

  if (remoteById?.has(id)) {
    return remoteById.get(id);
  }

  const response = await client.get(`products/${id}`);
  const data = response?.data;
  if (data?.id != null && remoteById) {
    remoteById.set(Number(data.id), data);
  }
  return data || null;
}

async function resolveWooProductPrice(client, remote) {
  let price = mapWooProductPrice(remote);
  if (price > 0) {
    return price;
  }

  const wooId = Number(remote?.id);
  const isVariable = String(remote?.type || "").toLowerCase() === "variable";
  if (!isVariable || !wooId) {
    return price;
  }

  try {
    const response = await client.get(`products/${wooId}/variations`, {
      per_page: 1,
      orderby: "id",
      order: "asc",
    });
    const variations = Array.isArray(response?.data) ? response.data : [];
    if (variations[0]) {
      price = mapWooProductPrice(variations[0]);
    }
  } catch (error) {
    console.warn(
      `WooCommerce variation price lookup failed for product ${wooId}:`,
      error?.response?.data || error.message,
    );
  }

  return price;
}

function formatWooVariationLabel(variation) {
  const attrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
  const options = attrs
    .map((attr) => String(attr?.option || "").trim())
    .filter(Boolean);
  if (options.length) {
    return options.join(" x ");
  }

  const fallback = String(variation?.name || "").trim();
  if (!fallback) {
    return "";
  }
  return fallback
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" x ");
}

function buildWooVariationProductName(parentName, variation) {
  const label = formatWooVariationLabel(variation);
  if (!label) {
    return parentName;
  }
  return `${parentName} [${label}]`;
}

function buildWooVariationSku(parentSku, wooParentId, variationId) {
  const base =
    String(parentSku || "").trim() ||
    (wooParentId ? `wc-${wooParentId}` : "wc-var");
  return `${base}-var-${variationId}`;
}

async function fetchAllWooProductVariations(client, wooProductId) {
  const wooId = Number(wooProductId);
  if (!wooId) {
    return [];
  }

  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await client.get(`products/${wooId}/variations`, {
      page,
      per_page: perPage,
      orderby: "id",
      order: "asc",
    });
    const batch = Array.isArray(response?.data) ? response.data : [];
    all.push(...batch);
    if (batch.length < perPage) {
      break;
    }
    page += 1;
  }

  return all;
}

async function recordProductSyncMapping(
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
      `sync_product mapping failed for product ${websiteProductId}:`,
      error?.message || error,
    );
    return null;
  }
}

async function findPosProductForWooImport({
  process,
  companyId,
  wooReferenceId,
  sku,
  name,
}) {
  const integrationId = resolveIntegrationId(process);
  if (wooReferenceId && integrationId) {
    const bySync = await findPosProductBySyncReference(
      integrationId,
      companyId,
      wooReferenceId,
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

async function upsertWooProductRow({
  remote,
  name,
  sku,
  productType,
  productPrice,
  categoryIds,
  parentProductId,
  companyId,
  process,
  stats,
  wooReferenceId,
  isVariation = false,
}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    return null;
  }

  const categoryField = categoryIds.map((id) => coalesceObjectId(id)).filter(Boolean);
  const existing = await findPosProductForWooImport({
    process,
    companyId,
    wooReferenceId,
    sku,
    name: trimmedName,
  });

  const payload = {
    product_name: trimmedName,
    product_price: productPrice,
    product_description:
      remote?.description ||
      remote?.short_description ||
      "",
    product_type: productType,
    sku,
    product_code: sku,
    category_id: categoryField,
  };

  if (remote?.weight != null && remote.weight !== "") {
    payload.weight = Number(remote.weight);
  }

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

  if (wooReferenceId) {
    await recordProductSyncMapping(process, companyId, posId, wooReferenceId, stats);
  }

  if (categoryField.length) {
    stats.products_category_linked = (stats.products_category_linked || 0) + 1;
  }

  return posId;
}

async function importWooVariableProductToPos(
  remoteWooProduct,
  { client, companyId, process, stats, productPrice, categoryIds },
) {
  const wooParentId = Number(remoteWooProduct?.id);
  const parentName = String(remoteWooProduct?.name || "").trim();
  if (!wooParentId || !parentName) {
    return null;
  }

  const parentSku =
    String(remoteWooProduct?.sku || "").trim() || `wc-${wooParentId}`;

  const variations = await fetchAllWooProductVariations(client, wooParentId);
  stats.variations_fetched = (stats.variations_fetched || 0) + variations.length;

  const variationPrices = variations
    .map((variation) => mapWooProductPrice(variation))
    .filter((price) => price > 0);
  const parentDisplayPrice =
    variationPrices.length > 0 ?
      Math.min(...variationPrices)
    : productPrice;

  const parentPosId = await upsertWooProductRow({
    remote: remoteWooProduct,
    name: parentName,
    sku: parentSku,
    productType: "Variable",
    productPrice: parentDisplayPrice,
    categoryIds,
    parentProductId: null,
    companyId,
    process,
    stats,
    wooReferenceId: String(wooParentId),
    isVariation: false,
  });

  if (!parentPosId) {
    return null;
  }

  for (const variation of variations) {
    const variationId = Number(variation?.id);
    if (!variationId) {
      continue;
    }

    const variationName = buildWooVariationProductName(parentName, variation);
    const variationSku = buildWooVariationSku(
      parentSku,
      wooParentId,
      variationId,
    );
    const variationPrice = mapWooProductPrice(variation);
    const resolvedVariationPrice =
      variationPrice > 0 ? variationPrice : parentDisplayPrice;

    await upsertWooProductRow({
      remote: variation,
      name: variationName,
      sku: variationSku,
      productType: "Single",
      productPrice: resolvedVariationPrice,
      categoryIds,
      parentProductId: parentPosId,
      companyId,
      process,
      stats,
      wooReferenceId: `${wooParentId}:${variationId}`,
      isVariation: true,
    });
  }

  return parentPosId;
}

function buildPosFieldsFromWoo(remoteWooProduct, productPrice) {
  const fields = {
    product_name: String(remoteWooProduct?.name || "").trim(),
    product_price: productPrice,
    product_description:
      remoteWooProduct?.description ||
      remoteWooProduct?.short_description ||
      "",
    product_type: mapWooProductType(remoteWooProduct?.type),
  };

  if (
    remoteWooProduct?.weight != null &&
    remoteWooProduct.weight !== ""
  ) {
    fields.weight = Number(remoteWooProduct.weight);
  }

  return fields;
}

/**
 * Find POS category by WooCommerce name, or insert. Returns POS _id.
 */
async function ensurePosCategoryFromWooCategory(
  categoryRef,
  { client, companyId, process, remoteCategoryById, categoryCache, stats },
) {
  const wooId = Number(categoryRef?.id);
  let remote = categoryRef;

  if (wooId && categoryCache?.has(wooId)) {
    return categoryCache.get(wooId);
  }

  if (
    wooId &&
    (!remote?.name || !String(remote.name).trim())
  ) {
    remote =
      (await fetchWooCategoryById(client, wooId, remoteCategoryById)) || remote;
  }

  const name = String(remote?.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(remote?.slug || "").trim() || categorySlugFromName(name);
  const integrationId = resolveIntegrationId(process);

  if (wooId && integrationId) {
    const syncRow = await SyncCategory.findOne({
      integration_id: integrationId,
      company_id: companyId,
      refference_id: String(wooId),
      deletedAt: null,
    }).lean();
    if (syncRow?.category_id) {
      const posId = coalesceObjectId(syncRow.category_id);
      if (categoryCache && wooId) {
        categoryCache.set(wooId, posId);
      }
      return posId;
    }
  }

  const existing = await findExistingCategory(name, slug, companyId);
  if (existing) {
    const posId = coalesceObjectId(existing._id);
    if (wooId) {
      await recordCategorySyncMapping(process, companyId, posId, wooId, stats);
      if (categoryCache) {
        categoryCache.set(wooId, posId);
      }
    }
    stats.categories_found = (stats.categories_found || 0) + 1;
    return posId;
  }

  const created = await Category.create({
    name,
    slug,
    description: remote?.description || "",
    parent_id: null,
    company_id: companyId,
    status: "active",
    isActive: remote?.display !== "hidden",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });
  const posId = coalesceObjectId(created._id);
  if (wooId) {
    await recordCategorySyncMapping(process, companyId, posId, wooId, stats);
    if (categoryCache) {
      categoryCache.set(wooId, posId);
    }
  }
  stats.categories_inserted = (stats.categories_inserted || 0) + 1;
  return posId;
}

async function resolvePosCategoryIdsFromWooProduct(
  remoteProduct,
  categoryCtx,
) {
  const remoteCategories = Array.isArray(remoteProduct?.categories) ?
      remoteProduct.categories
    : [];
  const posIds = [];
  const seen = new Set();

  for (const ref of remoteCategories) {
    const posId = await ensurePosCategoryFromWooCategory(ref, categoryCtx);
    if (!posId) {
      continue;
    }
    const key = String(posId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    posIds.push(posId);
  }

  return posIds;
}

async function importWooProductToPos(
  remoteWooProduct,
  { client, companyId, process, stats, productPrice, categoryIds = [] },
) {
  const wooId = Number(remoteWooProduct?.id);
  const name = String(remoteWooProduct?.name || "").trim();
  if (!name) {
    return null;
  }

  const isVariable =
    String(remoteWooProduct?.type || "").toLowerCase() === "variable";
  if (isVariable && client) {
    return importWooVariableProductToPos(remoteWooProduct, {
      client,
      companyId,
      process,
      stats,
      productPrice,
      categoryIds,
    });
  }

  const sku =
    String(remoteWooProduct?.sku || "").trim() ||
    (wooId ? `wc-${wooId}` : "");

  return upsertWooProductRow({
    remote: remoteWooProduct,
    name,
    sku,
    productType: "Single",
    productPrice,
    categoryIds,
    parentProductId: null,
    companyId,
    process,
    stats,
    wooReferenceId: wooId ? String(wooId) : "",
    isVariation: false,
  });
}

async function recordCategorySyncMapping(
  process,
  companyId,
  posCategoryId,
  websiteCategoryId,
  stats,
) {
  const row = await upsertSyncCategoryMapping({
    categoryId: posCategoryId,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId: websiteCategoryId,
    createdBy: process.created_by?._id || process.created_by,
  });
  if (row && stats) {
    stats.sync_category_mapped = (stats.sync_category_mapped || 0) + 1;
  }
  return row;
}

function buildWooCommerceClient(integration) {
  const storeUrl =
    typeof integration.url === "string" ? integration.url.trim() : "";
  const consumerKey =
    integration.key ||
    integration.secret_key ||
    integration.consumer_key ||
    integration.client_key ||
    integration.public_key;
  const consumerSecret =
    integration.secret ||
    integration.api_key ||
    integration.consumer_secret ||
    integration.client_secret ||
    integration.private_key;

  if (!storeUrl || !consumerKey || !consumerSecret) {
    return {
      error:
        "WooCommerce credentials are incomplete. Please verify url, key, and secret.",
    };
  }

  return {
    client: new WooCommerceRestApi({
      url: storeUrl,
      consumerKey,
      consumerSecret,
      version: "wc/v3",
    }),
  };
}

function validateWooIntegration(integration, res) {
  if (!integration || integration.store_type !== "woocommerce") {
    res.status(400).json({
      success: false,
      message: "WooCommerce integration details are missing or invalid.",
    });
    return false;
  }
  return true;
}

async function fetchWooCategoryById(client, wooId, remoteById) {
  const id = Number(wooId);
  if (!id) {
    return null;
  }

  if (remoteById.has(id)) {
    return remoteById.get(id);
  }

  const response = await client.get(`products/categories/${id}`);
  const data = response?.data;
  if (data?.id != null) {
    remoteById.set(Number(data.id), data);
  }
  return data || null;
}

async function fetchWooBrandById(client, wooId, remoteById) {
  const id = Number(wooId);
  if (!id) {
    return null;
  }

  if (remoteById.has(id)) {
    return remoteById.get(id);
  }

  const response = await client.get(`products/brands/${id}`);
  const data = response?.data;
  if (data?.id != null) {
    remoteById.set(Number(data.id), data);
  }
  return data || null;
}

function getWooCategoryId(remote) {
  const id = Number(remote?.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/** WooCommerce `parent` may be number, numeric string, or { id }. */
function getWooParentId(remote) {
  const parent = remote?.parent;
  if (parent == null || parent === "" || parent === false) {
    return 0;
  }
  if (typeof parent === "object") {
    const id = Number(parent.id ?? parent.ID ?? 0);
    return Number.isFinite(id) && id > 0 ? id : 0;
  }
  const id = Number(parent);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function trackParentFound(stats, wooId) {
  if (!stats.parentFoundIds) {
    stats.parentFoundIds = new Set();
  }
  const id = Number(wooId);
  if (!stats.parentFoundIds.has(id)) {
    stats.parentFoundIds.add(id);
    stats.parent_found += 1;
  }
}

function trackParentInserted(stats, wooId) {
  if (!stats.parentInsertedIds) {
    stats.parentInsertedIds = new Set();
  }
  const id = Number(wooId);
  if (!stats.parentInsertedIds.has(id)) {
    stats.parentInsertedIds.add(id);
    stats.parent_inserted += 1;
  }
}

/**
 * Child has remote.parent = WooCommerce category id (e.g. 69), not a POS id.
 * 1. GET products/categories/69 from WooCommerce
 * 2. Search POS by that category's name (then slug)
 * 3. Return existing _id, or insert and return new _id
 */
async function resolvePosParentIdFromWooParentId(
  wooParentId,
  { client, companyId, process, remoteById, wooToLocalCategoryIds, stats },
) {
  const wcParentId = Number(wooParentId);
  if (!wcParentId) {
    return null;
  }

  if (wooToLocalCategoryIds.has(wcParentId)) {
    return coalesceObjectId(wooToLocalCategoryIds.get(wcParentId));
  }

  let parentRemote;
  try {
    parentRemote = await fetchWooCategoryById(client, wcParentId, remoteById);
  } catch (error) {
    console.warn(
      `WooCommerce parent category ${wcParentId} not found:`,
      error?.response?.data || error.message,
    );
    return null;
  }

  if (!parentRemote) {
    return null;
  }

  const name = String(parentRemote.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(parentRemote.slug || "").trim() || categorySlugFromName(name);

  const grandParentPosId = await resolvePosParentIdFromWooParentId(
    getWooParentId(parentRemote),
    { client, companyId, process, remoteById, wooToLocalCategoryIds, stats },
  );

  const existing = await findExistingCategory(name, slug, companyId);
  if (existing) {
    const posId = coalesceObjectId(existing._id);
    wooToLocalCategoryIds.set(wcParentId, posId);
    trackParentFound(stats, wcParentId);
    if (grandParentPosId && !existing.parent_id) {
      await Category.findByIdAndUpdate(posId, {
        parent_id: coalesceObjectId(grandParentPosId),
      });
    }
    await recordCategorySyncMapping(
      process,
      companyId,
      posId,
      wcParentId,
      stats,
    );
    return posId;
  }

  const created = await Category.create({
    name,
    slug,
    description: parentRemote.description || "",
    parent_id: grandParentPosId || null,
    company_id: companyId,
    status: "active",
    isActive: parentRemote.display !== "hidden",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  wooToLocalCategoryIds.set(wcParentId, created._id);
  trackParentInserted(stats, wcParentId);
  const posId = coalesceObjectId(created._id);
  await recordCategorySyncMapping(
    process,
    companyId,
    posId,
    wcParentId,
    stats,
  );
  return posId;
}

/**
 * Child has remote.parent = WooCommerce brand id, not a POS id.
 * 1. GET products/brands/{id} from WooCommerce
 * 2. Search POS by that brand's name (then slug)
 * 3. Return existing _id, or insert and return new _id
 */
async function resolvePosBrandParentIdFromWooParentId(
  wooParentId,
  { client, companyId, process, remoteById, wooToLocalBrandIds, stats },
) {
  const wcParentId = Number(wooParentId);
  if (!wcParentId) {
    return null;
  }

  if (wooToLocalBrandIds.has(wcParentId)) {
    return coalesceObjectId(wooToLocalBrandIds.get(wcParentId));
  }

  let parentRemote;
  try {
    parentRemote = await fetchWooBrandById(client, wcParentId, remoteById);
  } catch (error) {
    console.warn(
      `WooCommerce parent brand ${wcParentId} not found:`,
      error?.response?.data || error.message,
    );
    return null;
  }

  if (!parentRemote) {
    return null;
  }

  const name = String(parentRemote.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(parentRemote.slug || "").trim() || categorySlugFromName(name);

  const grandParentPosId = await resolvePosBrandParentIdFromWooParentId(
    getWooParentId(parentRemote),
    { client, companyId, process, remoteById, wooToLocalBrandIds, stats },
  );

  const existing = await findExistingBrand(name, slug, companyId);
  if (existing) {
    const posId = coalesceObjectId(existing._id);
    wooToLocalBrandIds.set(wcParentId, posId);
    trackParentFound(stats, wcParentId);
    if (grandParentPosId && !existing.parent_id) {
      await Brand.findByIdAndUpdate(posId, {
        parent_id: coalesceObjectId(grandParentPosId),
      });
    }
    await recordBrandSyncMapping(process, companyId, posId, wcParentId, stats);
    return posId;
  }

  const created = await Brand.create({
    name,
    slug,
    description: parentRemote.description || name,
    parent_id: grandParentPosId || null,
    company_id: companyId,
    status: "active",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  wooToLocalBrandIds.set(wcParentId, created._id);
  trackParentInserted(stats, wcParentId);
  const posId = coalesceObjectId(created._id);
  await recordBrandSyncMapping(process, companyId, posId, wcParentId, stats);
  return posId;
}

/** Pass 1: import category by name/slug only (no parent_id yet). */
async function importWooCategoryToPos(
  remoteWooCategory,
  { companyId, process, wooToLocalCategoryIds, stats },
) {
  const wooId = getWooCategoryId(remoteWooCategory);
  if (!wooId) {
    return null;
  }

  if (wooToLocalCategoryIds.has(wooId)) {
    return wooToLocalCategoryIds.get(wooId);
  }

  const name = String(remoteWooCategory?.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(remoteWooCategory?.slug || "").trim() || categorySlugFromName(name);
  const existing = await findExistingCategory(name, slug, companyId);

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    wooToLocalCategoryIds.set(wooId, posId);
    stats.skipped += 1;
    await recordCategorySyncMapping(
      process,
      companyId,
      posId,
      wooId,
      stats,
    );
    return posId;
  }

  const created = await Category.create({
    name,
    slug,
    description: remoteWooCategory.description || "",
    parent_id: null,
    company_id: companyId,
    status: "active",
    isActive: remoteWooCategory.display !== "hidden",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  const posId = coalesceObjectId(created._id);
  wooToLocalCategoryIds.set(wooId, posId);
  stats.inserted += 1;
  await recordCategorySyncMapping(process, companyId, posId, wooId, stats);
  return posId;
}

/**
 * Pass 2: remote.parent is WooCommerce id → fetch parent from WC → find POS by name → set parent_id.
 */
async function linkWooCategoryParentInPos(
  remoteWooCategory,
  { client, companyId, process, remoteById, wooToLocalCategoryIds, stats },
) {
  const wooId = getWooCategoryId(remoteWooCategory);
  const wooParentId = getWooParentId(remoteWooCategory);
  if (!wooId || wooParentId <= 0) {
    return;
  }

  const childPosId = coalesceObjectId(wooToLocalCategoryIds.get(wooId));
  if (!childPosId) {
    return;
  }

  const parentPosId = await resolvePosParentIdFromWooParentId(wooParentId, {
    client,
    companyId,
    process,
    remoteById,
    wooToLocalCategoryIds,
    stats,
  });

  if (!parentPosId) {
    stats.parent_unresolved = (stats.parent_unresolved || 0) + 1;
    return;
  }

  const parentRef = coalesceObjectId(parentPosId);
  await Category.updateOne(
    { _id: childPosId },
    { $set: { parent_id: parentRef } },
  );

  const childName = String(remoteWooCategory?.name || "").trim();
  let parentName = "";
  const parentRemote =
    remoteById.get(wooParentId) ||
    (await fetchWooCategoryById(client, wooParentId, remoteById));
  if (parentRemote?.name) {
    parentName = String(parentRemote.name).trim();
  } else {
    const parentDoc = await Category.findById(parentRef).select("name").lean();
    parentName = String(parentDoc?.name || "").trim();
  }

  if (!stats.parent_linked_categories) {
    stats.parent_linked_categories = [];
  }
  stats.parent_linked_categories.push({
    name: childName,
    parent_name: parentName,
    woo_id: wooId,
    woo_parent_id: wooParentId,
  });
  stats.parent_linked = (stats.parent_linked || 0) + 1;
}

/**
 * Pass 2: remote.parent is WooCommerce id → fetch parent from WC → find POS by name → set parent_id.
 */
async function linkWooBrandParentInPos(
  remoteWooBrand,
  { client, companyId, process, remoteById, wooToLocalBrandIds, stats },
) {
  const wooId = getWooCategoryId(remoteWooBrand);
  const wooParentId = getWooParentId(remoteWooBrand);
  if (!wooId || wooParentId <= 0) {
    return;
  }

  const childPosId = coalesceObjectId(wooToLocalBrandIds.get(wooId));
  if (!childPosId) {
    return;
  }

  const parentPosId = await resolvePosBrandParentIdFromWooParentId(wooParentId, {
    client,
    companyId,
    process,
    remoteById,
    wooToLocalBrandIds,
    stats,
  });

  if (!parentPosId) {
    stats.parent_unresolved = (stats.parent_unresolved || 0) + 1;
    return;
  }

  const parentRef = coalesceObjectId(parentPosId);
  await Brand.updateOne({ _id: childPosId }, { $set: { parent_id: parentRef } });

  stats.parent_linked = (stats.parent_linked || 0) + 1;

  const childName = String(remoteWooBrand?.name || "").trim();
  let parentName = "";
  try {
    const parentRemote =
      remoteById.get(wooParentId) ||
      (await fetchWooBrandById(client, wooParentId, remoteById));
    if (parentRemote?.name) {
      parentName = String(parentRemote.name).trim();
    } else {
      const parentDoc = await Brand.findById(parentRef).select("name").lean();
      parentName = String(parentDoc?.name || "").trim();
    }
  } catch (error) {
    console.warn(
      `Could not resolve parent name for WooCommerce brand ${wooParentId}:`,
      error?.message || error,
    );
  }

  if (!stats.parent_linked_brands) {
    stats.parent_linked_brands = [];
  }
  stats.parent_linked_brands.push({
    name: childName,
    parent_name: parentName,
    woo_id: wooId,
    woo_parent_id: wooParentId,
  });
}

/**
 * Ensure a WooCommerce category exists in POS (single-category sync).
 * Resolves remote.parent via WooCommerce id → POS _id, then find or insert by name.
 */
async function ensureWooCategoryInPos(
  remoteWooCategory,
  { client, companyId, process, remoteById, wooToLocalCategoryIds, stats },
  isRoot = false,
) {
  const wooId = Number(remoteWooCategory?.id);
  if (!wooId) {
    return null;
  }

  if (wooToLocalCategoryIds.has(wooId)) {
    return wooToLocalCategoryIds.get(wooId);
  }

  const wooParentId = getWooParentId(remoteWooCategory);
  let parentPosId = null;

  if (wooParentId > 0) {
    parentPosId = await resolvePosParentIdFromWooParentId(wooParentId, {
      client,
      companyId,
      process,
      remoteById,
      wooToLocalCategoryIds,
      stats,
    });
    parentPosId = parentPosId ? coalesceObjectId(parentPosId) : null;
  }

  const name = String(remoteWooCategory?.name || "").trim();
  if (!name) {
    return null;
  }

  const slug =
    String(remoteWooCategory?.slug || "").trim() || categorySlugFromName(name);
  const existing = await findExistingCategory(name, slug, companyId);

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    wooToLocalCategoryIds.set(wooId, posId);

    if (parentPosId) {
      const needsParentLink =
        !existing.parent_id ||
        String(existing.parent_id) !== String(parentPosId);
      if (needsParentLink) {
        await Category.findByIdAndUpdate(posId, { parent_id: parentPosId });
        if (isRoot) {
          stats.linked += 1;
        }
      } else if (isRoot) {
        stats.skipped += 1;
      }
    } else if (isRoot) {
      stats.skipped += 1;
    }
    await recordCategorySyncMapping(process, companyId, posId, wooId, stats);
    return posId;
  }

  const created = await Category.create({
    name,
    slug,
    description: remoteWooCategory.description || "",
    parent_id: parentPosId,
    company_id: companyId,
    status: "active",
    isActive: remoteWooCategory.display !== "hidden",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  const posId = coalesceObjectId(created._id);
  wooToLocalCategoryIds.set(wooId, posId);

  if (wooParentId > 0 && parentPosId && !created.parent_id) {
    await Category.findByIdAndUpdate(posId, { parent_id: parentPosId });
  }

  if (isRoot) {
    stats.inserted += 1;
  } else {
    trackParentInserted(stats, wooId);
  }
  await recordCategorySyncMapping(process, companyId, posId, wooId, stats);
  return posId;
}

/**
 * Import categories from WooCommerce into POS (batch).
 *
 * Direction: Store → POS (action: fetch_category).
 * Triggered by GET /api/process/execute-process on an active process record.
 *
 * Batch pagination (on the process record):
 *   - limit  — categories per WooCommerce API page (default 5, max 100)
 *   - page   — current WooCommerce page (incremented after each successful batch)
 *   - hits   — how many times execute-process has run for this process
 *   - progress — not_started → started → completed
 *
 * Steps (this function):
 *   1. Validate WooCommerce integration and company_id on the process.
 *   2. Build WooCommerce REST client from integration url / key / secret.
 *   3. GET products/categories?page=&per_page= from WooCommerce (one batch).
 *   4. Sort batch so parents are processed before children when both are on the same page.
 *   5. Pass 1 — import each category by name/slug (parent_id left null).
 *   6. Pass 2 — for each category with WC parent id: fetch parent from WooCommerce,
 *      find POS category by that name, set child.parent_id to POS _id.
 *   7. Update process hits, count, page, progress; return batch stats in the response.
 *   8. If fetched count < limit, mark process completed; else call execute-process again for next page.
 *
 * Per-category logic (ensureWooCategoryInPos):
 *   Example remote: { id: 70, name: "Action Figures", parent: 69 }
 *
 *   A. remote.parent is a WooCommerce id (69), NOT a POS _id.
 *   B. GET products/categories/69 from WooCommerce → { id: 69, name: "Uncategorized", ... }
 *   C. Search POS for a category with that name (then slug) for the same company_id.
 *   D. If parent exists in POS → use its _id as parent_id (stats.parent_found).
 *      If not → insert parent in POS and use new _id (stats.parent_inserted).
 *   E. Search POS for the child by name/slug:
 *      - Not found → insert with parent_id = POS _id from step D (stats.inserted).
 *      - Found → set/update parent_id to POS _id from step D (stats.linked or skipped).
 *
 * Response batch fields:
 *   fetched, inserted, skipped, parent_found, parent_inserted, parent_linked, limit
 */
async function fetch_category(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  // Step 1 — integration must be WooCommerce
  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  // Step 2 — WooCommerce REST client
  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, page } = resolveBatchPagination(process);

  try {
    // Step 3 — fetch one page of categories from WooCommerce
    const response = await client.get("products/categories", {
      page,
      per_page: limit,
      orderby: "id",
      order: "asc",
    });

    // return res.status(200).json({ success: true, message: response });

    // Step 4 — parents before children within this page
    const remoteCategories = sortWooCategoriesForImport(
      Array.isArray(response?.data) ? response.data : [],
    );
    const remoteById = new Map(
      remoteCategories.map((cat) => [Number(cat.id), cat]),
    );
    const wooToLocalCategoryIds = new Map();
    const stats = {
      inserted: 0,
      skipped: 0,
      parent_found: 0,
      parent_inserted: 0,
      parent_linked: 0,
      parent_unresolved: 0,
      parent_linked_categories: [],
      sync_category_mapped: 0,
    };

    const importCtx = {
      client,
      companyId,
      process,
      remoteById,
      wooToLocalCategoryIds,
      stats,
    };

    // Step 5a — import each category (name/slug only; parent_id linked in step 5b)
    for (const remote of remoteCategories) {
      const remoteDetail = await fetchWooCategoryById(
        client,
        remote?.id,
        remoteById,
      );
      const category = remoteDetail || remote;
      const name = String(category?.name || "").trim();
      if (!name) {
        stats.skipped += 1;
        continue;
      }

      try {
        await importWooCategoryToPos(category, importCtx);
      } catch (error) {
        console.error(
          `Failed to import WooCommerce category ${category?.id} (${name}):`,
          error?.message || error,
        );
        stats.skipped += 1;
      }
    }

    // Step 5b — link parent_id: WC parent id → fetch from WC → find POS by name → set _id
    for (const remote of remoteCategories) {
      const remoteDetail = await fetchWooCategoryById(
        client,
        remote?.id,
        remoteById,
      );
      const category = remoteDetail || remote;

      try {
        await linkWooCategoryParentInPos(category, importCtx);
      } catch (error) {
        console.error(
          `Failed to link parent for WooCommerce category ${category?.id}:`,
          error?.message || error,
        );
      }
    }

    const {
      inserted,
      skipped,
      parent_found,
      parent_inserted,
      parent_linked,
      parent_unresolved,
      parent_linked_categories,
      sync_category_mapped,
    } = stats;
    const fetched = remoteCategories.length;
    const isComplete = fetched < limit;

    // Step 6 & 7 — persist process progress and return batch summary
    const remarks =
      isComplete ?
        `Category import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, parent linked ${parent_linked}, parent found ${parent_found}, parent inserted ${parent_inserted}, parent unresolved ${parent_unresolved}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, parent linked ${parent_linked}, parent found ${parent_found}, parent inserted ${parent_inserted}, parent unresolved ${parent_unresolved}. Call execute-process again for page ${page + 1}.`;

    return finishFetchCategoryBatch(req, res, process, {
      fetched,
      inserted,
      skipped,
      parent_found,
      parent_inserted,
      parent_linked,
      parent_unresolved,
      parent_linked_categories,
      sync_category_mapped,
      isComplete,
      remarks,
    });
  } catch (error) {
    console.error(
      "WooCommerce category fetch failed:",
      error?.response?.data || error.message,
    );
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch categories from WooCommerce.";
    return failFetchCategoryBatch(
      process,
      res,
      errorMessage,
      error?.response?.data || error,
    );
  }
}

/**
 * Push one POS product to WooCommerce.
 */
async function sync_product(req, res, process) {
  const integration = process?.integration_id;
  const product = process?.product_id;

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!product) {
    return res.status(400).json({
      success: false,
      message: "Product details are missing from the process payload.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const sku =
    (typeof product.sku === "string" && product.sku.trim()) ||
    (typeof product.product_code === "string" && product.product_code.trim()) ||
    (product._id ? String(product._id) : "");

  if (!sku) {
    return res.status(400).json({
      success: false,
      message:
        "Product SKU or identifier is required to sync with WooCommerce.",
    });
  }

  const productPayload = {
    name: product.product_name,
    type:
      (
        typeof product.product_type === "string" &&
        product.product_type.toLowerCase() === "variable"
      ) ?
        "variable"
      : "simple",
    regular_price:
      product.product_price !== undefined && product.product_price !== null ?
        String(product.product_price)
      : "0",
    sku,
    description: product.product_description || "",
    short_description: product.product_description || "",
    status: "publish",
  };

  if (product.weight !== undefined && product.weight !== null) {
    productPayload.weight = String(product.weight);
  }

  try {
    const existingResponse = await client.get("products", { sku });
    const existingProducts =
      Array.isArray(existingResponse?.data) ? existingResponse.data : [];

    if (existingProducts.length > 0) {
      await markProcessOutcome(
        process._id,
        "completed",
        `Product Name : ${product.product_name} already existed on WooCommerce — skipped creation.`,
      );

      return res.status(200).json({
        success: true,
        data: existingProducts[0],
        message: `Product Name : ${product.product_name} already exists on WooCommerce.`,
      });
    }

    const createdProductResponse = await client.post(
      "products",
      productPayload,
    );

    await markProcessOutcome(
      process._id,
      "completed",
      `Product Name : ${product.product_name} created on WooCommerce.`,
    );

    return res.status(201).json({
      success: true,
      data: createdProductResponse?.data,
      message: `Product Name : ${product.product_name} synced to WooCommerce successfully.`,
    });
  } catch (error) {
    console.error(
      "WooCommerce product sync failed:",
      error?.response?.data || error.message,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Product Name : ${product.product_name} to WooCommerce.`,
    );

    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      `Failed to sync Product Name : ${product.product_name} to WooCommerce.`;

    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: error?.response?.data || error,
    });
  }
}

/**
 * Push one POS category to WooCommerce.
 */
async function sync_category(req, res, process) {
  const integration = process?.integration_id;
  const category = process?.category_id;

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!category) {
    return res.status(400).json({
      success: false,
      message:
        "Category is required for sync_category. Set category_id on the process (Admin → Process) or pass ?category_id=<id> on execute-process.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const name = category.name?.trim();
  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Category name is required to sync with WooCommerce.",
    });
  }

  const slug = category.slug?.trim() || categorySlugFromName(name);
  const categoryPayload = {
    name,
    slug,
    description: category.description || "",
  };
  const companyId = resolveCompanyId(process);

  try {
    const existingResponse = await client.get("products/categories", { slug });
    const existingCategories =
      Array.isArray(existingResponse?.data) ? existingResponse.data : [];

    if (existingCategories.length > 0) {
      await upsertSyncCategoryMapping({
        categoryId: category._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId: existingCategories[0].id,
        createdBy: process.created_by?._id || process.created_by,
      });

      await markProcessOutcome(
        process._id,
        "completed",
        `Category : ${name} already existed on WooCommerce — skipped creation.`,
      );

      return res.status(200).json({
        success: true,
        data: existingCategories[0],
        message: `Category : ${name} already exists on WooCommerce.`,
      });
    }

    const createdCategoryResponse = await client.post(
      "products/categories",
      categoryPayload,
    );

    await upsertSyncCategoryMapping({
      categoryId: category._id,
      integrationId: resolveIntegrationId(process),
      companyId,
      referenceId: createdCategoryResponse?.data?.id,
      createdBy: process.created_by?._id || process.created_by,
    });

    await markProcessOutcome(
      process._id,
      "completed",
      `Category : ${name} created on WooCommerce.`,
    );

    return res.status(201).json({
      success: true,
      data: createdCategoryResponse?.data,
      message: `Category : ${name} synced to WooCommerce successfully.`,
    });
  } catch (error) {
    console.error(
      "WooCommerce category sync failed:",
      error?.response?.data || error.message,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Category : ${name} to WooCommerce.`,
    );

    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      `Failed to sync Category : ${name} to WooCommerce.`;

    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: error?.response?.data || error,
    });
  }
}

/**
 * Fetch WooCommerce category by id, find or create in POS, return local _id.
 * If parent exists on WC (remote.parent), resolves parent first the same way.
 */
async function syncWooCategoryById(
  wooCategoryId,
  companyId,
  client,
  process,
  remoteById,
  wooToLocalCategoryIds,
) {
  const remote = await fetchWooCategoryById(client, wooCategoryId, remoteById);
  if (!remote) {
    return null;
  }

  const stats = { inserted: 0, skipped: 0, linked: 0 };
  const localId = await ensureWooCategoryInPos(
    remote,
    {
      client,
      companyId,
      process,
      remoteById,
      wooToLocalCategoryIds,
      stats,
    },
    true,
  );

  return localId ? { localId, stats } : null;
}

/**
 * Import brands from WooCommerce into POS (batch). Store → POS.
 * Uses GET products/brands (WooCommerce Brands / core brands API).
 */
async function fetch_brand(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, page } = resolveBatchPagination(process);

  try {
    const response = await client.get("products/brands", {
      page,
      per_page: limit,
      orderby: "id",
      order: "asc",
    });
    const remoteBrands = sortWooCategoriesForImport(
      Array.isArray(response?.data) ? response.data : [],
    );
    const remoteById = new Map(
      remoteBrands.map((brand) => [Number(brand.id), brand]),
    );
    const wooToLocalBrandIds = new Map();
    const stats = {
      inserted: 0,
      skipped: 0,
      parent_found: 0,
      parent_inserted: 0,
      parent_linked: 0,
      parent_unresolved: 0,
      parent_linked_brands: [],
      sync_brand_mapped: 0,
    };

    const importCtx = {
      client,
      companyId,
      process,
      remoteById,
      wooToLocalBrandIds,
      stats,
    };

    for (const remote of remoteBrands) {
      const remoteDetail = await fetchWooBrandById(
        client,
        remote?.id,
        remoteById,
      );
      const brand = remoteDetail || remote;
      const name = String(brand?.name || "").trim();
      if (!name) {
        stats.skipped += 1;
        continue;
      }

      try {
        await importWooBrandToPos(brand, importCtx);
      } catch (err) {
        console.error(
          `Failed to import WooCommerce brand ${brand?.id} (${name}):`,
          err?.message || err,
        );
        stats.skipped += 1;
      }
    }

    for (const remote of remoteBrands) {
      const remoteDetail = await fetchWooBrandById(
        client,
        remote?.id,
        remoteById,
      );
      const brand = remoteDetail || remote;

      try {
        await linkWooBrandParentInPos(brand, importCtx);
      } catch (err) {
        console.error(
          `Failed to link parent for WooCommerce brand ${brand?.id}:`,
          err?.message || err,
        );
      }
    }

    const {
      inserted,
      skipped,
      parent_found,
      parent_inserted,
      parent_linked,
      parent_unresolved,
      parent_linked_brands,
      sync_brand_mapped,
    } = stats;
    const fetched = remoteBrands.length;
    const isComplete = fetched < limit;
    const remarks =
      isComplete ?
        `Brand import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, parent linked ${parent_linked}, parent found ${parent_found}, parent inserted ${parent_inserted}, parent unresolved ${parent_unresolved}, sync mapped ${sync_brand_mapped}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}, parent linked ${parent_linked}, parent found ${parent_found}, parent inserted ${parent_inserted}, parent unresolved ${parent_unresolved}, sync mapped ${sync_brand_mapped}. Call execute-process again for page ${page + 1}.`;

    return finishFetchBrandBatch(req, res, process, {
      fetched,
      inserted,
      skipped,
      parent_found,
      parent_inserted,
      parent_linked,
      parent_unresolved,
      parent_linked_brands,
      sync_brand_mapped,
      isComplete,
      remarks,
    });
  } catch (error) {
    console.error(
      "WooCommerce brand fetch failed:",
      error?.response?.data || error.message,
    );
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch brands from WooCommerce (products/brands). Ensure WooCommerce Brands is enabled.";
    return failFetchBrandBatch(
      process,
      res,
      errorMessage,
      error?.response?.data || error,
    );
  }
}

async function importWooOrderToPos(remoteOrder, ctx) {
  const { companyId, process, stats, req } = ctx;
  const logCtx = { req, process, companyId };
  const integrationId = resolveIntegrationId(process);
  const remoteId = remoteOrder?.id;
  const externalRef = orderExternalRef("woocommerce", remoteId);
  const integrationOrderId = resolveIntegrationOrderId(
    "woocommerce",
    remoteOrder,
    remoteId,
  );

  if (!externalRef) {
    recordOrderSkip(stats, {
      store: "woocommerce",
      remote_id: remoteId,
      order_number: remoteOrder?.number,
      reason: "missing_remote_id",
      detail: "WooCommerce order has no id",
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
      store: "woocommerce",
      remote_id: remoteId,
      order_number: remoteOrder?.number,
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
    linesSubtotal = fallbackRemoteOrderLinesSubtotal(remoteOrder, "woocommerce");
  }

  const billing = remoteOrder?.billing || {};
  const customerName = [billing.first_name, billing.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  const order = await Order.create({
    name:
      customerName ||
      `WooCommerce #${remoteOrder?.number || remoteId}`,
    email: billing.email || "",
    phone: billing.phone || "",
    address: [
      billing.address_1,
      billing.address_2,
      billing.city,
      billing.state,
      billing.postcode,
      billing.country,
    ]
      .filter(Boolean)
      .join(", "),
    description: externalRef,
    integration_order_id: integrationOrderId,
    discount: Number(remoteOrder?.discount_total) || 0,
    shipment: Number(remoteOrder?.shipping_total) || 0,
    lines_subtotal: linesSubtotal,
    amount_received: Number(remoteOrder?.total) || 0,
    order_status: mapWooOrderStatus(remoteOrder?.status),
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
      store: "woocommerce",
      remoteId,
      orderNumber: remoteOrder?.number,
      posOrderId: order._id,
      posOrderNo: order.order_no,
      lineCount: orderItemsPayload.length,
    });
  }
}

/**
 * Import orders from WooCommerce into POS (batch). Store → POS.
 */
async function fetch_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, page } = resolveBatchPagination(process);

  try {
    const response = await client.get("orders", {
      page,
      per_page: limit,
      orderby: "id",
      order: "asc",
    });
    const remoteOrders = Array.isArray(response?.data) ? response.data : [];
    const stats = createFetchOrderStats();

    const importCtx = { companyId, process, stats, req };

    for (const remote of remoteOrders) {
      try {
        await importWooOrderToPos(remote, importCtx);
      } catch (err) {
        console.error(
          `Failed to import WooCommerce order ${remote?.id}:`,
          err?.message || err,
        );
        recordOrderSkip(stats, {
          store: "woocommerce",
          remote_id: remote?.id,
          order_number: remote?.number,
          reason: "import_error",
          detail: err?.message || String(err),
        }, importCtx);
      }
    }

    const { inserted, skipped, lines_inserted, lines_skipped, skipped_orders } =
      stats;
    const fetched = remoteOrders.length;
    const isComplete = fetched < limit;
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
      remarks,
    });
  } catch (error) {
    console.error(
      "WooCommerce order fetch failed:",
      error?.response?.data || error.message,
    );
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch orders from WooCommerce.";
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "woocommerce",
      errorMessage,
    });
    return failFetchOrderBatch(
      process,
      res,
      errorMessage,
      error?.response?.data || error,
    );
  }
}

/**
 * Poll newest WooCommerce orders (newest first) and import any not yet in POS.
 * One execute-process call; process stays active for recurring cron runs.
 * `limit` = how many recent store orders to check (default 20, max 100).
 */
async function fetch_latest_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const perPage = resolveLatestOrderBatchLimit(process);

  try {
    const response = await client.get("orders", {
      page: 1,
      per_page: perPage,
      orderby: "id",
      order: "desc",
    });
    const remoteOrders = Array.isArray(response?.data) ? response.data : [];
    const stats = createFetchOrderStats();
    const importCtx = { companyId, process, stats, req };

    for (const remote of remoteOrders) {
      try {
        await importWooOrderToPos(remote, importCtx);
      } catch (err) {
        console.error(
          `Failed to import WooCommerce order ${remote?.id}:`,
          err?.message || err,
        );
        recordOrderSkip(stats, {
          store: "woocommerce",
          remote_id: remote?.id,
          order_number: remote?.number,
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
      "WooCommerce latest order fetch failed:",
      error?.response?.data || error.message,
    );
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch latest orders from WooCommerce.";
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "woocommerce",
      errorMessage,
    });
    return failFetchOrderBatch(
      process,
      res,
      errorMessage,
      error?.response?.data || error,
    );
  }
}

/**
 * Import products from WooCommerce into POS (batch). Store → POS.
 */
async function fetch_product(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, page } = resolveBatchPagination(process);

  try {
    const response = await client.get("products", {
      page,
      per_page: limit,
      orderby: "id",
      order: "asc",
      status: "publish",
    });
    const remoteProducts = Array.isArray(response?.data) ? response.data : [];
    const remoteById = new Map(
      remoteProducts.map((product) => [Number(product.id), product]),
    );
    const categoryCache = new Map();
    const remoteCategoryById = new Map();
    const categoryCtx = {
      client,
      companyId,
      process,
      remoteCategoryById,
      categoryCache,
      stats: null,
    };
    const stats = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      categories_found: 0,
      categories_inserted: 0,
      products_category_linked: 0,
      sync_category_mapped: 0,
      sync_product_mapped: 0,
      variations_fetched: 0,
      variations_inserted: 0,
      variations_updated: 0,
    };
    categoryCtx.stats = stats;

    for (const remote of remoteProducts) {
      const remoteDetail =
        (await fetchWooProductById(client, remote?.id, remoteById)) || remote;
      const name = String(remoteDetail?.name || "").trim();
      if (!name) {
        stats.skipped += 1;
        continue;
      }

      try {
        const productPrice = await resolveWooProductPrice(client, remoteDetail);
        const categoryIds = await resolvePosCategoryIdsFromWooProduct(
          remoteDetail,
          categoryCtx,
        );
        await importWooProductToPos(remoteDetail, {
          client,
          companyId,
          process,
          stats,
          productPrice,
          categoryIds,
        });
      } catch (err) {
        console.error(
          `Failed to import WooCommerce product ${remoteDetail?.id} (${name}):`,
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
    const remarks =
      isComplete ?
        `Product import completed: batch fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, variations fetched ${variations_fetched}, variations inserted ${variations_inserted}, variations updated ${variations_updated}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, variations fetched ${variations_fetched}, variations inserted ${variations_inserted}, variations updated ${variations_updated}. Call execute-process again for page ${page + 1}.`;

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
      remarks,
    });
  } catch (error) {
    console.error(
      "WooCommerce product fetch failed:",
      error?.response?.data || error.message,
    );
    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      "Failed to fetch products from WooCommerce.";
    return failFetchProductBatch(
      process,
      res,
      errorMessage,
      error?.response?.data || error,
    );
  }
}

/**
 * Push one POS brand to WooCommerce.
 */
async function sync_brand(req, res, process) {
  const integration = process?.integration_id;
  const brand = process?.brand_id;

  if (!validateWooIntegration(integration, res)) {
    return;
  }

  if (!brand) {
    return res.status(400).json({
      success: false,
      message:
        "Brand is required for sync_brand. Set brand_id on the process (Admin → Process) or pass ?brand_id=<id> on execute-process.",
    });
  }

  const { client, error } = buildWooCommerceClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const name = brand.name?.trim();
  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Brand name is required to sync with WooCommerce.",
    });
  }

  const slug = brand.slug?.trim() || categorySlugFromName(name);
  const brandPayload = {
    name,
    slug,
    description: brand.description || name,
  };
  const companyId = resolveCompanyId(process);

  try {
    const existingResponse = await client.get("products/brands", { slug });
    const existingBrands =
      Array.isArray(existingResponse?.data) ? existingResponse.data : [];

    if (existingBrands.length > 0) {
      await upsertSyncBrandMapping({
        brandId: brand._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId: existingBrands[0].id,
        createdBy: process.created_by?._id || process.created_by,
      });

      await markProcessOutcome(
        process._id,
        "completed",
        `Brand : ${name} already existed on WooCommerce — skipped creation.`,
      );

      return res.status(200).json({
        success: true,
        data: existingBrands[0],
        message: `Brand : ${name} already exists on WooCommerce.`,
      });
    }

    const createdBrandResponse = await client.post(
      "products/brands",
      brandPayload,
    );

    await upsertSyncBrandMapping({
      brandId: brand._id,
      integrationId: resolveIntegrationId(process),
      companyId,
      referenceId: createdBrandResponse?.data?.id,
      createdBy: process.created_by?._id || process.created_by,
    });

    await markProcessOutcome(
      process._id,
      "completed",
      `Brand : ${name} created on WooCommerce.`,
    );

    return res.status(201).json({
      success: true,
      data: createdBrandResponse?.data,
      message: `Brand : ${name} synced to WooCommerce successfully.`,
    });
  } catch (error) {
    console.error(
      "WooCommerce brand sync failed:",
      error?.response?.data || error.message,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Brand : ${name} to WooCommerce.`,
    );

    const errorMessage =
      error?.response?.data?.message ||
      error?.message ||
      `Failed to sync Brand : ${name} to WooCommerce.`;

    return res.status(500).json({
      success: false,
      message: errorMessage,
      error: error?.response?.data || error,
    });
  }
}

module.exports = {
  buildWooCommerceClient,
  fetchWooCategoryById,
  ensureWooCategoryInPos,
  syncWooCategoryById,
  fetch_category,
  fetch_brand,
  fetch_order,
  fetch_latest_order,
  fetch_product,
  sync_product,
  sync_category,
  sync_brand,
};

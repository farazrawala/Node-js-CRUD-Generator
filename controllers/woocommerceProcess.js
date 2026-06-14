const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const Category = require("../models/category");
const {
  categorySlugFromName,
  resolveCompanyId,
  resolveBatchPagination,
  findExistingCategory,
  sortWooCategoriesForImport,
  finishFetchCategoryBatch,
  failFetchCategoryBatch,
  markProcessOutcome,
  coalesceObjectId,
} = require("../utils/processHelpers");

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
  return coalesceObjectId(created._id);
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

  try {
    const existingResponse = await client.get("products/categories", { slug });
    const existingCategories =
      Array.isArray(existingResponse?.data) ? existingResponse.data : [];

    if (existingCategories.length > 0) {
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

module.exports = {
  buildWooCommerceClient,
  fetchWooCategoryById,
  ensureWooCategoryInPos,
  syncWooCategoryById,
  fetch_category,
  sync_product,
  sync_category,
};

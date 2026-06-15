const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const SyncCategory = require("../models/sync_category");
const SyncBrand = require("../models/sync_brand");
const { coalesceObjectId } = require("./modelHelper");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categorySlugFromName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveCompanyId(process) {
  return coalesceObjectId(process?.company_id?._id || process?.company_id);
}

function resolveIntegrationId(process) {
  return coalesceObjectId(
    process?.integration_id?._id || process?.integration_id,
  );
}

/**
 * Map POS category ↔ store category (website id stored in refference_id).
 */
async function upsertSyncCategoryMapping({
  categoryId,
  integrationId,
  companyId,
  referenceId,
  createdBy,
}) {
  const category_id = coalesceObjectId(categoryId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!category_id || !integration_id || !company_id || !refference_id) {
    return null;
  }

  const actor = coalesceObjectId(createdBy);
  const filter = {
    category_id,
    integration_id,
    company_id,
    deletedAt: null,
  };

  const existing = await SyncCategory.findOne(filter).lean();
  if (existing) {
    if (String(existing.refference_id) === refference_id) {
      return existing;
    }
    return SyncCategory.findByIdAndUpdate(
      existing._id,
      {
        refference_id,
        status: "active",
        updated_by: actor,
      },
      { new: true },
    ).lean();
  }

  return SyncCategory.create({
    category_id,
    integration_id,
    company_id,
    refference_id,
    status: "active",
    created_by: actor,
  });
}

/** Map POS brand ↔ store brand (website id in refference_id). */
async function upsertSyncBrandMapping({
  brandId,
  integrationId,
  companyId,
  referenceId,
  createdBy,
}) {
  const brand_id = coalesceObjectId(brandId);
  const integration_id = coalesceObjectId(integrationId);
  const company_id = coalesceObjectId(companyId);
  const refference_id = String(referenceId ?? "").trim();

  if (!brand_id || !integration_id || !company_id || !refference_id) {
    return null;
  }

  const actor = coalesceObjectId(createdBy);
  const filter = {
    brand_id,
    integration_id,
    company_id,
    deletedAt: null,
  };

  const existing = await SyncBrand.findOne(filter).lean();
  if (existing) {
    if (String(existing.refference_id) === refference_id) {
      return existing;
    }
    return SyncBrand.findByIdAndUpdate(
      existing._id,
      {
        refference_id,
        status: "active",
        updated_by: actor,
      },
      { new: true },
    ).lean();
  }

  return SyncBrand.create({
    brand_id,
    integration_id,
    company_id,
    refference_id,
    status: "active",
    created_by: actor,
  });
}

async function findExistingBrandByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Brand.findOne(filter).lean();
}

async function findExistingBrandBySlug(slug, companyId) {
  const trimmed = String(slug || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    slug: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Brand.findOne(filter).lean();
}

async function findExistingBrand(name, slug, companyId) {
  const byName = await findExistingBrandByName(name, companyId);
  if (byName) {
    return byName;
  }
  if (slug) {
    return findExistingBrandBySlug(slug, companyId);
  }
  return null;
}

function resolveBatchPagination(process) {
  const limit = Math.max(1, Math.min(Number(process.limit) || 5, 100));
  const page = Math.max(1, Number(process.page) || 1);
  const hits = Number(process.hits) || 0;
  const count = Number(process.count) || 0;
  const progress = process.progress || "not_started";
  const offset = Number(process.offset) || 0;
  return { limit, page, hits, count, progress, offset };
}

function dispatchByStoreType(req, res, process, handlers) {
  const storeType = process.integration_id?.store_type;
  if (storeType === "woocommerce" && handlers.woocommerce) {
    return handlers.woocommerce(req, res, process);
  }
  if (storeType === "shopify" && handlers.shopify) {
    return handlers.shopify(req, res, process);
  }
  return res.status(400).json({
    success: false,
    message: `Unsupported or missing store type for this action: ${storeType || "unknown"}`,
  });
}

function buildCompanyIdCriteria(companyId) {
  if (!companyId) {
    return null;
  }
  const objectId = coalesceObjectId(companyId);
  const asString = String(objectId);
  return {
    $or: [{ company_id: objectId }, { company_id: asString }],
  };
}

async function findExistingCategoryByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Category.findOne(filter).lean();
}

async function findExistingCategoryBySlug(slug, companyId) {
  const trimmed = String(slug || "").trim();
  if (!trimmed) {
    return null;
  }

  const filter = {
    deletedAt: null,
    slug: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  };

  const companyCriteria = buildCompanyIdCriteria(companyId);
  if (companyCriteria) {
    filter.$and = [companyCriteria];
  }

  return Category.findOne(filter).lean();
}

async function findExistingCategory(name, slug, companyId) {
  const byName = await findExistingCategoryByName(name, companyId);
  if (byName) {
    return byName;
  }
  if (slug) {
    return findExistingCategoryBySlug(slug, companyId);
  }
  return null;
}

/**
 * Resolve POS parent_id from WooCommerce category.parent (remote id).
 * Uses wooToLocalCategoryIds first, then name/slug lookup against POS.
 */
async function resolveWooCommerceParentId(
  remote,
  companyId,
  client,
  remoteById,
  wooToLocalCategoryIds,
) {
  const wooParentId = Number(remote?.parent) || 0;
  if (!wooParentId) {
    return null;
  }

  if (wooToLocalCategoryIds.has(wooParentId)) {
    return wooToLocalCategoryIds.get(wooParentId);
  }

  let parentRemote = remoteById.get(wooParentId);
  if (!parentRemote) {
    try {
      const parentResponse = await client.get(
        `products/categories/${wooParentId}`,
      );
      parentRemote = parentResponse?.data;
      if (parentRemote?.id != null) {
        remoteById.set(Number(parentRemote.id), parentRemote);
      }
    } catch (error) {
      console.warn(
        `WooCommerce parent category ${wooParentId} not found:`,
        error?.response?.data || error.message,
      );
      return null;
    }
  }

  const parentName = String(parentRemote?.name || "").trim();
  const parentSlug =
    String(parentRemote?.slug || "").trim() ||
    categorySlugFromName(parentName);

  const parentCategory = await findExistingCategory(
    parentName,
    parentSlug,
    companyId,
  );

  if (parentCategory?._id) {
    wooToLocalCategoryIds.set(wooParentId, parentCategory._id);
    return parentCategory._id;
  }

  return null;
}

/** Import parents before children when both are in the same API page. */
function sortWooCategoriesForImport(categories) {
  const byId = new Map(
    categories.map((cat) => [Number(cat.id), cat]),
  );

  const depth = (cat, seen = new Set()) => {
    const parentId = Number(cat?.parent) || 0;
    if (!parentId) {
      return 0;
    }
    const catId = Number(cat.id);
    if (seen.has(catId)) {
      return 0;
    }
    seen.add(catId);
    const parent = byId.get(parentId);
    return parent ? 1 + depth(parent, seen) : 1;
  };

  return [...categories].sort(
    (a, b) => depth(a) - depth(b) || Number(a.id) - Number(b.id),
  );
}

async function finishFetchCategoryBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    parent_found = 0,
    parent_inserted = 0,
    parent_linked = 0,
    parent_unresolved = 0,
    parent_linked_categories = [],
    sync_category_mapped = 0,
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        parent_found,
        parent_inserted,
        parent_linked,
        parent_unresolved,
        parent_linked_categories,
        sync_category_mapped,
      },
    },
  });
}

async function failFetchCategoryBatch(process, res, errorMessage, errorDetail) {
  await ProcessModel.findByIdAndUpdate(process._id, {
    progress: "failed",
    status: "failed",
    remarks: errorMessage,
  });

  return res.status(500).json({
    success: false,
    message: errorMessage,
    error: errorDetail || errorMessage,
  });
}

async function finishFetchBrandBatch(req, res, process, batchResult) {
  const { limit, page, hits, count } = resolveBatchPagination(process);
  const {
    fetched,
    inserted,
    skipped,
    isComplete,
    nextOffset,
    remarks,
    parent_found = 0,
    parent_inserted = 0,
    parent_linked = 0,
    parent_unresolved = 0,
    parent_linked_brands = [],
    sync_brand_mapped = 0,
  } = batchResult;

  const newHits = hits + 1;
  const newCount = count + inserted + skipped;
  const update = {
    hits: newHits,
    count: newCount,
    page: isComplete ? page : page + 1,
    progress: isComplete ? "completed" : "started",
    status: isComplete ? "completed" : "active",
    remarks,
  };

  if (nextOffset !== undefined) {
    update.offset = nextOffset;
  }

  await ProcessModel.findByIdAndUpdate(process._id, update);

  return res.status(200).json({
    success: true,
    message: remarks,
    data: {
      process_id: process._id,
      page: update.page,
      hits: newHits,
      count: newCount,
      progress: update.progress,
      status: update.status,
      batch: {
        fetched,
        inserted,
        skipped,
        limit,
        parent_found,
        parent_inserted,
        parent_linked,
        parent_unresolved,
        parent_linked_brands,
        sync_brand_mapped,
      },
    },
  });
}

const failFetchBrandBatch = failFetchCategoryBatch;

async function markProcessOutcome(processId, status, remarks) {
  await ProcessModel.findByIdAndUpdate(processId, { status, remarks });
}

module.exports = {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  resolveBatchPagination,
  dispatchByStoreType,
  findExistingCategoryByName,
  findExistingCategoryBySlug,
  findExistingCategory,
  findExistingBrandByName,
  findExistingBrandBySlug,
  findExistingBrand,
  resolveWooCommerceParentId,
  sortWooCategoriesForImport,
  finishFetchCategoryBatch,
  finishFetchBrandBatch,
  failFetchCategoryBatch,
  failFetchBrandBatch,
  markProcessOutcome,
  coalesceObjectId,
};

const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  parseSearchFieldsFromQuery,
  applyIncludeExcludeIdQueryFilter,
  parseObjectIdListFromQuery,
  coalesceObjectId,
  activeNotDeletedCriteria,
  buildPopulateFromQuery,
} = require("../utils/modelHelper");
const Product = require("../models/product");
const OrderItem = require("../models/order_item");
const PurchaseOrderItem = require("../models/purchase_order_item");
const SalesReturnItem = require("../models/sales_return_item");
const PurchaseReturnItem = require("../models/purchase_return_item");
const Integration = require("../models/integration");
const WarehouseInventory = require("../models/warehouse_inventory");
const Logs = require("../models/logs");
const Warehouse = require("../models/warehouse");
const { generateProductBarcode } = require("../utils/barcodeGenerator");
const {
  generateUniqueProductBarcode,
} = require("../utils/fetchProductBarcode");
const {
  logControllerError,
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const {
  runCachedListHandler,
  invalidateModuleListCachesForReq,
} = require("../utils/redisCache");
const {
  importProductsFromText,
  PRODUCT_IMPORT_COLUMNS,
} = require("../utils/productCsvImport");
const {
  importShopifyProductsFromText,
  SHOPIFY_IMPORT_COLUMNS,
  parseShopifyProductCsv,
} = require("../utils/shopifyProductCsvImport");
const {
  updateBarcodesFromText,
  BARCODE_IMPORT_COLUMNS,
} = require("../utils/productBarcodeImport");
const {
  enqueueProductWebsiteSyncJobs,
  enqueueBulkSyncProductJobsByCompany,
} = require("../utils/productSyncQueue");

const PRODUCT_LIST_CACHE_MODULE = "product";

/** Parent fields needed for list UI (name + images for child fallback). */
const PARENT_PRODUCT_LIST_SELECT =
  "product_name product_image product_image_thumbnail_url multi_images multi_image_thumbnails";

const PRODUCT_LIST_POPULATE = [
  {
    path: "parent_product_id",
    select: PARENT_PRODUCT_LIST_SELECT,
  },
  {
    path: "category_id",
    select: "name",
  },
];

function normalizeProductTypeQuery(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (value === "single") return "Single";
  if (value === "variable" || value === "variant") return "Variable";
  if (value === "all") return null;
  // Accept exact enum casing from clients that already send Single / Variable
  if (raw === "Single" || raw === "Variable") return raw;
  return null;
}

function applyProductTypeFilter(filter, query = {}) {
  const productType = normalizeProductTypeQuery(
    query.product_type ?? query.productType,
  );
  if (productType) {
    filter.product_type = productType;
  }
  return filter;
}

/**
 * POS list status filter.
 * Default: active only (matches endpoint name + POS "Active" dropdown).
 * `?status=inactive` → inactive only
 * `?include_inactive=true` (or status=all) → all non-deleted statuses
 */
function applyPosProductStatusFilter(filter, query = {}) {
  const includeInactive =
    query.include_inactive === "true" || query.include_inactive === "1";
  const rawStatus = String(query.status ?? "")
    .trim()
    .toLowerCase();

  if (includeInactive || rawStatus === "all") {
    return filter;
  }
  if (rawStatus === "inactive") {
    filter.status = "inactive";
    return filter;
  }
  // Default and status=active
  filter.status = "active";
  return filter;
}

function buildParentProductListFilter(req, { status } = {}) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const query = req.query || {};
  const explicitIds = parseObjectIdListFromQuery(
    query._id ?? query.ids ?? query.product_ids ?? query.product_id,
  );

  const filter = {
    deletedAt: null,
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  // Explicit id list: return those products (including variations). Skip parent-only constraint.
  if (explicitIds.length > 0) {
    filter._id = { $in: explicitIds };
  } else {
    filter.$or = [
      { parent_product_id: { $exists: false } },
      { parent_product_id: null },
    ];
  }

  if (status) {
    filter.status = status;
  }
  applyProductTypeFilter(filter, query);
  return applyIncludeExcludeIdQueryFilter(filter, query);
}

function fetchParentProductList(req, filter) {
  return handleGenericGetAll(req, "product", {
    excludeFields: [],
    populate: PRODUCT_LIST_POPULATE,
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
    filter,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });
}

async function invalidateProductListCache(req) {
  await invalidateModuleListCachesForReq(req, PRODUCT_LIST_CACHE_MODULE);
}

function normalizeWarehouseInventoryInput(reqBody) {
  if (reqBody.warehouse_inventory) {
    const inventoryData = reqBody.warehouse_inventory;
    const normalized = [];

    if (typeof inventoryData === "object" && !Array.isArray(inventoryData)) {
      Object.keys(inventoryData).forEach((key) => {
        const item = inventoryData[key];
        if (item && item.warehouse_id && item.quantity !== undefined) {
          normalized.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            quantity_action: item.quantity_action || "add",
          });
        }
      });
    } else if (Array.isArray(inventoryData)) {
      inventoryData.forEach((item) => {
        if (item && item.warehouse_id && item.quantity !== undefined) {
          normalized.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            quantity_action: item.quantity_action || "add",
          });
        }
      });
    }

    return normalized;
  }

  const warehouseFields = Object.keys(reqBody).filter((key) =>
    key.includes("warehouse_inventory"),
  );

  if (warehouseFields.length === 0) {
    return null;
  }

  const inventoryData = {};
  warehouseFields.forEach((field) => {
    const match = field.match(/warehouse_inventory\[(\d+)\]\[(\w+)\]/);
    if (match) {
      const [, index, property] = match;
      if (!inventoryData[index]) {
        inventoryData[index] = {};
      }
      inventoryData[index][property] = reqBody[field];
    }
  });

  const normalized = [];
  Object.keys(inventoryData).forEach((key) => {
    const item = inventoryData[key];
    if (item && item.warehouse_id && item.quantity !== undefined) {
      normalized.push({
        warehouse_id: item.warehouse_id,
        quantity: parseInt(item.quantity) || 0,
        quantity_action: item.quantity_action || "add",
      });
    }
  });

  return normalized;
}

function mergeWarehouseInventory(
  existingInventory = [],
  incomingInventory = [],
) {
  const inventoryMap = new Map();
  const changes = [];

  existingInventory.forEach((item) => {
    const warehouseId = item?.warehouse_id?.toString();
    if (!warehouseId) return;
    inventoryMap.set(warehouseId, {
      warehouse_id: item.warehouse_id,
      quantity: parseInt(item.quantity) || 0,
      quantity_action: item.quantity_action || "add",
      last_updated: item.last_updated || new Date(),
    });
  });

  incomingInventory.forEach((item) => {
    const warehouseId = item?.warehouse_id?.toString();
    if (!warehouseId) return;

    const current = inventoryMap.get(warehouseId) || {
      warehouse_id: item.warehouse_id,
      quantity: 0,
      quantity_action: "add",
      last_updated: new Date(),
    };

    const changeQty = parseInt(item.quantity) || 0;
    const action = item.quantity_action === "subtract" ? "subtract" : "add";

    const previousQuantity = parseInt(current.quantity) || 0;
    current.quantity =
      action === "subtract" ?
        Math.max(0, current.quantity - changeQty)
      : current.quantity + changeQty;
    current.quantity_action = action;
    current.last_updated = new Date();

    if (previousQuantity !== current.quantity) {
      changes.push({
        warehouse_id: warehouseId,
        action,
        from_qty: previousQuantity,
        to_qty: current.quantity,
      });
    }

    inventoryMap.set(warehouseId, current);
  });

  return {
    mergedInventory: Array.from(inventoryMap.values()),
    changes,
  };
}

function getIncomingInventoryForMerge(updateData, reqBody) {
  // Prefer updateData because handleGenericUpdate may normalize nested
  // array fields and remove raw form-data keys from req.body before hooks run.
  const fromUpdateData = normalizeWarehouseInventoryInput({
    warehouse_inventory: updateData?.warehouse_inventory,
  });
  if (fromUpdateData && fromUpdateData.length > 0) {
    return fromUpdateData;
  }

  return normalizeWarehouseInventoryInput(reqBody);
}

/**
 * @param {{ session?: import("mongoose").ClientSession | null, strict?: boolean }} [options]
 * @returns {Promise<{ insertedIds: import("mongoose").Types.ObjectId[] }>}
 */
async function createWarehouseStockLogs(
  changes,
  req,
  productName,
  options = {},
) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { insertedIds: [] };
  }

  const { session = null, strict = false } = options;
  const warehouseIds = [
    ...new Set(changes.map((change) => change.warehouse_id).filter(Boolean)),
  ];
  let warehouseNameMap = new Map();

  if (warehouseIds.length > 0) {
    try {
      let whQ = Warehouse.find({ _id: { $in: warehouseIds } })
        .select("_id warehouse_name name")
        .lean();
      if (session) whQ = whQ.session(session);
      const warehouses = await whQ;
      warehouseNameMap = new Map(
        warehouses.map((warehouse) => [
          warehouse._id.toString(),
          warehouse.warehouse_name || warehouse.name || "Unknown Warehouse",
        ]),
      );
    } catch (error) {
      console.error("❌ Failed to fetch warehouse names for logs:", error);
      if (strict) throw error;
    }
  }

  const logsToCreate = changes.map((change) => ({
    action: "product_stock_update",
    url: req.originalUrl || req.url || "/api/product/update",
    tags: ["product", "warehouse", "stock", change.action],
    description: `${productName} :: warehouse ${warehouseNameMap.get(change.warehouse_id) || "Unknown Warehouse"} (${change.warehouse_id}) is updating from ${change.from_qty} to ${change.to_qty}.`,
    company_id: req.user?.company_id || null,
    created_by: req.user?._id || null,
    updated_by: req.user?._id || null,
    status: "active",
  }));

  try {
    const docs = logsToCreate.map((row) => Logs.sanitizeLogPlainObject(row));
    const inserted =
      session ?
        await Logs.insertMany(docs, { session })
      : await Logs.insertMany(docs);
    return {
      insertedIds: inserted.map((doc) => doc._id).filter(Boolean),
    };
  } catch (error) {
    console.error("❌ Failed to create warehouse stock logs:", error);
    if (strict) throw error;
    return { insertedIds: [] };
  }
}

function productUpdateLogContext(req, extra = {}) {
  return {
    product_id: req.params?.id ?? null,
    product_name: req.body?.product_name,
    company_id: req.user?.company_id,
    user_id: req.user?._id,
    ...extra,
  };
}

async function rollbackProductUpdate(tracker, req, session = null) {
  const opts = session ? { session } : {};

  if (tracker.stockLogIds?.length) {
    await Logs.updateMany(
      { _id: { $in: tracker.stockLogIds }, deletedAt: null },
      { $set: { deletedAt: new Date(), status: "inactive" } },
      opts,
    );
  }

  if (tracker.productBefore && tracker.productId) {
    await restoreProductFromSnapshot(
      tracker.productId,
      tracker.productBefore,
      session,
    );
  }

  console.warn(
    `⚠️ product update compensating rollback: product=${tracker.productId}`,
  );
}

async function updateWarehouseDefault(req, res) {
  try {
    const productId = req.params.id || req.body.product_id;
    const warehouseId = req.body.warehouse_id || req.params.warehouse_id;

    if (!productId || !warehouseId) {
      return res.status(400).json({
        success: false,
        message: "product_id and warehouse_id are required",
      });
    }

    const filter = { _id: productId, deletedAt: null };
    if (req.user?.company_id) {
      filter.company_id = req.user.company_id;
    }

    const product = await Product.findOne(filter);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    if (
      !Array.isArray(product.warehouse_inventory) ||
      product.warehouse_inventory.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Product has no warehouse inventory",
      });
    }

    const targetIndex = product.warehouse_inventory.findIndex(
      (item) => item?.warehouse_id?.toString() === warehouseId.toString(),
    );

    if (targetIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found in product inventory",
      });
    }

    if (targetIndex > 0) {
      const [targetWarehouse] = product.warehouse_inventory.splice(
        targetIndex,
        1,
      );
      product.warehouse_inventory.unshift(targetWarehouse);
      product.markModified("warehouse_inventory");
      await product.save();
    }

    return res.status(200).json({
      success: true,
      message: "Warehouse moved to default position",
      data: product,
    });
  } catch (error) {
    console.error("❌ Update warehouse default error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}
function requestWithOverrides(req, overrides) {
  return Object.assign(
    Object.create(Object.getPrototypeOf(req)),
    req,
    overrides,
  );
}

function throwWithGenericFailure(response, fallbackMessage) {
  const err = new Error(
    response?.error || response?.message || fallbackMessage || "Request failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details ?? response?.missing ?? response;
  err.clientErrorPayload = response;
  throw err;
}

function parseProductVariationsFromBody(body) {
  const variations = [];
  if (!body || typeof body !== "object") return variations;

  for (const key of Object.keys(body)) {
    const match = key.match(/^variations\[(\d+)\]\[(.+)\]$/);
    if (!match) continue;
    const index = parseInt(match[1], 10);
    const field = match[2];
    if (!variations[index]) variations[index] = {};
    variations[index][field] = body[key];
  }
  return variations;
}

/** JSON array or form-encoded `variations[n][field]`. */
function parseProductVariationsFromRequest(body) {
  if (Array.isArray(body?.variations)) return body.variations;
  return parseProductVariationsFromBody(body);
}

/**
 * Group uploaded files by variation index so each entry is shaped like
 * `req.files` (keyed by the plain schema field name, e.g. `product_image`) and
 * can be passed straight to the generic handlers.
 *
 * Handles both shapes:
 *  - `parseNested: true` (this app's config) → `req.files.variations` is a
 *    nested array: `[ { product_image: <file> }, ... ]`.
 *  - flat bracketed keys (parseNested disabled) → `req.files["variations[0][product_image]"]`.
 */
function parseVariationFilesFromRequest(files) {
  const variationFiles = [];
  if (!files || typeof files !== "object") return variationFiles;

  // express-fileupload parseNested shape: files.variations = [ { field: file } ]
  if (Array.isArray(files.variations)) {
    files.variations.forEach((entry, index) => {
      if (entry && typeof entry === "object") {
        variationFiles[index] = entry;
      }
    });
    return variationFiles;
  }

  // Fallback: flat bracketed keys (parseNested disabled).
  for (const key of Object.keys(files)) {
    const match = key.match(/^variations\[(\d+)\]\[(.+)\]$/);
    if (!match) continue;
    const index = parseInt(match[1], 10);
    const field = match[2];
    if (!variationFiles[index]) variationFiles[index] = {};
    variationFiles[index][field] = files[key];
  }
  return variationFiles;
}

/** Existing variation row id from API payloads (`id`, `_id`, or `product_id`). */
function resolveVariationProductId(variation) {
  if (!variation || typeof variation !== "object") {
    return null;
  }
  for (const key of ["id", "_id", "product_id"]) {
    const raw = variation[key];
    if (raw == null || raw === "") {
      continue;
    }
    const oid = coalesceObjectId(raw);
    if (oid) {
      return String(oid);
    }
  }
  return null;
}

function stripVariationIdentityFields(variationBody) {
  if (!variationBody || typeof variationBody !== "object") {
    return variationBody;
  }
  const cleaned = { ...variationBody };
  delete cleaned.id;
  delete cleaned._id;
  delete cleaned.product_id;
  return cleaned;
}

function productVariationLogContext(req, extra = {}) {
  return {
    company_id: req.user?.company_id,
    user_id: req.user?._id,
    parent_product_id: req.params?.id ?? null,
    product_name: req.body?.product_name,
    variation_count: parseProductVariationsFromRequest(req.body).length,
    ...extra,
  };
}

function trackProductVariationId(tracker, field, id) {
  if (id == null) return;
  const oid =
    id instanceof mongoose.Types.ObjectId ?
      id
    : new mongoose.Types.ObjectId(String(id));
  if (field === "parentProductId") {
    tracker.parentProductId = oid;
    return;
  }
  if (!tracker.variationProductIds) tracker.variationProductIds = [];
  tracker.variationProductIds.push(oid);
}

/** Compensating soft-delete when Mongo multi-doc transactions are unavailable. */
async function rollbackProductCreateVariation(tracker, req, session = null) {
  const ids = [];
  if (tracker.variationProductIds?.length) {
    ids.push(...tracker.variationProductIds);
  }
  if (tracker.parentProductId) {
    ids.push(tracker.parentProductId);
  }
  if (!ids.length) return;

  const opts = session ? { session } : {};
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const companyId = coalesceObjectId(tracker.companyId || req.user?.company_id);
  const filter = { _id: { $in: ids }, deletedAt: null };
  if (companyId) filter.company_id = companyId;

  await Product.updateMany(filter, { $set: softDeleteSet }, opts);
  console.warn(
    `⚠️ create-product-variation compensating rollback: products ${ids.map(String).join(", ")}`,
  );
}

async function fetchProductLeanSnapshot(productId, companyId, session = null) {
  const oid = coalesceObjectId(productId);
  if (!oid) return null;
  const filter = { _id: oid, deletedAt: null };
  const companyOid = coalesceObjectId(companyId);
  if (companyOid) filter.company_id = companyOid;

  let q = Product.findOne(filter).lean();
  if (session) q = q.session(session);
  return q;
}

async function restoreProductFromSnapshot(productId, snapshot, session = null) {
  if (!snapshot || productId == null) return;
  const oid = coalesceObjectId(productId);
  if (!oid) return;

  const { _id, __v, createdAt, updatedAt, ...rest } = snapshot;
  const opts = session ? { session } : {};
  await Product.updateOne({ _id: oid }, { $set: rest }, opts);
}

/** Restore parent + updated variations; soft-delete newly created variations. */
async function rollbackProductUpdateVariation(tracker, req, session = null) {
  const opts = session ? { session } : {};
  const companyId = coalesceObjectId(tracker.companyId || req.user?.company_id);
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };

  if (tracker.createdVariationIds?.length) {
    const filter = {
      _id: { $in: tracker.createdVariationIds },
      deletedAt: null,
    };
    if (companyId) filter.company_id = companyId;
    await Product.updateMany(filter, { $set: softDeleteSet }, opts);
  }

  if (tracker.variationUpdatesBefore?.length) {
    for (const row of tracker.variationUpdatesBefore) {
      await restoreProductFromSnapshot(row.id, row.before, session);
    }
  }

  if (tracker.parentBefore && tracker.parentProductId) {
    await restoreProductFromSnapshot(
      tracker.parentProductId,
      tracker.parentBefore,
      session,
    );
  }

  console.warn(
    `⚠️ update-product-variation compensating rollback: parent ${tracker.parentProductId}`,
  );
}

function mergeParentWarehouseInventoryBeforeUpdate(
  updateData,
  req,
  existingRecord,
) {
  const incomingInventory = getIncomingInventoryForMerge(updateData, req.body);
  if (incomingInventory === null) return;
  const { mergedInventory, changes } = mergeWarehouseInventory(
    existingRecord?.warehouse_inventory || [],
    incomingInventory,
  );
  updateData.warehouse_inventory = mergedInventory;
  req._warehouseStockChanges = changes;
}

async function runProductVariationWithOptionalTransaction(runFlow) {
  let session = null;
  let txnError = null;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runFlow(session);
    });
  } catch (error) {
    if (isMongoTransactionUnsupportedError(error)) {
      if (session) {
        try {
          session.endSession();
        } catch (_) {
          /* ignore */
        }
        session = null;
      }
      try {
        await runFlow(null);
      } catch (retryError) {
        txnError = retryError;
      }
    } else {
      txnError = error;
    }
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return txnError;
}

/**
 * Parent product + N variation creates inside a transaction when supported.
 * @returns {Promise<object>} handleGenericCreate-style success payload for parent
 */
async function runProductCreateVariationBody(req, session, tracker) {
  const txnOpts = session ? { session } : {};

  tracker.variation_step = "company";
  const company = await handleGenericFindOne(req, "company", {
    searchCriteria: {
      _id: req.user.company_id,
      deletedAt: null,
    },
    excludeFields: [],
    ...txnOpts,
  });

  if (!company.success || !company.data) {
    const err = new Error("Company not found");
    err.statusCode = 404;
    err.responseType = "not_found";
    throw err;
  }

  tracker.companyId = coalesceObjectId(company.data._id);

  if (!normalizeWarehouseInventoryInput(req.body)) {
    req.body.warehouse_inventory = [
      {
        warehouse_id: company.data.warehouse_id,
        quantity: req.body.quantity || 0,
        quantity_action: "add",
        last_updated: new Date(),
      },
    ];
  }

  if (!req.body.company_id && company.data._id) {
    req.body.company_id = company.data._id.toString();
  }

  const variations = parseProductVariationsFromRequest(req.body);
  const variationFiles = parseVariationFilesFromRequest(req.files);

  tracker.variation_step = "parent_product";
  const parentProductResponse = await handleGenericCreate(req, "product", {
    ...txnOpts,
    afterCreate: async (record) => {
      console.log("✅ Parent product created successfully:", record?._id);
    },
  });

  if (
    !parentProductResponse.success ||
    !parentProductResponse.data ||
    !parentProductResponse.data._id
  ) {
    throwWithGenericFailure(
      parentProductResponse,
      "Failed to create parent product",
    );
  }

  trackProductVariationId(
    tracker,
    "parentProductId",
    parentProductResponse.data._id,
  );

  const parentId = parentProductResponse.data._id.toString();

  if (variations.length > 0) {
    tracker.variation_step = "variation_products";
    for (const [variationIndex, variation] of variations.entries()) {
      if (!variation || typeof variation !== "object") continue;

      const filesForVariation = variationFiles[variationIndex] || {};
      const variantBody = {
        ...variation,
        company_id: company.data._id.toString(),
        warehouse_inventory: [
          {
            warehouse_id: company.data.warehouse_id,
            quantity: variation.quantity || 0,
            quantity_action: variation.quantity_action || "add",
            last_updated: new Date(),
          },
        ],
        product_name: variation.product_name,
        parent_product_id: parentId,
        product_price: variation.product_price,
        product_description: variation.product_description,
      };

      const variationReq = requestWithOverrides(req, {
        body: variantBody,
        files: filesForVariation,
      });
      const variationResponse = await handleGenericCreate(
        variationReq,
        "product",
        {
          ...txnOpts,
          afterCreate: async (record) => {
            console.log(
              "✅ Product variation created successfully:",
              record?._id,
            );
          },
        },
      );

      if (
        !variationResponse.success ||
        !variationResponse.data ||
        !variationResponse.data._id
      ) {
        const failure = { ...variationResponse };
        failure.error =
          failure.error ||
          `Failed to create variation at index ${variationIndex}`;
        throwWithGenericFailure(
          failure,
          `Failed to create product variation at index ${variationIndex}`,
        );
      }

      trackProductVariationId(
        tracker,
        "variationProductIds",
        variationResponse.data._id,
      );
    }
  }

  return parentProductResponse;
}

async function productCreateVariation(req, res) {
  const tracker = {
    variation_step: "init",
    parentProductId: null,
    variationProductIds: [],
    companyId: null,
  };
  let result = null;

  const txnError = await runProductVariationWithOptionalTransaction(
    async (session) => {
      try {
        result = await runProductCreateVariationBody(req, session, tracker);
      } catch (stepError) {
        if (
          !session &&
          (tracker.parentProductId || tracker.variationProductIds?.length)
        ) {
          await rollbackProductCreateVariation(tracker, req, null);
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ productCreateVariation failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "PRODUCT CREATE VARIATION ROLLBACK",
      tags: ["product", "create-product-variation", "error"],
      fallbackUrl: "/api/product/create-product-variation",
      context: productVariationLogContext(req, {
        variation_step: tracker.variation_step,
        parent_product_id: tracker.parentProductId,
        variation_product_ids: tracker.variationProductIds,
        company_id: tracker.companyId,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
      }),
      fallbackCompanyId: tracker.companyId,
    });

    if (txnError.clientErrorPayload) {
      const status = txnError.clientErrorPayload.status || 400;
      return res.status(status).json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Failed to create product variation",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  await invalidateProductListCache(req);
  return res.status(result?.status || 201).json(result);
}

async function getProductVariationById(req, res) {
  const parentOid = coalesceObjectId(req.params.id);
  if (!parentOid) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Record ID is required",
      details: "Please provide id in the URL parameters",
      type: "missing_id",
    });
  }

  const tenantCo = coalesceObjectId(req.user?.company_id);
  const variationFilter = {
    ...activeNotDeletedCriteria(),
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  const response = await handleGenericGetById(req, "product", {
    excludeFields: [],
    filter: variationFilter,
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
    ],
  });

  if (!response?.success || !response.data) {
    return res.status(response?.status || 404).json(response);
  }

  const childproducts = await handleGenericGetAll(req, "product", {
    excludeFields: [],
    filter: {
      ...variationFilter,
      parent_product_id: parentOid,
      _id: { $ne: parentOid },
    },
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
      {
        path: "category_id",
        select: "name",
      },
    ],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });

  return res.status(200).json({
    success: true,
    message: "Product variation fetched successfully",
    data: {
      ...response.data,
      childproducts: childproducts.data ?? [],
    },
  });
}

/**
 * Parent update + per-variation create/update inside a transaction when supported.
 * @returns {Promise<{ status: number, payload: object }>}
 */
async function runProductUpdateVariationBody(req, session, tracker) {
  const txnOpts = session ? { session } : {};
  const parentId = req.params?.id;

  if (!parentId) {
    const err = new Error("Parent product ID is required");
    err.statusCode = 400;
    throw err;
  }
  tracker.parentProductId = coalesceObjectId(parentId);

  tracker.variation_step = "company";
  const company = await handleGenericFindOne(req, "company", {
    searchCriteria: {
      _id: req.user.company_id,
      deletedAt: null,
    },
    excludeFields: [],
    ...txnOpts,
  });

  if (!company.success || !company.data) {
    const err = new Error("Company not found");
    err.statusCode = 404;
    throw err;
  }
  tracker.companyId = coalesceObjectId(company.data._id);

  const variations = parseProductVariationsFromRequest(req.body);
  const variationFiles = parseVariationFilesFromRequest(req.files);

  if (!normalizeWarehouseInventoryInput(req.body)) {
    req.body.warehouse_inventory = [
      {
        warehouse_id: company.data.warehouse_id,
        quantity: req.body.quantity || 0,
        quantity_action: "add",
        last_updated: new Date(),
      },
    ];
  }

  if (!req.body.company_id && company.data._id) {
    req.body.company_id = company.data._id.toString();
  }

  tracker.variation_step = "parent_snapshot";
  tracker.parentBefore = await fetchProductLeanSnapshot(
    parentId,
    tracker.companyId,
    session,
  );
  if (!tracker.parentBefore) {
    const err = new Error("Parent product not found");
    err.statusCode = 404;
    throw err;
  }

  tracker.variation_step = "parent_product";
  const parentProductResponse = await handleGenericUpdate(req, "product", {
    ...txnOpts,
    beforeUpdate: async (updateData, req, existingRecord) => {
      mergeParentWarehouseInventoryBeforeUpdate(
        updateData,
        req,
        existingRecord,
      );
    },
    afterUpdate: async (record) => {
      console.log("✅ Parent product updated successfully:", record?._id);
    },
  });

  if (
    !parentProductResponse.success ||
    !parentProductResponse.data ||
    !parentProductResponse.data._id
  ) {
    throwWithGenericFailure(
      parentProductResponse,
      "Failed to update parent product",
    );
  }

  const parentProductId = parentProductResponse.data._id.toString();
  const variationResults = [];

  if (variations.length > 0) {
    tracker.variation_step = "variation_products";

    for (const [variationIndex, variation] of variations.entries()) {
      if (!variation || typeof variation !== "object") continue;

      const filesForVariation = variationFiles[variationIndex] || {};
      const variationId = resolveVariationProductId(variation);

      if (variationId) {
        const before = await fetchProductLeanSnapshot(
          variationId,
          tracker.companyId,
          session,
        );
        if (!before) {
          const err = new Error(`Variation product not found: ${variationId}`);
          err.statusCode = 404;
          throw err;
        }

        if (!tracker.variationUpdatesBefore) {
          tracker.variationUpdatesBefore = [];
        }
        tracker.variationUpdatesBefore.push({ id: variationId, before });

        const variationBody = stripVariationIdentityFields({ ...variation });
        variationBody.company_id = company.data._id.toString();
        variationBody.warehouse_inventory = [
          {
            warehouse_id: company.data.warehouse_id,
            quantity: variation.quantity || 0,
            quantity_action: variation.quantity_action || "add",
            last_updated: new Date(),
          },
        ];
        variationBody.parent_product_id = parentProductId;

        const variationReq = requestWithOverrides(req, {
          params: { ...req.params, id: variationId },
          body: variationBody,
          files: filesForVariation,
        });

        const variationResponse = await handleGenericUpdate(
          variationReq,
          "product",
          txnOpts,
        );

        if (!variationResponse.success) {
          const failure = { ...variationResponse };
          failure.error =
            failure.error ||
            `Failed to update variation at index ${variationIndex}`;
          throwWithGenericFailure(
            failure,
            `Failed to update product variation at index ${variationIndex}`,
          );
        }

        variationResults.push({
          id: variationId,
          action: "updated",
          response: variationResponse,
        });
      } else {
        const variantBody = stripVariationIdentityFields({
          ...variation,
          company_id: company.data._id.toString(),
          warehouse_inventory: [
            {
              warehouse_id: company.data.warehouse_id,
              quantity: variation.quantity || 0,
              quantity_action: variation.quantity_action || "add",
              last_updated: new Date(),
            },
          ],
          parent_product_id: parentProductId,
        });

        const variantReq = requestWithOverrides(req, {
          body: variantBody,
          files: filesForVariation,
        });
        const variationResponse = await handleGenericCreate(
          variantReq,
          "product",
          txnOpts,
        );

        if (
          !variationResponse.success ||
          !variationResponse.data ||
          !variationResponse.data._id
        ) {
          const failure = { ...variationResponse };
          failure.error =
            failure.error ||
            `Failed to create variation at index ${variationIndex}`;
          throwWithGenericFailure(
            failure,
            `Failed to create product variation at index ${variationIndex}`,
          );
        }

        const newId = variationResponse.data._id;
        if (!tracker.createdVariationIds) tracker.createdVariationIds = [];
        tracker.createdVariationIds.push(
          newId instanceof mongoose.Types.ObjectId ?
            newId
          : new mongoose.Types.ObjectId(String(newId)),
        );

        variationResults.push({
          action: "created",
          response: variationResponse,
        });
      }
    }
  }

  await createWarehouseStockLogs(
    req._warehouseStockChanges || [],
    req,
    parentProductResponse.data.product_name || "Product",
  );

  return {
    status: parentProductResponse.status || 200,
    payload: {
      success: true,
      message: "Product variation updated successfully",
      data: {
        parent_product: parentProductResponse.data,
        variations: variationResults,
      },
    },
  };
}

async function productUpdateVariation(req, res) {
  const tracker = {
    variation_step: "init",
    parentProductId: null,
    companyId: null,
    parentBefore: null,
    variationUpdatesBefore: [],
    createdVariationIds: [],
  };
  let result = null;

  const txnError = await runProductVariationWithOptionalTransaction(
    async (session) => {
      try {
        result = await runProductUpdateVariationBody(req, session, tracker);
      } catch (stepError) {
        const needsRollback =
          !session &&
          (tracker.parentBefore ||
            tracker.createdVariationIds?.length ||
            tracker.variationUpdatesBefore?.length);
        if (needsRollback) {
          await rollbackProductUpdateVariation(tracker, req, null);
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error(
      "❌ productUpdateVariation failed:\n",
      serializeErrorForLog(txnError),
    );
    await logRollbackFailure(req, txnError, {
      action: "PRODUCT UPDATE VARIATION ROLLBACK",
      tags: ["product", "update-product-variation", "error"],
      fallbackUrl: `/api/product/update-product-variation/${req.params?.id || ""}`,
      context: productVariationLogContext(req, {
        variation_step: tracker.variation_step,
        parent_product_id: tracker.parentProductId,
        created_variation_ids: tracker.createdVariationIds,
        updated_variation_ids: tracker.variationUpdatesBefore?.map(
          (row) => row.id,
        ),
        company_id: tracker.companyId,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
      }),
      fallbackCompanyId: tracker.companyId,
    });

    if (txnError.clientErrorPayload) {
      const status = txnError.clientErrorPayload.status || 400;
      return res.status(status).json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Failed to update product variation",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  await invalidateProductListCache(req);

  try {
    const queueResult = await enqueueProductWebsiteSyncJobs({
      productId: tracker.parentProductId || req.params?.id,
      companyId: tracker.companyId || req.user?.company_id,
      createdBy: req.user?._id,
    });
    if (queueResult.count > 0) {
      result.payload = {
        ...result.payload,
        sync_queue: {
          queued: queueResult.count,
          process_ids: queueResult.created.map((row) => row._id),
          sync_target_product_id: queueResult.sync_target_product_id,
        },
      };
    }
  } catch (queueErr) {
    console.warn(
      "enqueueProductWebsiteSyncJobs failed:",
      queueErr?.message || queueErr,
    );
  }

  return res.status(result?.status || 200).json(result.payload);
}

async function productCreate(req, res) {
  console.log("🔧 Product create - req.body:", req.body);
  console.log("🔧 Product create - req.body keys:", Object.keys(req.body));

  // Generate unique EAN13 barcode if barcode is empty
  if (!req.body.barcode || req.body.barcode.trim() === "") {
    req.body.barcode = generateProductBarcode();
    console.log("🏷️ Generated new EAN13 barcode:", req.body.barcode);
  }

  // Standalone Single products leave parent_product_id null.
  // Variants must pass parent_product_id explicitly.

  const response = await handleGenericCreate(req, "product", {
    afterCreate: async (record, req) => {
      console.log("✅ Product created successfully:", record);
    },
  });
  if (response?.success) {
    await invalidateProductListCache(req);
  }
  return res.status(response.status).json(response);
}

function readImportFileBuffer(req) {
  const file =
    req.files?.file ||
    req.files?.products ||
    req.files?.csv ||
    req.files?.import;
  if (!file?.data) return null;
  return file.data;
}

/**
 * GET /api/product/import-form — column reference for CSV/TSV import.
 */
function productImportFormSchema(req, res) {
  return res.status(200).json({
    success: true,
    endpoint: "POST /api/product/import",
    content_types: [
      "multipart/form-data (field: file)",
      "application/json ({ items: [...] })",
      "text/plain body",
    ],
    columns: PRODUCT_IMPORT_COLUMNS,
    example_row: {
      category: "OIL",
      product_name: "IKHLAS OIL",
      price: 460,
      wholesale_price: 441.67,
      qty: 85,
    },
    options: {
      update_existing:
        "true|false — update price/category if product exists (default true)",
      dry_run: "true|false — parse only (default false)",
      add_stock_via_purchase:
        "true|false — after import, create one PO for rows with qty > 0 (default true)",
      default_qty: "Qty when CSV has no qty column (default 0)",
      warehouse_id: "Warehouse for stock (default: company default warehouse)",
      vendor_id: "Optional vendor user id on the purchase order",
    },
    sample_file:
      "Final_pos_6.255.csv (comma-separated: category, product_name, price, wholesale_price, qty)",
  });
}

/**
 * POST /api/product/import
 * Import products from CSV/TSV upload or JSON rows.
 * Categories are created automatically when they do not exist.
 *
 * multipart field: `file` (`.csv`, `.tsv`, `.xls` text tab file)
 * Query/body: update_existing, dry_run, add_stock_via_purchase, default_qty, warehouse_id, vendor_id
 */
async function productImportFromFile(req, res) {
  try {
    const companyId = coalesceObjectId(
      req.body?.company_id || req.user?.company_id,
    );
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required (from auth user or request body).",
      });
    }

    const updateExisting =
      String(req.query?.update_existing ?? req.body?.update_existing ?? "true")
        .trim()
        .toLowerCase() !== "false";
    const dryRun =
      String(req.query?.dry_run ?? req.body?.dry_run ?? "false")
        .trim()
        .toLowerCase() === "true";
    const addStockViaPurchase =
      String(
        req.query?.add_stock_via_purchase ??
          req.body?.add_stock_via_purchase ??
          "true",
      )
        .trim()
        .toLowerCase() !== "false";
    const defaultQtyRaw = req.query?.default_qty ?? req.body?.default_qty ?? 0;
    const defaultQty = Math.max(0, Number(defaultQtyRaw) || 0);
    const warehouseId = coalesceObjectId(
      req.body?.warehouse_id || req.query?.warehouse_id,
    );
    const vendorId = coalesceObjectId(
      req.body?.vendor_id || req.query?.vendor_id,
    );

    let text = null;

    const fileBuffer = readImportFileBuffer(req);
    if (fileBuffer) {
      text = fileBuffer.toString("utf8");
    } else if (typeof req.body?.csv === "string" && req.body.csv.trim()) {
      text = req.body.csv;
    } else if (typeof req.body?.text === "string" && req.body.text.trim()) {
      text = req.body.text;
    } else if (Array.isArray(req.body?.items) && req.body.items.length) {
      const header = "category,product_name,price,wholesale_price,qty\n";
      const lines = req.body.items.map((row) =>
        [
          String(row.category || "").trim(),
          String(row.product_name || row.name || "").trim(),
          String(row.price ?? row.product_price ?? 0).trim(),
          String(
            row.wholesale_price ?? row.wholesale ?? row.cost ?? row.price ?? 0,
          ).trim(),
          String(row.qty ?? row.quantity ?? defaultQty).trim(),
        ].join(","),
      );
      text = header + lines.join("\n");
    }

    if (!text) {
      return res.status(400).json({
        success: false,
        message:
          "Upload a CSV/TSV file (form field `file`) or send `items` / `csv` / `text` in the body.",
        columns: PRODUCT_IMPORT_COLUMNS,
      });
    }

    const result = await importProductsFromText(text, {
      companyId,
      createdBy: req.user?._id,
      req,
      options: {
        updateExisting,
        dryRun,
        addStockViaPurchase,
        defaultQty,
        warehouseId,
        vendorId,
        purchaseDescription: req.body?.purchase_description,
      },
    });

    if (!dryRun) {
      await invalidateProductListCache(req);
    }

    const statusCode =
      !dryRun && result.summary?.failed > 0 && result.summary?.created === 0 ?
        400
      : !dryRun && result.summary?.failed > 0 ? 207
      : 200;

    const poInfo = result.purchase_order;
    const poMsg =
      poInfo?.success ?
        ` PO ${poInfo.purchase_order_no || ""} created (${poInfo.line_count} lines).`
      : poInfo?.skipped ? ""
      : poInfo ? ` Stock PO failed: ${poInfo.message || "unknown"}.`
      : "";

    return res.status(statusCode).json({
      success: result.summary?.failed === 0 || dryRun,
      message:
        dryRun ?
          `Dry run: ${result.parsed.row_count} row(s) ready to import.`
        : `Import complete — created ${result.summary.created}, updated ${result.summary.updated}, skipped ${result.summary.skipped}, failed ${result.summary.failed}. Categories created: ${result.summary.categories_created}.${poMsg}`,
      data: result,
    });
  } catch (error) {
    console.error("❌ productImportFromFile:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Product import failed",
      details: error.details || undefined,
    });
  }
}

/**
 * GET /api/product/shopify-import-form — Shopify CSV column reference.
 */
function shopifyProductImportFormSchema(req, res) {
  return res.status(200).json({
    success: true,
    endpoint: "POST /api/product/shopify-product-import",
    content_types: [
      "multipart/form-data (field: file)",
      "text/plain body",
      'application/json ({ csv: "..." })',
    ],
    columns: SHOPIFY_IMPORT_COLUMNS,
    notes: [
      "Upload a Shopify Products export CSV (Handle, Title, Variant Price, etc.).",
      "Each variant row becomes one POS product (name includes option values).",
      "Product Category paths like `A > B > C` are split into multiple categories.",
      "Variant Barcode is used when present; otherwise a unique EAN13 barcode is generated.",
      "Image Src / Variant Image URLs are downloaded into uploads/products/<company_id>/<product_id>/ and saved on product_image / multi_images.",
      "Multi-line HTML in Body (HTML) is supported.",
    ],
    options: {
      update_existing:
        "true|false — update price/category if SKU/product exists (default true)",
      dry_run: "true|false — parse only (default false)",
      add_stock_via_purchase:
        "true|false — after import, create one PO for rows with qty > 0 (default true)",
      default_qty: "Qty when Variant Inventory Qty is empty (default 0)",
      import_archived:
        "true|false — include non-active Status rows (default false)",
      download_images:
        "true|false — download Image Src / Variant Image URLs (default true)",
      update_existing_images:
        "true|false — replace images on existing products (default false)",
      warehouse_id: "Warehouse for stock (default: company default warehouse)",
      vendor_id: "Optional vendor user id on the purchase order",
    },
    sample_file: "bbg_shopify.csv",
  });
}

/**
 * POST /api/product/shopify-product-import
 * Import products from a Shopify product export CSV.
 */
async function shopifyProductImportFromFile(req, res) {
  try {
    const companyId = coalesceObjectId(
      req.body?.company_id || req.user?.company_id,
    );
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required (from auth user or request body).",
      });
    }

    const updateExisting =
      String(req.query?.update_existing ?? req.body?.update_existing ?? "true")
        .trim()
        .toLowerCase() !== "false";
    const dryRun =
      String(req.query?.dry_run ?? req.body?.dry_run ?? "false")
        .trim()
        .toLowerCase() === "true";
    const addStockViaPurchase =
      String(
        req.query?.add_stock_via_purchase ??
          req.body?.add_stock_via_purchase ??
          "true",
      )
        .trim()
        .toLowerCase() !== "false";
    const importArchived =
      String(req.query?.import_archived ?? req.body?.import_archived ?? "false")
        .trim()
        .toLowerCase() === "true";
    const downloadImages =
      String(req.query?.download_images ?? req.body?.download_images ?? "true")
        .trim()
        .toLowerCase() !== "false";
    const updateExistingImages =
      String(
        req.query?.update_existing_images ??
          req.body?.update_existing_images ??
          "false",
      )
        .trim()
        .toLowerCase() === "true";
    const defaultQtyRaw = req.query?.default_qty ?? req.body?.default_qty ?? 0;
    const defaultQty = Math.max(0, Number(defaultQtyRaw) || 0);
    const warehouseId = coalesceObjectId(
      req.body?.warehouse_id || req.query?.warehouse_id,
    );
    const vendorId = coalesceObjectId(
      req.body?.vendor_id || req.query?.vendor_id,
    );

    let text = null;
    const fileBuffer = readImportFileBuffer(req);
    if (fileBuffer) {
      text = fileBuffer.toString("utf8");
    } else if (typeof req.body?.csv === "string" && req.body.csv.trim()) {
      text = req.body.csv;
    } else if (typeof req.body?.text === "string" && req.body.text.trim()) {
      text = req.body.text;
    }

    if (!text) {
      return res.status(400).json({
        success: false,
        message:
          "Upload a Shopify CSV file (form field `file`) or send `csv` / `text` in the body.",
        columns: SHOPIFY_IMPORT_COLUMNS,
      });
    }

    if (dryRun) {
      const parsed = parseShopifyProductCsv(text, {
        defaultQty,
        importArchived,
      });
      return res.status(200).json({
        success: true,
        dry_run: true,
        message: `Dry run: ${parsed.rows.length} Shopify variant row(s) ready to import.`,
        shopify_parse_stats: parsed.stats,
        sample: parsed.rows.slice(0, 10),
        columns: SHOPIFY_IMPORT_COLUMNS,
      });
    }

    const result = await importShopifyProductsFromText(text, {
      companyId,
      createdBy: req.user?._id,
      req,
      options: {
        updateExisting,
        dryRun: false,
        addStockViaPurchase,
        defaultQty,
        importArchived,
        downloadImages,
        updateExistingImages,
        warehouseId,
        vendorId,
        purchaseDescription: "Shopify product import stock",
      },
    });

    const poInfo = result.purchase_order;
    const poMsg =
      poInfo?.success ?
        ` PO ${poInfo.purchase_order_no || ""} created (${poInfo.line_count} lines).`
      : poInfo?.skipped ? ""
      : poInfo ? ` Stock PO failed: ${poInfo.message || "unknown"}.`
      : "";

    return res.status(200).json({
      success: result.summary?.failed === 0,
      message: `Shopify import complete — created ${result.summary.created}, updated ${result.summary.updated}, skipped ${result.summary.skipped}, failed ${result.summary.failed}. Categories created: ${result.summary.categories_created}.${poMsg}`,
      data: result,
    });
  } catch (error) {
    console.error("❌ shopifyProductImportFromFile:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Shopify product import failed",
      details: error.details || undefined,
    });
  }
}

/**
 * GET /api/product/update-barcode-form — column reference for barcode update.
 */
function productBarcodeUpdateFormSchema(req, res) {
  return res.status(200).json({
    success: true,
    endpoint: "POST /api/product/update-barcode",
    description:
      "Update product.barcode for existing products, matched by product name.",
    content_types: [
      "multipart/form-data (field: file)",
      "application/json ({ items: [{ product_name, barcode }] })",
      "text/plain body (csv/text)",
    ],
    columns: BARCODE_IMPORT_COLUMNS,
    example_row: {
      product_name: "IKHLAS OIL",
      barcode: "4369179812026",
    },
    options: {
      dry_run:
        "true|false — parse + match only, persist nothing (default false)",
      overwrite_existing:
        "true|false — update even when the product already has a different barcode (default true)",
    },
    sample_file:
      "geopos_products_barcode.csv (comma-separated: product_name, barcode)",
  });
}

/**
 * POST /api/product/update-barcode
 * Update `product.barcode` for existing products, matched by product name.
 *
 * multipart field: `file` (`.csv`, `.tsv`) with header `product_name,barcode`
 * or JSON `{ items: [{ product_name, barcode }] }` / `csv` / `text` body.
 * Query/body: dry_run, overwrite_existing
 */
async function productBarcodeUpdateFromFile(req, res) {
  try {
    const companyId = coalesceObjectId(
      req.body?.company_id || req.user?.company_id,
    );
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required (from auth user or request body).",
      });
    }

    const dryRun =
      String(req.query?.dry_run ?? req.body?.dry_run ?? "false")
        .trim()
        .toLowerCase() === "true";
    const overwriteExisting =
      String(
        req.query?.overwrite_existing ?? req.body?.overwrite_existing ?? "true",
      )
        .trim()
        .toLowerCase() !== "false";

    let text = null;

    const fileBuffer = readImportFileBuffer(req);
    if (fileBuffer) {
      text = fileBuffer.toString("utf8");
    } else if (typeof req.body?.csv === "string" && req.body.csv.trim()) {
      text = req.body.csv;
    } else if (typeof req.body?.text === "string" && req.body.text.trim()) {
      text = req.body.text;
    } else if (Array.isArray(req.body?.items) && req.body.items.length) {
      const header = "product_name,barcode\n";
      const lines = req.body.items.map((row) =>
        [
          `"${String(row.product_name || row.name || "")
            .replace(/"/g, '""')
            .trim()}"`,
          `"${String(row.barcode ?? row.code ?? "")
            .replace(/"/g, '""')
            .trim()}"`,
        ].join(","),
      );
      text = header + lines.join("\n");
    }

    if (!text) {
      return res.status(400).json({
        success: false,
        message:
          "Upload a CSV/TSV file (form field `file`) or send `items` / `csv` / `text` in the body.",
        columns: BARCODE_IMPORT_COLUMNS,
      });
    }

    const result = await updateBarcodesFromText(text, {
      companyId,
      updatedBy: req.user?._id,
      options: { dryRun, overwriteExisting },
    });

    if (!dryRun) {
      await invalidateProductListCache(req);
    }

    const statusCode =
      !dryRun && result.summary?.failed > 0 && result.summary?.updated === 0 ?
        400
      : !dryRun && result.summary?.failed > 0 ? 207
      : 200;

    return res.status(statusCode).json({
      success: dryRun || result.summary?.failed === 0,
      message:
        dryRun ?
          `Dry run: ${result.parsed.row_count} row(s) ready to update.`
        : `Barcode update complete — updated ${result.summary.updated}, skipped ${result.summary.skipped}, failed ${result.summary.failed}.`,
      data: result,
    });
  } catch (error) {
    console.error("❌ productBarcodeUpdateFromFile:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Barcode update failed",
      details: error.details || undefined,
    });
  }
}

async function performProductUpdate(req, options = {}) {
  const session = options.session || null;
  const strictSideEffects = Boolean(session || options.strictSideEffects);

  return handleGenericUpdate(req, "product", {
    ...(session ? { session } : {}),
    beforeUpdate: async (updateData, req, existingRecord) => {
      console.log("🔧 Product update - beforeUpdate hook called");
      mergeParentWarehouseInventoryBeforeUpdate(
        updateData,
        req,
        existingRecord,
      );
    },
    afterUpdate: async (record, req, existingRecord, sess) => {
      console.log("✅ Record updated successfully:", record);
      const bulkSession = sess || session;
      const { insertedIds } = await createWarehouseStockLogs(
        req._warehouseStockChanges || [],
        req,
        record.product_name || "Product",
        { session: bulkSession, strict: strictSideEffects },
      );
      if (options.tracker && insertedIds.length) {
        if (!options.tracker.stockLogIds) options.tracker.stockLogIds = [];
        options.tracker.stockLogIds.push(...insertedIds);
      }
    },
  });
}

async function runProductUpdateBody(req, session, tracker) {
  const productId = req.params?.id;
  if (!productId) {
    const err = new Error("Product ID is required");
    err.statusCode = 400;
    throw err;
  }

  tracker.productId = coalesceObjectId(productId);
  tracker.update_step = "snapshot";
  tracker.productBefore = await fetchProductLeanSnapshot(
    productId,
    req.user?.company_id,
    session,
  );
  if (!tracker.productBefore) {
    const err = new Error("Product not found");
    err.statusCode = 404;
    throw err;
  }

  tracker.update_step = "product";
  const response = await performProductUpdate(req, {
    session,
    strictSideEffects: true,
    tracker,
  });

  if (!response?.success) {
    throwWithGenericFailure(response, "Product update failed");
  }

  tracker.update_step = "complete";
  return response;
}

async function productUpdate(req, res) {
  const tracker = {
    update_step: "init",
    productId: null,
    productBefore: null,
    stockLogIds: [],
  };
  let response = null;

  const txnError = await runProductVariationWithOptionalTransaction(
    async (session) => {
      try {
        response = await runProductUpdateBody(req, session, tracker);
      } catch (stepError) {
        if (
          !session &&
          (tracker.productBefore || tracker.stockLogIds?.length)
        ) {
          await rollbackProductUpdate(tracker, req, null);
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error("❌ productUpdate failed:\n", serializeErrorForLog(txnError));
    await logRollbackFailure(req, txnError, {
      action: "PRODUCT UPDATE ROLLBACK",
      tags: ["product", "update", "error"],
      fallbackUrl:
        req.originalUrl || `/api/product/update/${req.params?.id || ""}`,
      context: productUpdateLogContext(req, {
        update_step: tracker.update_step,
        product_id: tracker.productId,
        stock_log_ids: tracker.stockLogIds,
        warehouse_change_count: req._warehouseStockChanges?.length ?? 0,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
      }),
      fallbackCompanyId: req.user?.company_id,
    });

    if (txnError.clientErrorPayload) {
      const status = txnError.clientErrorPayload.status || 400;
      return res.status(status).json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Product update failed",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  await invalidateProductListCache(req);

  try {
    const queueResult = await enqueueProductWebsiteSyncJobs({
      productId: tracker.productId || req.params?.id,
      companyId: req.user?.company_id,
      createdBy: req.user?._id,
    });
    if (queueResult.count > 0) {
      response = {
        ...response,
        sync_queue: {
          queued: queueResult.count,
          process_ids: queueResult.created.map((row) => row._id),
        },
      };
    }
  } catch (queueErr) {
    console.warn(
      "enqueueProductWebsiteSyncJobs failed:",
      queueErr?.message || queueErr,
    );
  }

  return res.status(response?.status || 200).json(response);
}

async function productById(req, res) {
  const response = await handleGenericGetById(req, "product", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllProducts(req, res) {
  return runCachedListHandler(req, res, {
    module: PRODUCT_LIST_CACHE_MODULE,
    action: "get-all",
    fetch: () => fetchParentProductList(req, buildParentProductListFilter(req)),
  });
}

async function getAllActiveProducts(req, res) {
  return runCachedListHandler(req, res, {
    module: PRODUCT_LIST_CACHE_MODULE,
    action: "get-all-active",
    fetch: () =>
      fetchParentProductList(
        req,
        buildParentProductListFilter(req, { status: "active" }),
      ),
  });
}

/**
 * GET /api/warehouse/:warehouseId/products — products with stock in this warehouse
 * (reads `warehouse_inventory` collection, not embedded product arrays).
 */
async function getProductsByWarehouse(req, res) {
  try {
    const { warehouseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(warehouseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid warehouse id",
      });
    }

    const filter = {
      warehouse_id: warehouseId,
      quantity: { $gt: 0 },
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
    if (req.user && req.user.company_id) {
      filter.company_id = req.user.company_id;
    }

    const rows = await WarehouseInventory.find(filter)
      .populate("product_id", "product_name product_code product_price status")
      .lean();

    const productIds = rows
      .map(
        (inventoryRow) =>
          inventoryRow.product_id && inventoryRow.product_id._id,
      )
      .filter(Boolean);

    let totalsByProduct = new Map();
    if (productIds.length > 0) {
      const aggFilter = {
        product_id: { $in: productIds },
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      };
      if (req.user && req.user.company_id) {
        aggFilter.company_id = req.user.company_id;
      }
      const agg = await WarehouseInventory.aggregate([
        { $match: aggFilter },
        { $group: { _id: "$product_id", total: { $sum: "$quantity" } } },
      ]);
      totalsByProduct = new Map(
        agg.map((groupRow) => [String(groupRow._id), groupRow.total]),
      );
    }

    const data = rows
      .filter((inventoryRow) => inventoryRow.product_id)
      .map((inventoryRow) => {
        const pid = String(inventoryRow.product_id._id);
        return {
          _id: inventoryRow.product_id._id,
          product_name: inventoryRow.product_id.product_name,
          product_code: inventoryRow.product_id.product_code,
          product_price: inventoryRow.product_id.product_price,
          warehouse_quantity: inventoryRow.quantity,
          total_quantity: totalsByProduct.get(pid) ?? inventoryRow.quantity,
        };
      });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("❌ Get products by warehouse error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function productDelete(req, res) {
  console.log(`🔐 Product delete attempt:`, {
    id: req.params.id,
    time: new Date().toISOString(),
  });

  const filter = {};

  // Always filter by company_id if user has one
  if (req.user && req.user.company_id) {
    filter.company_id = req.user.company_id;
    console.log(
      `🔍 Filtering product delete by company_id:`,
      req.user.company_id,
    );
  }

  // Manually set the request body with deletedAt data
  req.body = { deletedAt: new Date().toISOString() };
  const response = await handleGenericUpdate(req, "product", {
    filter: filter,
    afterUpdate: async (record, reqInner, existingRecord) => {
      const parentId = coalesceObjectId(
        record?._id || existingRecord?._id || reqInner.params?.id,
      );
      let variantsDeleted = 0;
      if (parentId) {
        const now = record?.deletedAt ? new Date(record.deletedAt) : new Date();
        const softDeleteSet = { deletedAt: now, status: "inactive" };
        const uid = coalesceObjectId(reqInner.user?._id || reqInner.user?.id);
        if (uid) softDeleteSet.updated_by = uid;

        const childFilter = {
          parent_product_id: parentId,
          deletedAt: null,
        };
        const companyId = coalesceObjectId(
          filter.company_id || reqInner.user?.company_id,
        );
        if (companyId) childFilter.company_id = companyId;

        const variantResult = await Product.updateMany(childFilter, {
          $set: softDeleteSet,
        });
        variantsDeleted = variantResult.modifiedCount || 0;
      }
      console.log(
        `✅ Product soft deleted successfully. Variants deleted: ${variantsDeleted}`,
      );
      await invalidateProductListCache(reqInner);
    },
  });
  return res.status(response.status).json(response);
}

/**
 * Inventory value at wholesale (COGS basis on hand): sum over warehouses of
 * `quantity * wholesale_price` per active product. Optional `GET …/:id` for one product.
 */
async function cost_of_goods_available(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const { id } = req.params;
    const productIdFilter =
      id && mongoose.Types.ObjectId.isValid(String(id).trim()) ?
        new mongoose.Types.ObjectId(String(id).trim())
      : null;

    if (id && !productIdFilter) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const invMatch = {
      company_id: companyId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      quantity: { $gt: 0 },
    };
    if (productIdFilter) {
      invMatch.product_id = productIdFilter;
    }

    const rows = await WarehouseInventory.aggregate([
      { $match: invMatch },
      {
        $group: {
          _id: "$product_id",
          total_qty: { $sum: "$quantity" },
        },
      },
      { $sort: { total_qty: -1 } },
    ]);

    if (productIdFilter) {
      const exists = await Product.exists({
        _id: productIdFilter,
        company_id: companyId,
        deletedAt: null,
      });
      if (!exists) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }
      if (rows.length === 0) {
        const productDoc = await Product.findById(productIdFilter)
          .select("product_name sku wholesale_price product_code")
          .lean();
        const wholesaleUnit = Number(productDoc?.wholesale_price);
        const wholesale_price =
          Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
        return res.status(200).json({
          success: true,
          count: 1,
          grand_total_cost_of_goods: 0,
          data: [
            {
              product_id: productIdFilter,
              product_name: productDoc?.product_name,
              product_code: productDoc?.product_code,
              sku: productDoc?.sku,
              total_qty: 0,
              wholesale_price,
              cost_of_goods_available: 0,
            },
          ],
        });
      }
    }

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        grand_total_cost_of_goods: 0,
        data: [],
      });
    }

    const productIds = rows.map((qtyRow) => qtyRow._id);
    const products = await Product.find({
      _id: { $in: productIds },
      company_id: companyId,
      status: "active",
      deletedAt: null,
    })
      .select("product_name sku wholesale_price product_code")
      .lean();

    const productById = new Map(products.map((doc) => [String(doc._id), doc]));

    const data = [];
    for (const row of rows) {
      const productDoc = productById.get(String(row._id));
      if (!productDoc) continue;
      const qty = Math.max(0, Number(row.total_qty) || 0);
      const wholesaleUnit = Number(productDoc.wholesale_price);
      const wholesale_price =
        Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
      const cost_of_goods_available =
        Math.round(qty * wholesale_price * 100) / 100;
      data.push({
        product_id: row._id,
        product_name: productDoc.product_name,
        product_code: productDoc.product_code,
        sku: productDoc.sku,
        total_qty: qty,
        wholesale_price,
        cost_of_goods_available,
      });
    }

    if (productIdFilter && data.length === 0 && rows.length > 0) {
      const row = rows[0];
      const qty = Math.max(0, Number(row.total_qty) || 0);
      return res.status(200).json({
        success: true,
        count: 1,
        grand_total_cost_of_goods: 0,
        data: [
          {
            product_id: row._id,
            product_name: null,
            product_code: null,
            sku: null,
            total_qty: qty,
            wholesale_price: 0,
            cost_of_goods_available: 0,
            note: "Inventory exists but product is missing or inactive for this company",
          },
        ],
      });
    }

    const grand_total_cost_of_goods =
      Math.round(
        data.reduce(
          (runningTotal, line) => runningTotal + line.cost_of_goods_available,
          0,
        ) * 100,
      ) / 100;

    return res.status(200).json({
      success: true,
      count: data.length,
      grand_total_cost_of_goods,
      data,
    });
  } catch (error) {
    console.error("❌ cost_of_goods_available:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/** Warehouse qty × `wholesale_price` for COGS-style response; optional blend `?qty=&total=` returns `wholesale_blend` only (does not persist `wholesale_price`). Default: `total` = full line amount for that `qty`; use `total_mode=per_unit` if `total` is unit cost. PATCH …/update-cost/:id */
async function productCostUpdate(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id).trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const productId = new mongoose.Types.ObjectId(String(id).trim());

    const invMatch = {
      product_id: productId,
      company_id: companyId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    const agg = await WarehouseInventory.aggregate([
      { $match: invMatch },
      {
        $group: {
          _id: null,
          total_warehouse_qty: { $sum: "$quantity" },
        },
      },
    ]);

    const totalWarehouseQty = Math.max(
      0,
      Number(agg[0]?.total_warehouse_qty) || 0,
    );

    const product = await Product.findOne({
      _id: productId,
      company_id: companyId,
      deletedAt: null,
    })
      .select("product_name product_code sku wholesale_price status")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const rawAddQty = req.query?.qty;
    const rawAddTotal = req.query?.total;
    const hasAddQty =
      rawAddQty !== undefined && String(rawAddQty).trim() !== "";
    const hasAddTotal =
      rawAddTotal !== undefined && String(rawAddTotal).trim() !== "";

    if (hasAddQty !== hasAddTotal) {
      return res.status(400).json({
        success: false,
        message:
          "Provide both `qty` and `total` for a weighted blend, or omit both. Default: `total` = full line amount for that qty; use `total_mode=per_unit` if `total` is per-unit cost.",
      });
    }

    let wholesaleBlend = null;
    if (hasAddQty && hasAddTotal) {
      const addedQty = Number(String(rawAddQty).trim());
      const addedTotalRaw = Number(String(rawAddTotal).trim());
      if (!Number.isFinite(addedQty) || addedQty <= 0) {
        return res.status(400).json({
          success: false,
          message: "Query `qty` must be a positive number",
        });
      }
      if (!Number.isFinite(addedTotalRaw) || addedTotalRaw < 0) {
        return res.status(400).json({
          success: false,
          message: "Query `total` must be a finite number ≥ 0",
        });
      }

      const totalModeRaw = String(req.query?.total_mode ?? "")
        .trim()
        .toLowerCase();
      const usePerUnitTotal =
        totalModeRaw === "per_unit" ||
        totalModeRaw === "unit" ||
        totalModeRaw === "each";

      let addedUnitCost;
      let newLotExtendedCost;
      let blendTotalModeLabel;
      if (usePerUnitTotal) {
        addedUnitCost = addedTotalRaw;
        newLotExtendedCost = addedQty * addedTotalRaw;
        blendTotalModeLabel = "per_unit";
      } else {
        addedUnitCost = addedTotalRaw / addedQty;
        if (!Number.isFinite(addedUnitCost) || addedUnitCost < 0) {
          return res.status(400).json({
            success: false,
            message:
              "`total` must divide by `qty` to a valid implied per-unit cost ≥ 0 (send full line amount for `qty`, or use total_mode=per_unit)",
          });
        }
        newLotExtendedCost = addedTotalRaw;
        blendTotalModeLabel = "line_total";
      }

      const wholesaleBefore =
        Number.isFinite(Number(product.wholesale_price)) ?
          Number(product.wholesale_price)
        : 0;
      const totalCostAvailable = totalWarehouseQty * wholesaleBefore;
      const combinedExtendedCost = totalCostAvailable + newLotExtendedCost;
      const denominatorQty = totalWarehouseQty + addedQty;
      const newWholesaleRounded =
        Math.round((combinedExtendedCost / denominatorQty) * 100) / 100;

      wholesaleBlend = {
        warehouse_qty: totalWarehouseQty,
        wholesale_price_before: wholesaleBefore,
        total_cost_available: Math.round(totalCostAvailable * 100) / 100,
        added_qty: addedQty,
        added_unit_cost: Math.round(addedUnitCost * 100) / 100,
        total_mode: blendTotalModeLabel,
        new_lot_extended_cost: Math.round(newLotExtendedCost * 100) / 100,
        combined_extended_cost: Math.round(combinedExtendedCost * 100) / 100,
        denominator_qty: denominatorQty,
        new_wholesale: newWholesaleRounded,
      };
    }

    const wholesaleUnit = Number(product.wholesale_price);
    const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
    const cost_at_wholesale =
      Math.round(totalWarehouseQty * wholesale_price * 100) / 100;

    return res.status(200).json({
      success: true,
      data: {
        product_id: productId,
        product_name: product.product_name,
        product_code: product.product_code,
        sku: product.sku,
        total_warehouse_qty: totalWarehouseQty,
        wholesale_price,
        cost_of_goods_available: cost_at_wholesale,
      },
      ...(wholesaleBlend != null ? { wholesale_blend: wholesaleBlend } : {}),
    });
  } catch (error) {
    console.error("❌ productCostUpdate:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function getAllActiveProductsPOS(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const query = req.query || {};

  let filter = {
    deletedAt: null,
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  const explicitIds = parseObjectIdListFromQuery(
    query._id ?? query.ids ?? query.product_ids ?? query.product_id,
  );
  if (explicitIds.length > 0) {
    filter._id = { $in: explicitIds };
  }

  const rawCategory = query.category_id ?? query.categoryId;
  if (rawCategory != null && String(rawCategory).trim() !== "") {
    const categoryOid = coalesceObjectId(rawCategory);
    if (!categoryOid || !mongoose.Types.ObjectId.isValid(String(categoryOid))) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid category_id",
        message: "category_id must be a valid 24-character ObjectId",
      });
    }
    // `category_id` on product is an array; equality matches docs that include this id.
    filter.category_id = categoryOid;
  }

  applyProductTypeFilter(filter, query);
  applyPosProductStatusFilter(filter, query);
  filter = applyIncludeExcludeIdQueryFilter(filter, query);

  const warehouseInventoryMatch = {
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  const warehouseInventoryPopulate = {
    path: "warehouse_inventory",
    match: warehouseInventoryMatch,
    select: "warehouse_id quantity status company_id",
    populate: {
      path: "warehouse_id",
      select: "name code",
    },
  };

  // Source-product inventory belongs to the fetch-from company, not the tenant.
  const fetchFromWarehouseInventoryPopulate = {
    path: "warehouse_inventory",
    match: {
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    },
    select: "warehouse_id quantity status company_id",
    populate: {
      path: "warehouse_id",
      select: "name code",
    },
  };

  const populate = [
    {
      path: "parent_product_id",
      select: PARENT_PRODUCT_LIST_SELECT,
    },
    warehouseInventoryPopulate,
  ];
  // Honor ?populate=fetch_from_company_id,fetch_from_product_id (and other refs)
  // without dropping the POS defaults above.
  const queryPopulate = buildPopulateFromQuery(req.query || {}, "product");
  for (const entry of queryPopulate) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (!path) continue;
    if (
      populate.some(
        (existing) =>
          (typeof existing === "string" ? existing : existing?.path) === path,
      )
    ) {
      continue;
    }
    if (path === "fetch_from_product_id") {
      populate.push({
        path: "fetch_from_product_id",
        populate: fetchFromWarehouseInventoryPopulate,
      });
      continue;
    }
    populate.push(entry);
  }

  const response = await handleGenericGetAll(req, "product", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
    populate,
  });
  return res.status(response.status).json(response);
}

async function updateStockByWarehouse(req, res) {
  try {
    const { warehouse_id, quantity } = req.body;
  } catch (error) {
    console.error("❌ Update stock by warehouse error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/**
 * POST/PATCH /api/product/generate-barcode/:id
 * Generate a company-unique EAN13 barcode and save it on the product.
 * Body optional — only product id (path) is required.
 */
async function productGenerateUniqueBarcode(req, res) {
  try {
    const productId = coalesceObjectId(
      req.params?.id || req.body?.product_id || req.body?.id || req.query?.id,
    );
    if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Valid product id is required",
        error: "Valid product id is required",
      });
    }

    const companyId = coalesceObjectId(req.user?.company_id);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
        error: "company_id is required",
      });
    }

    const product = await Product.findOne({
      _id: productId,
      company_id: companyId,
      deletedAt: null,
    }).select(
      "product_name product_code sku barcode company_id wholesale_price product_price status",
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        status: 404,
        message: "Product not found",
        error: "Product not found",
      });
    }

    const previousBarcode = String(product.barcode || "").trim() || null;
    const barcode = await generateUniqueProductBarcode(companyId, {
      excludeId: product._id,
    });

    const userId = coalesceObjectId(req.user?._id ?? req.user?.id);
    product.barcode = barcode;
    if (userId) product.updated_by = userId;
    await product.save();

    await invalidateProductListCache(req);

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Unique barcode generated and updated",
      data: {
        product_id: String(product._id),
        product_name: product.product_name,
        previous_barcode: previousBarcode,
        barcode,
        company_id: String(companyId),
      },
    });
  } catch (error) {
    console.error("❌ productGenerateUniqueBarcode:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      status: error.statusCode || 500,
      message: error.message || "Failed to generate unique barcode",
      error: error.message || "Failed to generate unique barcode",
    });
  }
}

/**
 * GET /api/product/duplicate-barcodes
 * List barcodes that appear on more than one non-deleted product in the company.
 */
async function findProductsWithDuplicateBarcodes(req, res) {
  try {
    const companyId = coalesceObjectId(req.user?.company_id);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
        error: "company_id is required",
      });
    }

    const companyOid =
      companyId instanceof mongoose.Types.ObjectId ?
        companyId
      : new mongoose.Types.ObjectId(String(companyId));

    const groups = await Product.aggregate([
      {
        $match: {
          company_id: companyOid,
          deletedAt: null,
          barcode: { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $addFields: {
          barcode_normalized: {
            $trim: { input: { $toString: { $ifNull: ["$barcode", ""] } } },
          },
        },
      },
      { $match: { barcode_normalized: { $ne: "" } } },
      {
        $group: {
          _id: "$barcode_normalized",
          count: { $sum: 1 },
          products: {
            $push: {
              _id: "$_id",
              product_name: "$product_name",
              product_code: "$product_code",
              sku: "$sku",
              barcode: "$barcode",
              status: "$status",
              product_type: "$product_type",
              createdAt: "$createdAt",
            },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      {
        $project: {
          _id: 0,
          barcode: "$_id",
          count: 1,
          products: 1,
        },
      },
    ]);

    const productIds = [];
    for (const group of groups) {
      for (const product of group.products || []) {
        if (product?._id) productIds.push(product._id);
      }
    }

    /** productId → { stock, warehouse_inventory[] } (same source as product list). */
    const stockByProductId = new Map();
    if (productIds.length > 0) {
      const inventoryRows = await WarehouseInventory.find({
        product_id: { $in: productIds },
        company_id: companyOid,
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      })
        .select("product_id warehouse_id quantity status")
        .populate({ path: "warehouse_id", select: "name code" })
        .lean();

      for (const row of inventoryRows) {
        const pid = String(row.product_id || "");
        if (!pid) continue;
        const qty = Number(row.quantity);
        const safeQty = Number.isFinite(qty) ? qty : 0;
        const existing = stockByProductId.get(pid) || {
          stock: 0,
          warehouse_inventory: [],
        };
        existing.stock += safeQty;
        existing.warehouse_inventory.push({
          _id: row._id,
          warehouse_id: row.warehouse_id,
          quantity: safeQty,
          status: row.status,
        });
        stockByProductId.set(pid, existing);
      }
    }

    for (const group of groups) {
      for (const product of group.products || []) {
        const stockInfo = stockByProductId.get(String(product._id));
        if (stockInfo) {
          product.qty = stockInfo.stock;
          product.stock = stockInfo.stock;
          product.warehouse_inventory = stockInfo.warehouse_inventory;
        } else {
          product.qty = null;
          product.stock = null;
          product.warehouse_inventory = [];
        }
      }
    }

    const duplicate_product_count = groups.reduce(
      (sum, row) => sum + (Number(row.count) || 0),
      0,
    );

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(companyOid),
      duplicate_barcode_count: groups.length,
      duplicate_product_count,
      data: groups,
    });
  } catch (error) {
    console.error("❌ findProductsWithDuplicateBarcodes:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to load duplicate barcodes",
      error: error.message || "Failed to load duplicate barcodes",
    });
  }
}

/** Default lookback for recent line-item product_id collection. */
const RECENT_LINE_ITEM_PRODUCT_IDS_MINUTES = 62;

/**
 * GET /api/product/recent-product-ids
 *
 * Prefetch companies with active integrations, collect unique `product_id`s
 * from recent line items for those companies only, resolve variants to their
 * parent, then enqueue `sync_product` jobs.
 * Optional query `minutes` overrides the lookback window (1–1440; default
 * `RECENT_LINE_ITEM_PRODUCT_IDS_MINUTES`).
 *
 * | Step | Action | Notes |
 * |------|--------|-------|
 * |    1 | Parse lookback window | `?minutes` or default; reject invalid |
 * |    2 | Prefetch integrated company_ids | active `integration` rows (`deletedAt: null`) |
 * |    3 | Build date + company match filter | active lines in window, `company_id ∈` step 2 |
 * |    4 | Distinct product_ids from 4 collections | order_item, purchase_order_item, sales_return_item, purchase_return_item |
 * |    5 | Merge + dedupe ids | single `rawProductIds` list |
 * |    6 | Load products for parent map | `_id`, `parent_product_id` |
 * |    7 | Collapse variants → parent ids | final `product_ids` |
 * |    8 | Enqueue sync_product jobs | per company via `enqueueBulkSyncProductJobsByCompany` |
 * |    9 | Return 200 payload | counts + product_ids + process stats |
 * |   20 | Failure path | application / controller logs, then 500 |
 */
async function getRecentLineItemProductIds(req, res) {
  let resolvedProductIds = [];
  try {
    // step 1 start — parse lookback window (`?minutes` or default)
    let minutes = RECENT_LINE_ITEM_PRODUCT_IDS_MINUTES;
    const rawMinutes = req.query?.minutes;
    if (rawMinutes != null && String(rawMinutes).trim() !== "") {
      const parsed = Number(rawMinutes);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1440) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid minutes",
          message: "minutes must be a number between 1 and 1440",
        });
      }
      minutes = Math.floor(parsed);
    }
    // step 1 end

    // step 2 start — company_ids that have at least one active integration
    const integratedCompanyIds = (
      await Integration.distinct("company_id", {
        status: "active",
        deletedAt: null,
        company_id: { $ne: null },
      })
    ).filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));

    if (!integratedCompanyIds.length) {
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - minutes * 60 * 1000);
      console.log(
        `[recent-product-ids] minutes=${minutes} companies_with_integration=0 — nothing to sync`,
      );
      return res.status(200).json({
        success: true,
        status: 200,
        minutes,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        count: 0,
        order_item_product_count: 0,
        purchase_order_item_product_count: 0,
        sales_return_item_product_count: 0,
        purchase_return_item_product_count: 0,
        companies_with_integration_count: 0,
        product_ids: [],
        process: {
          action: "sync_product",
          created_count: 0,
          jobs_planned: 0,
          skipped: 0,
          by_company: {},
          failed: [],
          created: [],
          logs: [],
          reason: "no_active_integrations",
        },
      });
    }
    // step 2 end

    // step 3 start — createdAt window + company_id scoped to integrated companies
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - minutes * 60 * 1000);
    const match = {
      status: "active",
      deletedAt: null,
      createdAt: { $gte: fromDate, $lte: toDate },
      product_id: { $ne: null },
      company_id: { $in: integratedCompanyIds },
    };
    // step 3 end

    // step 4 start — distinct product_id from order / PO / sales return / purchase return lines
    const [
      orderItemProductIds,
      purchaseOrderItemProductIds,
      salesReturnItemProductIds,
      purchaseReturnItemProductIds,
    ] = await Promise.all([
      OrderItem.distinct("product_id", match),
      PurchaseOrderItem.distinct("product_id", match),
      SalesReturnItem.distinct("product_id", match),
      PurchaseReturnItem.distinct("product_id", match),
    ]);
    // step 4 end

    // step 5 start — merge + dedupe into one string id list
    const rawProductIds = [
      ...new Set(
        [
          ...orderItemProductIds,
          ...purchaseOrderItemProductIds,
          ...salesReturnItemProductIds,
          ...purchaseReturnItemProductIds,
        ]
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ];
    // step 5 end

    // step 6 start — load products for parent_product_id lookup
    const objectIds = rawProductIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const products =
      objectIds.length > 0 ?
        await Product.find({ _id: { $in: objectIds } })
          .select("_id parent_product_id")
          .lean()
      : [];

    const parentById = new Map(
      products.map((p) => [String(p._id), p.parent_product_id]),
    );
    // step 6 end

    // step 7 start — collapse variant product_ids to parent when parent differs
    const productIdSet = new Set();
    for (const id of rawProductIds) {
      const parentId = parentById.get(id);
      if (parentId != null && String(parentId) !== String(id)) {
        productIdSet.add(String(parentId));
      } else {
        productIdSet.add(id);
      }
    }
    const product_ids = [...productIdSet];
    resolvedProductIds = product_ids;
    // step 7 end

    // step 8 start — enqueue sync_product process jobs grouped by company
    const processQueue = await enqueueBulkSyncProductJobsByCompany({
      req,
      productIds: product_ids,
      createdBy: req.user?._id || null,
      remarks: `Auto-queued sync_product from recent line items (${minutes}m)`,
      priority: 50,
    });
    // step 8 end

    console.log(
      `[recent-product-ids] minutes=${minutes} companies=${integratedCompanyIds.length} products=${product_ids.length} processes=${processQueue.count}`,
    );

    // step 9 start — success response
    return res.status(200).json({
      success: true,
      status: 200,
      minutes,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      count: product_ids.length,
      order_item_product_count: orderItemProductIds.length,
      purchase_order_item_product_count: purchaseOrderItemProductIds.length,
      sales_return_item_product_count: salesReturnItemProductIds.length,
      purchase_return_item_product_count: purchaseReturnItemProductIds.length,
      companies_with_integration_count: integratedCompanyIds.length,
      product_ids,
      process: {
        action: "sync_product",
        created_count: processQueue.count,
        jobs_planned: processQueue.jobs_planned ?? 0,
        skipped: processQueue.skipped ?? 0,
        by_company: processQueue.by_company || {},
        failed: processQueue.failed || [],
        created: processQueue.created || [],
        logs: processQueue.logs || [],
      },
    });
    // step 9 end
  } catch (error) {
    console.error("❌ getRecentLineItemProductIds:", error);

    // step 20 start — failure logs (per company when known, else controller log)
    try {
      const fallbackCompanyIds = [];
      const seen = new Set();
      const maybeAdd = (raw) => {
        const id = coalesceObjectId(raw);
        if (!id) return;
        const key = String(id);
        if (seen.has(key)) return;
        seen.add(key);
        fallbackCompanyIds.push(id);
      };
      maybeAdd(req.user?.company_id);
      maybeAdd(req.query?.company_id);

      if (resolvedProductIds.length) {
        const products = await Product.find({
          _id: {
            $in: resolvedProductIds
              .filter((id) => mongoose.Types.ObjectId.isValid(id))
              .map((id) => new mongoose.Types.ObjectId(id)),
          },
        })
          .select("company_id")
          .lean();
        for (const p of products) maybeAdd(p.company_id);
      }

      const { createApplicationLog } = require("../utils/applicationLogs");
      if (fallbackCompanyIds.length) {
        await Promise.all(
          fallbackCompanyIds.map((companyId) =>
            createApplicationLog(
              req,
              {
                action:
                  "Recent line items sync_product failed :: endpoint error",
                url: req.originalUrl || "/api/product/recent-product-ids",
                tags: [
                  "product",
                  "process",
                  "sync_product",
                  "recent-product-ids",
                  "failed",
                  "cron job",
                ],
                description: {
                  message: error.message || "Internal server error",
                  error: error.message || String(error),
                  product_ids: resolvedProductIds,
                },
                company_id: companyId,
                created_by: req.user?._id || null,
                reference_type: "product",
              },
              { silent: true },
            ),
          ),
        );
      } else {
        await logControllerError(
          req,
          error.message || "getRecentLineItemProductIds failed",
          {
            action: "Recent line items sync_product failed :: endpoint error",
            tags: [
              "product",
              "process",
              "sync_product",
              "recent-product-ids",
              "failed",
              "cron job",
            ],
            fallbackUrl: "/api/product/recent-product-ids",
          },
        );
      }
    } catch (logErr) {
      console.error(
        "❌ getRecentLineItemProductIds log failed:",
        logErr?.message || logErr,
      );
    }
    // step 20 end

    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

module.exports = {
  productCreate,
  productImportFromFile,
  productImportFormSchema,
  shopifyProductImportFromFile,
  shopifyProductImportFormSchema,
  productBarcodeUpdateFromFile,
  productBarcodeUpdateFormSchema,
  productGenerateUniqueBarcode,
  findProductsWithDuplicateBarcodes,
  getRecentLineItemProductIds,
  productUpdate,
  productById,
  getAllProducts,
  getAllActiveProducts,
  getProductsByWarehouse,
  productCreateVariation,
  productUpdateVariation,
  getProductVariationById,
  productDelete,
  productCostUpdate,
  cost_of_goods_available,
  getAllActiveProductsPOS,
  updateWarehouseDefault,
};

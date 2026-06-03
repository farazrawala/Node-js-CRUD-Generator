const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  parseSearchFieldsFromQuery,
  coalesceObjectId,
} = require("../utils/modelHelper");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const Logs = require("../models/logs");
const Warehouse = require("../models/warehouse");
const { generateProductBarcode } = require("../utils/barcodeGenerator");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { isMongoTransactionUnsupportedError } = require("../utils/mongoTransactionSupport");

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

async function createWarehouseStockLogs(changes, req, productName) {
  if (!Array.isArray(changes) || changes.length === 0) return;

  const warehouseIds = [
    ...new Set(changes.map((change) => change.warehouse_id).filter(Boolean)),
  ];
  let warehouseNameMap = new Map();

  if (warehouseIds.length > 0) {
    try {
      const warehouses = await Warehouse.find({ _id: { $in: warehouseIds } })
        .select("_id warehouse_name name")
        .lean();
      warehouseNameMap = new Map(
        warehouses.map((warehouse) => [
          warehouse._id.toString(),
          warehouse.warehouse_name || warehouse.name || "Unknown Warehouse",
        ]),
      );
    } catch (error) {
      console.error("❌ Failed to fetch warehouse names for logs:", error);
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
    await Logs.insertMany(
      logsToCreate.map((row) => Logs.sanitizeLogPlainObject(row)),
    );
  } catch (error) {
    console.error("❌ Failed to create warehouse stock logs:", error);
  }
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
  const companyId = coalesceObjectId(
    tracker.companyId || req.user?.company_id,
  );
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
  const companyId = coalesceObjectId(
    tracker.companyId || req.user?.company_id,
  );
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
    let variationIndex = 0;
    for (const variation of variations) {
      if (!variation || typeof variation !== "object") continue;

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

      const variationReq = requestWithOverrides(req, { body: variantBody });
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
      variationIndex += 1;
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
        if (!session && (tracker.parentProductId || tracker.variationProductIds?.length)) {
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

  return res.status(result?.status || 201).json(result);
}

async function getProductVariationById(req, res) {
  const { id } = req.params;
  const response = await handleGenericGetById(req, "product", {
    excludeFields: [],
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
    ],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });

  const childproducts = await handleGenericGetAll(req, "product", {
    excludeFields: [],
    filter: { parent_product_id: id },
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
  });
  response.data.childproducts = childproducts.data;
  return res.status(200).json({
    success: true,
    message: "Product variation fetched successfully",
    data: response.data,
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
    let variationIndex = 0;

    for (const variation of variations) {
      if (!variation || typeof variation !== "object") continue;

      if (variation.id) {
        const variationId = String(variation.id);
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

        const variationBody = { ...variation };
        delete variationBody.id;
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
          parent_product_id: parentProductId,
        };

        const variantReq = requestWithOverrides(req, { body: variantBody });
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

      variationIndex += 1;
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

  // Ensure parent_product_id is set for single products
  // If product_type is Single and parent_product_id is not provided, it will be set in the model hook
  // For variant products, parent_product_id should be explicitly provided

  const response = await handleGenericCreate(req, "product", {
    afterCreate: async (record, req) => {
      console.log("✅ Product created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function productUpdate(req, res) {
  const response = await handleGenericUpdate(req, "product", {
    beforeUpdate: async (updateData, req, existingRecord) => {
      console.log("🔧 Product update - beforeUpdate hook called");
      console.log(
        "🔧 Original updateData.warehouse_inventory:",
        updateData.warehouse_inventory,
      );

      const incomingInventory = getIncomingInventoryForMerge(
        updateData,
        req.body,
      );
      if (incomingInventory !== null) {
        const { mergedInventory, changes } = mergeWarehouseInventory(
          existingRecord?.warehouse_inventory || [],
          incomingInventory,
        );
        updateData.warehouse_inventory = mergedInventory;
        req._warehouseStockChanges = changes;
        console.log(
          "✅ Merged warehouse inventory in controller:",
          mergedInventory,
        );
      }
    },
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
      await createWarehouseStockLogs(
        req._warehouseStockChanges || [],
        req,
        record.product_name || "Product",
      );
    },
  });
  return res.status(response.status).json(response);
}

async function productById(req, res) {
  const response = await handleGenericGetById(req, "product", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllProducts(req, res) {
  const response = await handleGenericGetAll(req, "product", {
    excludeFields: [], // Don't exclude any fields
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
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    filter: {
      $or: [
        { parent_product_id: { $exists: false } },
        { parent_product_id: null },
      ],
    },
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });
  return res.status(response.status).json(response);
}

async function getAllActiveProducts(req, res) {
  const response = await handleGenericGetAll(req, "product", {
    excludeFields: [], // Don't exclude any fields
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
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    filter: {
      status: "active",
      deletedAt: null,
      $or: [
        { parent_product_id: { $exists: false } },
        { parent_product_id: null },
      ],
    },
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });
  return res.status(response.status).json(response);
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
      .map((inventoryRow) => inventoryRow.product_id && inventoryRow.product_id._id)
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
    afterUpdate: async (record, req, existingRecord) => {
      console.log(`✅ Product soft deleted successfully.`);
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
        const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
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
      const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
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
    const hasAddQty = rawAddQty !== undefined && String(rawAddQty).trim() !== "";
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

      const wholesaleBefore = Number.isFinite(Number(product.wholesale_price)) ?
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
  const filter = {
    status: "active",
    deletedAt: null,
    product_parent_id: null,
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  const rawCategory = req.query.category_id ?? req.query.categoryId;
  if (rawCategory != null && String(rawCategory).trim() !== "") {
    const categoryOid = coalesceObjectId(rawCategory);
    if (
      !categoryOid ||
      !mongoose.Types.ObjectId.isValid(String(categoryOid))
    ) {
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

  const response = await handleGenericGetAll(req, "product", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
    ],
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

module.exports = {
  productCreate,
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

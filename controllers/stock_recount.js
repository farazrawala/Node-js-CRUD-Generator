const mongoose = require("mongoose");
const StockRecount = require("../models/stock_recount");
const WarehouseInventory = require("../models/warehouse_inventory");
const Product = require("../models/product");
const InventoryMovements = require("../models/inventory_movements");
const { coalesceObjectId } = require("../utils/modelHelper");
const { invalidateModuleListCachesForReq } = require("../utils/redisCache");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const {
  insertInventoryMovementRecordsBulk,
} = require("./inventory_movements");

function toObjectId(value) {
  const raw = coalesceObjectId(value);
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return raw instanceof mongoose.Types.ObjectId
    ? raw
    : new mongoose.Types.ObjectId(s);
}

function roundQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

function tenantCompanyId(req) {
  return toObjectId(req.user?.company_id);
}

function clientError(res, status, error, extra = {}) {
  return res.status(status).json({
    success: false,
    status,
    error,
    message: error,
    ...extra,
  });
}

function lineJson(doc) {
  if (!doc) return doc;
  return typeof doc.toObject === "function"
    ? doc.toObject({ flattenMaps: true })
    : doc;
}

async function runWithOptionalTransaction(work) {
  let session = null;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    const result = await work(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    if (session) {
      try {
        await session.abortTransaction();
      } catch {
        /* ignore */
      }
    }
    if (isMongoTransactionUnsupportedError(err)) {
      return work(null);
    }
    throw err;
  } finally {
    if (session) session.endSession();
  }
}

/**
 * POST /stock_recount/start
 * Body: { warehouse_id }
 * Seeds one line per active warehouse_inventory row. Client does not send
 * stock_recount_id or system_qty.
 */
async function stockRecountStart(req, res) {
  try {
    const companyId = tenantCompanyId(req);
    if (!companyId) {
      return clientError(res, 400, "Company is required");
    }

    const warehouseId = toObjectId(req.body?.warehouse_id);
    if (!warehouseId) {
      return clientError(res, 400, "warehouse_id is required");
    }

    const userId = toObjectId(req.user?._id);
    const stockRecountId = new mongoose.Types.ObjectId();

    let inventoryQuery = WarehouseInventory.find({
      company_id: companyId,
      warehouse_id: warehouseId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).select("product_id warehouse_id quantity");
    const inventory = await inventoryQuery.lean();

    const lines = [];
    const seen = new Set();
    for (const row of inventory) {
      const productId = toObjectId(row.product_id);
      const inventoryId = toObjectId(row._id);
      if (!productId || !inventoryId) continue;
      const key = String(productId);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        stock_recount_id: stockRecountId,
        product_id: productId,
        warehouse_id: toObjectId(row.warehouse_id) || warehouseId,
        warehouse_inventory_id: inventoryId,
        system_qty: roundQty(row.quantity) ?? 0,
        counted_qty: null,
        variance_qty: 0,
        company_id: companyId,
        created_by: userId || undefined,
        updated_by: userId || undefined,
        status: "active",
        deletedAt: null,
      });
    }

    if (lines.length === 0) {
      return clientError(
        res,
        400,
        "No warehouse inventory found for this warehouse",
      );
    }

    await StockRecount.insertMany(lines, { ordered: true });
    await invalidateModuleListCachesForReq(req, "stock_recount");

    const preview = await StockRecount.find({
      company_id: companyId,
      stock_recount_id: stockRecountId,
      deletedAt: null,
    })
      .populate("product_id", "product_name name sku barcode product_code")
      .populate("warehouse_id", "name warehouse_name code warehouse_code")
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      success: true,
      stock_recount_id: String(stockRecountId),
      warehouse_id: String(warehouseId),
      total_lines: lines.length,
      data: preview,
    });
  } catch (err) {
    console.error("[stock_recount/start]", err);
    return clientError(
      res,
      err.statusCode || 500,
      err.message || "Failed to start stock recount",
    );
  }
}

/**
 * PATCH /stock_recount/count/:id
 * Body: { counted_qty }
 * Saves the document so pre('validate') sets variance_qty.
 */
async function stockRecountCount(req, res) {
  try {
    const companyId = tenantCompanyId(req);
    const lineId = toObjectId(req.params?.id);
    if (!lineId) {
      return clientError(res, 400, "Missing stock recount line id");
    }

    const filter = { _id: lineId, deletedAt: null };
    if (companyId) filter.company_id = companyId;

    const line = await StockRecount.findOne(filter);
    if (!line) {
      return clientError(res, 404, "Stock recount line not found");
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "counted_qty")) {
      return clientError(res, 400, "counted_qty is required");
    }

    const raw = req.body.counted_qty;
    if (raw == null || raw === "") {
      line.counted_qty = null;
    } else {
      const counted = roundQty(raw);
      if (counted == null) {
        return clientError(res, 400, "counted_qty must be a number");
      }
      line.counted_qty = counted;
    }

    const userId = toObjectId(req.user?._id);
    if (userId) line.updated_by = userId;
    await line.save();
    await invalidateModuleListCachesForReq(req, "stock_recount");

    const populated = await StockRecount.findById(line._id)
      .populate("product_id", "product_name name sku barcode product_code")
      .populate("warehouse_id", "name warehouse_name code warehouse_code")
      .lean();

    return res.status(200).json({
      success: true,
      data: populated || lineJson(line),
    });
  } catch (err) {
    console.error("[stock_recount/count]", err);
    return clientError(
      res,
      err.statusCode || 500,
      err.message || "Failed to count stock recount line",
    );
  }
}

async function postRecountSession(req, session) {
  const companyId = tenantCompanyId(req);
  if (!companyId) {
    const err = new Error("Company is required");
    err.statusCode = 400;
    throw err;
  }

  const stockRecountId = toObjectId(req.body?.stock_recount_id);
  if (!stockRecountId) {
    const err = new Error("stock_recount_id is required");
    err.statusCode = 400;
    throw err;
  }

  let linesQuery = StockRecount.find({
    company_id: companyId,
    stock_recount_id: stockRecountId,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    counted_qty: { $ne: null },
    variance_qty: { $ne: 0 },
  });
  if (session) linesQuery = linesQuery.session(session);
  const lines = await linesQuery.lean();

  let postedQuery = InventoryMovements.find({
    company_id: companyId,
    reference_type: "stock_recount",
    reference_id: stockRecountId,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select("product_id warehouse_id");
  if (session) postedQuery = postedQuery.session(session);
  const alreadyPosted = await postedQuery.lean();
  const postedKeys = new Set(
    alreadyPosted.map(
      (row) => `${String(row.product_id)}:${String(row.warehouse_id)}`,
    ),
  );

  const userId = toObjectId(req.user?._id);
  const movementDocs = [];
  const applied = [];
  const skipped = [];

  for (const line of lines) {
    const productId = toObjectId(line.product_id);
    const warehouseId = toObjectId(line.warehouse_id);
    const key = `${String(productId)}:${String(warehouseId)}`;
    if (!productId || !warehouseId) {
      skipped.push({ _id: line._id, reason: "missing_refs" });
      continue;
    }
    if (postedKeys.has(key)) {
      skipped.push({ _id: line._id, reason: "already_posted" });
      continue;
    }

    const inventoryRowId = toObjectId(line.warehouse_inventory_id);
    const wiFilter = {
      company_id: companyId,
      product_id: productId,
      warehouse_id: warehouseId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
    if (inventoryRowId) wiFilter._id = inventoryRowId;
    let wiQuery = WarehouseInventory.findOne(wiFilter).select("quantity");
    if (session) wiQuery = wiQuery.session(session);
    const wi = await wiQuery.lean();
    const currentQty = roundQty(wi?.quantity) ?? 0;
    const counted = roundQty(line.counted_qty);
    if (counted == null) {
      skipped.push({ _id: line._id, reason: "uncounted" });
      continue;
    }

    const delta = roundQty(counted - currentQty);
    if (delta == null || delta === 0) {
      skipped.push({ _id: line._id, reason: "no_delta" });
      continue;
    }

    await WarehouseInventory.applyQuantityDelta({
      productId,
      warehouseId,
      companyId,
      qtyDelta: delta,
      userId,
      session,
      req,
      logContext: {
        reference_type: "stock_recount",
        reference_id: stockRecountId,
      },
    });

    let unitCost = 0;
    let productQuery = Product.findById(productId).select(
      "wholesale_price product_name",
    );
    if (session) productQuery = productQuery.session(session);
    const product = await productQuery.lean();
    const wholesale = Number(product?.wholesale_price);
    if (Number.isFinite(wholesale) && wholesale > 0) unitCost = roundQty(wholesale) || 0;

    const qty = Math.abs(delta);
    movementDocs.push({
      product_id: productId,
      warehouse_id: warehouseId,
      quantity: qty,
      movement_type: delta > 0 ? "in" : "out",
      unit_cost: unitCost,
      total_cost: roundQty(qty * unitCost) ?? 0,
      reference_type: "stock_recount",
      reference_id: stockRecountId,
      reference_name: `Stock Recount (${String(stockRecountId).slice(-8)})`,
      company_id: companyId,
      created_by: userId || undefined,
      updated_by: userId || undefined,
      status: "active",
      deletedAt: null,
    });
    postedKeys.add(key);
    applied.push({
      _id: line._id,
      product_id: String(productId),
      warehouse_id: String(warehouseId),
      counted_qty: counted,
      previous_qty: currentQty,
      qty_delta: delta,
    });
  }

  if (movementDocs.length) {
    await insertInventoryMovementRecordsBulk(movementDocs, session);
  }

  return {
    stock_recount_id: String(stockRecountId),
    posted: applied.length,
    skipped: skipped.length,
    movements: movementDocs.length,
    data: applied,
  };
}

/**
 * POST /stock_recount/post
 * Body: { stock_recount_id }
 * Applies counted vs current warehouse_inventory qty; writes inventory_movements.
 */
async function stockRecountPost(req, res) {
  try {
    const result = await runWithOptionalTransaction((session) =>
      postRecountSession(req, session),
    );
    await invalidateModuleListCachesForReq(req, "stock_recount");
    await invalidateModuleListCachesForReq(req, "warehouse_inventory");
    await invalidateModuleListCachesForReq(req, "inventory_movements");
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("[stock_recount/post]", err);
    return clientError(
      res,
      err.statusCode || 500,
      err.message || "Failed to post stock recount",
    );
  }
}

module.exports = {
  stockRecountStart,
  stockRecountCount,
  stockRecountPost,
};

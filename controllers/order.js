const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const InventoryMovements = require("../models/inventory_movements");
const Transaction = require("../models/transaction");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  coalesceObjectId,
} = require("../utils/modelHelper");
const {
  logControllerError,
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { createApplicationLog } = require("../utils/applicationLogs");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const { insertInventoryMovementRecord } = require("./inventory_movements");
const { evaluateProductStockAlert } = require("./alerts");

const ORDER_TRANSACTION_ERROR_LOG = {
  action: "POST ORDER TRANSACTION ERROR",
  tags: ["api", "order", "transaction", "error"],
  fallbackUrl: "/api/order/save",
};

/** HTTP JSON shape for a failed `handleGenericCreate` (keeps `details`, `type`, validation keys). */
function clientPayloadFromGenericCreateFailure(response, fallbackError) {
  if (response?.success && response?.data) return null;
  if (!response) {
    return {
      success: false,
      status: 500,
      error: fallbackError || "Request failed",
    };
  }
  const status = response.status || 400;
  const out = {
    success: false,
    status,
    error: response.error || fallbackError || "Request failed",
  };
  if (response.message != null) out.message = response.message;
  if (response.details != null) out.details = response.details;
  if (response.type != null) out.type = response.type;
  if (response.missing != null) out.missing = response.missing;
  if (response.required != null) out.required = response.required;
  if (response.received != null) out.received = response.received;
  if (response.qty_needed != null) out.qty_needed = response.qty_needed;
  if (response.product_id != null) out.product_id = response.product_id;
  if (response.company_id != null) out.company_id = response.company_id;
  if (response.preferred_warehouse_id != null) {
    out.preferred_warehouse_id = response.preferred_warehouse_id;
  }
  if (response.warehouse_id != null) out.warehouse_id = response.warehouse_id;
  if (response.available_qty != null)
    out.available_qty = response.available_qty;
  if (Array.isArray(response.warehouses)) out.warehouses = response.warehouses;
  if (Array.isArray(response.insufficient_warehouses)) {
    out.insufficient_warehouses = response.insufficient_warehouses;
  }
  return out;
}

/** Log line / `Error.message` when converting a generic-create failure into a thrown error. */
function logMessageFromGenericCreateFailure(response, fallbackError) {
  const r = response || {};
  let detailStr = "";
  if (typeof r.details === "string") {
    detailStr = r.details.trim();
  } else if (Array.isArray(r.details) && r.details.length) {
    detailStr = r.details.join("; ");
  } else if (r.details != null && typeof r.details === "object") {
    try {
      detailStr = JSON.stringify(r.details);
    } catch {
      detailStr = String(r.details);
    }
  }
  const headline = r.error || r.message || fallbackError || "Request failed";
  return detailStr && headline !== detailStr ?
      `${headline}: ${detailStr}`
    : detailStr || headline;
}

function throwOrderCreateFromGenericFailure(response, fallbackError) {
  const err = new Error(
    logMessageFromGenericCreateFailure(response, fallbackError),
  );
  err.clientErrorPayload = clientPayloadFromGenericCreateFailure(
    response,
    fallbackError,
  );
  throw err;
}

function indexedContainerLength(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "object") {
    const nums = Object.keys(v)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n));
    if (nums.length === 0) return 0;
    return Math.max(...nums) + 1;
  }
  return 0;
}

function indexedContainerGet(v, i) {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v[i];
  if (typeof v === "object") return v[i] ?? v[String(i)];
  return undefined;
}

/** Flat keys: product_id[0], qty[0], price[0], … (raw multipart without parseNested, etc.) */
function parseOrderLineItemsFromFlatKeys(body) {
  const byIndex = new Map();
  if (!body || typeof body !== "object") return [];
  for (const key of Object.keys(body)) {
    let m = key.match(/^product_id\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).product_id = body[key];
      continue;
    }
    m = key.match(/^qty\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).qty = body[key];
      continue;
    }
    m = key.match(/^price\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).price = body[key];
      continue;
    }
    m = key.match(/^warehouse_id\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).warehouse_id = body[key];
      continue;
    }
  }
  const sorted = [...byIndex.keys()].sort((a, b) => a - b);
  const lines = [];
  for (const i of sorted) {
    const row = byIndex.get(i);
    const qtyRaw = row.qty;
    const qtyNum = parseFloat(String(qtyRaw ?? "").trim());
    const priceNum = parseFloat(String(row.price ?? "").trim());
    const subtotal =
      Number.isFinite(qtyNum) && Number.isFinite(priceNum) ?
        qtyNum * priceNum
      : NaN;
    lines.push({
      product_id: row.product_id,
      warehouse_id: row.warehouse_id,
      qtyRaw,
      qty: qtyNum,
      price: priceNum,
      subtotal,
    });
  }
  return lines.filter(
    (l) =>
      l.product_id &&
      String(l.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
      Number.isFinite(l.subtotal),
  );
}

/**
 * Parallel containers from express-fileupload parseNested or qs (urlencoded):
 * body.product_id = [id0, id1], body.qty = [...], body.price = [...]
 */
function parseOrderLineItemsFromIndexedContainers(body) {
  if (!body || typeof body !== "object") return [];
  const p = body.product_id;
  const q = body.qty;
  const pr = body.price;
  const w = body.warehouse_id;
  const len = Math.max(
    indexedContainerLength(p),
    indexedContainerLength(q),
    indexedContainerLength(pr),
    indexedContainerLength(w),
  );
  if (len === 0) return [];

  const lines = [];
  for (let i = 0; i < len; i++) {
    const product_id = indexedContainerGet(p, i);
    const qtyRaw = indexedContainerGet(q, i);
    const priceRaw = indexedContainerGet(pr, i);
    const warehouse_id = indexedContainerGet(w, i);
    const qtyNum = parseFloat(String(qtyRaw ?? "").trim());
    const priceNum = parseFloat(String(priceRaw ?? "").trim());
    const subtotal =
      Number.isFinite(qtyNum) && Number.isFinite(priceNum) ?
        qtyNum * priceNum
      : NaN;
    lines.push({
      product_id,
      warehouse_id,
      qtyRaw,
      qty: qtyNum,
      price: priceNum,
      subtotal,
    });
  }
  return lines.filter(
    (l) =>
      l.product_id &&
      String(l.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
      Number.isFinite(l.subtotal),
  );
}

/** Form keys: product_id[0], qty[0], price[0], … or nested arrays from parseNested / qs */
function parseOrderLineItems(body) {
  const fromFlat = parseOrderLineItemsFromFlatKeys(body);
  if (fromFlat.length > 0) return fromFlat;
  return parseOrderLineItemsFromIndexedContainers(body);
}

function stripLineItemKeys(body) {
  const out = {};
  for (const k of Object.keys(body)) {
    if (/^(product_id|qty|price|warehouse_id)\[\d+\]$/.test(k)) continue;
    out[k] = body[k];
  }
  if (Array.isArray(out.product_id)) delete out.product_id;
  if (Array.isArray(out.qty)) delete out.qty;
  if (Array.isArray(out.price)) delete out.price;
  if (Array.isArray(out.warehouse_id)) delete out.warehouse_id;
  return out;
}

function roundMoney2(n) {
  const x = typeof n === "number" ? n : Number(String(n ?? "").trim());
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

/** Sum of parsed POS line subtotals (matches persisted order_item.subtotal). */
function sumParsedLinesSubtotal(lines) {
  return roundMoney2(
    lines.reduce(
      (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
      0,
    ),
  );
}

/** Company default store from populated `req.user.company_id.warehouse_id`. */
function resolveDefaultWarehouseId(req) {
  const company = req.user?.company_id;
  if (!company) return "";
  const raw =
    company && typeof company === "object" && company.warehouse_id != null ?
      company.warehouse_id
    : company;
  if (raw instanceof mongoose.Types.ObjectId) return String(raw);
  const s = String(raw ?? "").trim();
  return mongoose.Types.ObjectId.isValid(s) ? s : "";
}

/** Per-line warehouse, else company default store (POS). */
function resolveOrderLineWarehouseId(line, req) {
  const fromLine =
    line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
  if (fromLine && mongoose.Types.ObjectId.isValid(fromLine)) return fromLine;
  return resolveDefaultWarehouseId(req);
}

/** Sum `warehouse_inventory.quantity` for one product (all warehouses, tenant-scoped). */
async function sumWarehouseInventoryQtyForProduct(
  productId,
  companyId,
  mongoSession = null,
) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !cid) return 0;

  let agg = WarehouseInventory.aggregate([
    {
      $match: {
        product_id: pid,
        company_id: cid,
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ]);
  if (mongoSession) agg = agg.session(mongoSession);
  const rows = await agg;
  return Math.round((rows[0]?.total || 0) * 100) / 100;
}

/**
 * Pick a warehouse with enough on-hand for this line (`warehouse_inventory.quantity`).
 * Prefers line/default warehouse when sufficient; otherwise highest available qty that can fulfill the sale.
 */
async function resolveWarehouseForOutboundLine({
  productId,
  companyId,
  qtyNeeded,
  preferredWarehouseId,
  mongoSession = null,
}) {
  const qty = Number(qtyNeeded);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Invalid quantity for warehouse resolution");
  }
  const pidRaw = coalesceObjectId(productId);
  const cidRaw = coalesceObjectId(companyId);
  const pid =
    pidRaw && mongoose.Types.ObjectId.isValid(String(pidRaw)) ?
      new mongoose.Types.ObjectId(String(pidRaw))
    : null;
  const cid =
    cidRaw && mongoose.Types.ObjectId.isValid(String(cidRaw)) ?
      new mongoose.Types.ObjectId(String(cidRaw))
    : null;
  if (!pid || !cid) {
    const err = new Error(
      "product_id and company_id are required to resolve warehouse stock",
    );
    err.clientPayload = {
      success: false,
      status: 400,
      error: "Warehouse stock check failed",
      details: err.message,
      type: "validation",
    };
    throw err;
  }

  const avail = new Map();
  let whQuery = WarehouseInventory.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select("warehouse_id quantity");
  if (mongoSession) whQuery = whQuery.session(mongoSession);
  const whRows = await whQuery.lean();
  for (const row of whRows) {
    const wid = String(row.warehouse_id);
    const onHand = Math.max(0, Number(row.quantity) || 0);
    avail.set(wid, onHand);
  }

  const pref =
    (
      preferredWarehouseId &&
      mongoose.Types.ObjectId.isValid(String(preferredWarehouseId))
    ) ?
      String(preferredWarehouseId)
    : null;

  if (pref && !avail.has(pref)) {
    avail.set(pref, 0);
  }

  if (pref && (avail.get(pref) || 0) >= qty) {
    return pref;
  }

  const candidates = [...avail.entries()]
    .filter(([, onHand]) => onHand >= qty)
    .sort((a, b) => b[1] - a[1]);

  if (candidates.length > 0) {
    return candidates[0][0];
  }

  const warehouseStock = [...avail.entries()]
    .map(([warehouse_id, available_qty]) => ({
      warehouse_id,
      available_qty,
      qty_needed: qty,
      sufficient: available_qty >= qty,
      short_by: Math.max(0, qty - available_qty),
    }))
    .sort((a, b) => b.available_qty - a.available_qty);

  const insufficientWarehouses = warehouseStock.filter((w) => !w.sufficient);

  const warehouseSummary =
    warehouseStock.length === 0 ?
      "No warehouse_inventory on-hand for this product in any warehouse."
    : insufficientWarehouses
        .map(
          (w) =>
            `warehouse ${w.warehouse_id}: available ${w.available_qty}, need ${qty} (short by ${w.short_by})`,
        )
        .join("; ");

  const err = new Error(
    `Insufficient stock for product ${String(pid)}: need ${qty}. ${warehouseSummary}`,
  );
  err.clientPayload = {
    success: false,
    status: 400,
    error: "Insufficient stock",
    details: `No warehouse has at least ${qty} units in warehouse_inventory for product ${String(pid)} and company ${String(cid)}. ${warehouseSummary}`,
    type: "validation",
    qty_needed: qty,
    product_id: String(pid),
    company_id: String(cid),
    preferred_warehouse_id: pref,
    warehouses: warehouseStock,
    insufficient_warehouses: insufficientWarehouses,
  };
  throw err;
}

function orderSessionOpts(mongoSession) {
  return mongoSession ? { session: mongoSession } : {};
}

/** Soft-delete active GL rows for one `transaction_number` (order update / line replace). */
async function softDeleteActiveGlByTransactionNumber({
  transactionNumber,
  mongoSession = null,
  userId = null,
}) {
  const txnNo = String(transactionNumber ?? "").trim();
  if (!txnNo) {
    return { modifiedCount: 0, matchedCount: 0 };
  }

  const $set = {
    deletedAt: new Date(),
    status: "inactive",
  };
  const userIdStr = String(userId ?? "").trim();
  if (userId != null && mongoose.Types.ObjectId.isValid(userIdStr)) {
    $set.updated_by =
      userId instanceof mongoose.Types.ObjectId ?
        userId
      : new mongoose.Types.ObjectId(userIdStr);
  }

  return Transaction.updateMany(
    {
      transaction_number: txnNo,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    },
    { $set },
    orderSessionOpts(mongoSession),
  );
}

/** Four GL postings for an order — same row order as `order_save` / `afterCreate`. */
async function rebuildOrderGlTransactions({
  record,
  orderReq,
  lines,
  mongoSession = null,
  postUpdateTransactions = null,
}) {
  const transaction_number = record?.transaction_number;
  const orderTotal =
    lines.length > 0 ?
      Number(
        lines
          .reduce(
            (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
            0,
          )
          .toFixed(2),
      )
    : Number(record?.lines_subtotal ?? orderReq.body?.lines_subtotal ?? 0);

  const { created, failed } = await transactionBulkCreate(
    orderReq,
    [
      {
        account_id: orderReq.user.company_id.default_sales_account,
        type: "credit",
        amount: orderTotal,
        reference_user_id: record?.customer_id,
        transaction_number,
        description: "Sale Order",
        reference_id: {
          module: "order",
          ref_id: record._id,
        },
        ...(record?.createdAt ? { createdAt: record.createdAt } : {}),
      },
      {
        account_id: orderReq.user.company_id.default_shipping_account,
        type: "credit",
        amount: record?.shipment,
        reference_user_id: record?.customer_id,
        transaction_number,
        description: "Sale Order",
        reference_id: {
          module: "order",
          ref_id: record._id,
        },
        ...(record?.createdAt ? { createdAt: record.createdAt } : {}),
      },
      {
        account_id: orderReq.user.company_id.default_sales_discount_account,
        type: "debit",
        amount: record?.discount,
        reference_user_id: record?.customer_id,
        transaction_number,
        description: "Sale Discount",
        reference_id: {
          module: "order",
          ref_id: record._id,
        },
        ...(record?.createdAt ? { createdAt: record.createdAt } : {}),
      },
      {
        account_id:
          orderReq.body?.posPayMethod ??
          orderReq.body?.payment_method_accounts_id,
        type: "debit",
        amount: record?.amount_received,
        reference_user_id: record?.customer_id,
        transaction_number,
        description: "Mode of Payment",
        reference_id: {
          module: "order",
          ref_id: record._id,
        },
        ...(record?.createdAt ? { createdAt: record.createdAt } : {}),
      },
    ],
    { stopOnError: true, session: mongoSession },
  );

  if (postUpdateTransactions) {
    postUpdateTransactions.created = created;
    postUpdateTransactions.failed = failed;
  }

  if (failed.length) {
    const msg = `Post-order transaction bulk insert failed: ${JSON.stringify(
      failed,
    )}`;
    console.error("⚠️ Post-order transaction bulk insert failed:", failed);
    await logControllerError(orderReq, msg, ORDER_TRANSACTION_ERROR_LOG);
    const glErr = new Error(msg);
    glErr.statusCode = 400;
    glErr.responseType = "transaction_bulk";
    glErr.details = failed;
    throw glErr;
  }

  if (created[0]?.data?._id) {
    console.log(
      "✅ Transaction(s) created:",
      created.map((c) => c.data._id),
    );
  }

  return { created, failed };
}

/**
 * Soft-delete / remove prior order-linked rows in one call.
 * Header-only update: `{ gl: true }`. Line replace: `{ gl: true, inventoryMovements: true, lineItems: true }`.
 */
async function softDeleteActiveOrderRelatedRecords({
  orderId,
  transactionNumber,
  companyId,
  mongoSession = null,
  userId = null,
  options = {},
} = {}) {
  const {
    gl = false,
    inventoryMovements: deleteMovements = false,
    lineItems: deleteLineItems = false,
  } = options;

  const result = {
    transactions: { modifiedCount: 0, matchedCount: 0 },
    inventoryMovements: { modifiedCount: 0, matchedCount: 0 },
    lineItems: { deletedCount: 0 },
  };

  const txnNo = String(transactionNumber ?? "").trim();
  if (gl && txnNo) {
    result.transactions = await softDeleteActiveGlByTransactionNumber({
      transactionNumber: txnNo,
      mongoSession,
      userId,
    });
    if (result.transactions.modifiedCount > 0) {
      console.log(
        "✅ Transaction rows soft-deleted:",
        result.transactions.modifiedCount,
      );
    }
  }

  if (deleteMovements) {
    result.inventoryMovements =
      await InventoryMovements.softDeleteActiveByReference({
        referenceType: "order",
        referenceId: orderId,
        companyId,
        session: mongoSession,
        userId,
      });
    if (result.inventoryMovements.modifiedCount > 0) {
      console.log(
        "✅ Order inventory movement rows soft-deleted:",
        result.inventoryMovements.modifiedCount,
      );
    }
  }

  if (deleteLineItems) {
    const orderIdStr = String(orderId ?? "").trim();
    if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
      throw new Error("Valid order id is required to delete order line items");
    }
    result.lineItems = await OrderItem.deleteMany(
      { order_id: orderId },
      orderSessionOpts(mongoSession),
    );
    if (result.lineItems.deletedCount > 0) {
      console.log(
        "✅ Order line items removed:",
        result.lineItems.deletedCount,
      );
    }
  }

  return result;
}

function warehouseStockKey(productId, warehouseId) {
  return `${String(productId).trim()}:${String(warehouseId).trim()}`;
}

/** Sum outbound qty per `product_id:warehouse_id` from prior order `out` movements. */
function buildOutboundQtyMapFromMovements(movements) {
  const map = new Map();
  for (const mov of movements || []) {
    const qty = Number(mov.quantity);
    const wid = mov.warehouse_id != null ? String(mov.warehouse_id).trim() : "";
    const pid = mov.product_id != null ? String(mov.product_id).trim() : "";
    if (
      !pid ||
      !wid ||
      !mongoose.Types.ObjectId.isValid(pid) ||
      !mongoose.Types.ObjectId.isValid(wid) ||
      !Number.isFinite(qty) ||
      qty <= 0
    ) {
      continue;
    }
    const key = warehouseStockKey(pid, wid);
    map.set(key, roundMoney2((map.get(key) || 0) + qty));
  }
  return map;
}

/** Prefer warehouse from prior order movement for this product (highest prior outbound qty). */
function findPriorWarehouseForProduct(oldMap, productIdStr) {
  const pid = String(productIdStr).trim();
  let bestWid = null;
  let bestQty = 0;
  for (const [key, qty] of oldMap.entries()) {
    const [mapPid, mapWid] = key.split(":");
    if (mapPid !== pid) continue;
    if (qty > bestQty) {
      bestQty = qty;
      bestWid = mapWid;
    }
  }
  return bestWid;
}

/**
 * Line replace inventory: warehouse delta (old − new qty per product/warehouse), then movement insert only.
 * Example: old 4 → new 2 on same warehouse adds +2 to `warehouse_inventory` (does not re-deduct 2 when 2 on hand).
 */
async function applyOrderLineReplaceInventory({
  oldOutMovements,
  existingOrderItems,
  newLines,
  orderId,
  companyId,
  companyIdOid,
  req,
  mongoSession = null,
  logUrl = "/api/order/order_update",
}) {
  const oldMap = buildOutboundQtyMapFromMovements(oldOutMovements);

  // Fallback when movement rows are missing: treat persisted line qty as old outbound on default warehouse.
  if (oldMap.size === 0 && (existingOrderItems || []).length > 0) {
    const defaultWarehouseId = resolveDefaultWarehouseId(req);
    for (const item of existingOrderItems) {
      const pid = item.product_id != null ? String(item.product_id).trim() : "";
      const qty = Number(item.qty);
      if (
        !pid ||
        !mongoose.Types.ObjectId.isValid(pid) ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        continue;
      }
      const wid =
        findPriorWarehouseForProduct(oldMap, pid) ||
        ((
          defaultWarehouseId &&
          mongoose.Types.ObjectId.isValid(defaultWarehouseId)
        ) ?
          String(defaultWarehouseId).trim()
        : null);
      if (!wid) continue;
      const key = warehouseStockKey(pid, wid);
      oldMap.set(key, roundMoney2((oldMap.get(key) || 0) + qty));
    }
  }

  const newMap = new Map();
  const resolvedNewLines = [];

  for (const line of newLines) {
    const unitCost = Number(line.price);
    const lineQtyNum = Number(line.qty);
    if (
      !Number.isFinite(unitCost) ||
      unitCost < 0 ||
      !Number.isFinite(lineQtyNum) ||
      lineQtyNum <= 0
    ) {
      throw new Error(
        "Each order line needs a finite unit price (price) and positive quantity for inventory movement",
      );
    }

    const productIdStr = String(line.product_id).trim();
    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      throw new Error("Each order line needs a valid product_id");
    }

    let warehouseIdStr =
      findPriorWarehouseForProduct(oldMap, productIdStr) ||
      resolveOrderLineWarehouseId(line, req) ||
      null;

    if (
      !warehouseIdStr ||
      !mongoose.Types.ObjectId.isValid(String(warehouseIdStr).trim())
    ) {
      try {
        warehouseIdStr = await resolveWarehouseForOutboundLine({
          productId: line.product_id,
          companyId: companyIdOid || companyId,
          qtyNeeded: lineQtyNum,
          preferredWarehouseId:
            resolveOrderLineWarehouseId(line, req) || undefined,
          mongoSession,
        });
      } catch (warehouseResolveErr) {
        if (warehouseResolveErr.clientPayload) {
          throwOrderCreateFromGenericFailure(
            warehouseResolveErr.clientPayload,
            "No warehouse with sufficient stock for order line",
          );
        }
        throw warehouseResolveErr;
      }
    }

    warehouseIdStr = String(warehouseIdStr).trim();
    const key = warehouseStockKey(productIdStr, warehouseIdStr);
    newMap.set(key, roundMoney2((newMap.get(key) || 0) + lineQtyNum));
    resolvedNewLines.push({
      line,
      productIdStr,
      warehouseIdStr,
      lineQtyNum,
      unitCost,
    });
  }

  const productStockUpdates = [];
  const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);

  for (const key of allKeys) {
    const oldQty = oldMap.get(key) || 0;
    const newQty = newMap.get(key) || 0;
    const delta = roundMoney2(oldQty - newQty);
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.0001) continue;

    const [productIdStr, warehouseIdStr] = key.split(":");
    try {
      if (delta < 0) {
        const { stockChanges } =
          await WarehouseInventory.applySplitWarehouseOutbound({
            productId: productIdStr,
            companyId: companyIdOid || companyId,
            qtyNeeded: Math.abs(delta),
            preferredWarehouseId: warehouseIdStr,
            userId: req.user?._id,
            session: mongoSession,
          });
        for (const whChange of stockChanges) {
          productStockUpdates.push({
            ...whChange,
            source: "warehouse_inventory",
            qty_delta_reason: "order_line_replace",
            old_outbound_qty: oldQty,
            new_outbound_qty: newQty,
          });
        }
      } else {
        const whChange = await WarehouseInventory.applyQuantityDelta({
          productId: productIdStr,
          warehouseId: warehouseIdStr,
          companyId: companyIdOid || companyId,
          qtyDelta: delta,
          userId: req.user?._id,
          session: mongoSession,
        });
        if (whChange) {
          productStockUpdates.push({
            ...whChange,
            source: "warehouse_inventory",
            qty_delta_reason: "order_line_replace",
            old_outbound_qty: oldQty,
            new_outbound_qty: newQty,
          });
        }
      }
    } catch (whErr) {
      const whMsg = String(
        whErr?.message || "Warehouse inventory update failed",
      );
      const mapped = new Error(whMsg);
      mapped.clientErrorPayload = {
        success: false,
        status: 400,
        error: "Insufficient warehouse inventory",
        message: whMsg,
        details: whMsg,
        type: "validation",
        product_id: productIdStr,
        warehouse_id: warehouseIdStr,
        old_outbound_qty: oldQty,
        new_outbound_qty: newQty,
        qty_delta: delta,
      };
      throw mapped;
    }
  }

  for (const {
    line,
    productIdStr,
    warehouseIdStr,
    lineQtyNum,
    unitCost,
  } of resolvedNewLines) {
    const totalCostMovement = Math.round(lineQtyNum * unitCost * 100) / 100;
    const bodyBeforeInventoryMovement = req.body;
    const hadRouteParamId = Object.prototype.hasOwnProperty.call(
      req.params,
      "id",
    );
    const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

    req.body = {
      product_id: productIdStr,
      warehouse_id: warehouseIdStr,
      quantity: lineQtyNum,
      movement_type: "out",
      unit_cost: unitCost,
      total_cost: totalCostMovement,
      reference_type: "order",
      reference_id: orderId,
      reference_name: "Order",
      company_id: companyIdOid || companyId,
      status: "active",
    };

    try {
      await insertInventoryMovementRecord(req, mongoSession);
    } catch (inventoryMovementErr) {
      if (inventoryMovementErr.clientPayload) {
        throwOrderCreateFromGenericFailure(
          inventoryMovementErr.clientPayload,
          "Inventory movement for order failed",
        );
      }
      throw inventoryMovementErr;
    } finally {
      req.body = bodyBeforeInventoryMovement;
      if (hadRouteParamId) {
        req.params.id = savedRouteParamId;
      } else {
        delete req.params.id;
      }
    }

    const onHandAfter = await sumWarehouseInventoryQtyForProduct(
      productIdStr,
      companyIdOid || companyId,
      mongoSession,
    );
    const alertResult = await evaluateProductStockAlert({
      req,
      productId: productIdStr,
      companyId: companyIdOid || companyId,
      onHand: onHandAfter,
      pathQty: onHandAfter,
      session: mongoSession,
      logUrl,
    });
    if (!alertResult.success) {
      throw new Error(
        alertResult.message ||
          alertResult.error ||
          "Product stock alert check failed",
      );
    }
  }

  return productStockUpdates;
}

/**
 * Line replace teardown: snapshot prior `out` movements, then `softDeleteActiveOrderRelatedRecords`.
 */
async function teardownOrderForLineReplace({
  orderId,
  transactionNumber,
  companyId,
  mongoSession = null,
  userId = null,
}) {
  const orderIdStr = String(orderId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
    throw new Error("Valid order id is required for line replace teardown");
  }

  let movQuery = InventoryMovements.find({
    reference_type: "order",
    reference_id: orderId,
    movement_type: "out",
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select("product_id warehouse_id quantity");
  if (mongoSession) movQuery = movQuery.session(mongoSession);
  const oldOutMovements = await movQuery.lean();

  const { transactions, inventoryMovements, lineItems } =
    await softDeleteActiveOrderRelatedRecords({
      orderId,
      transactionNumber,
      companyId,
      mongoSession,
      userId,
      options: {
        gl: true,
        inventoryMovements: true,
        lineItems: true,
      },
    });

  return {
    oldOutMovements,
    transactions,
    inventoryMovements,
    lineItems,
  };
}

/**
 * Per cart line: resolve warehouse, outbound `warehouse_inventory`, insert `inventory_movements` (`out`), stock alert.
 */
async function applyOrderOutboundLines({
  lines,
  orderId,
  companyId,
  companyIdOid,
  req,
  mongoSession = null,
  logUrl = "/api/order/order_save",
}) {
  const productStockUpdates = [];

  for (const line of lines) {
    const unitCost = Number(line.price);
    const lineQtyNum = Number(line.qty);
    if (
      !Number.isFinite(unitCost) ||
      unitCost < 0 ||
      !Number.isFinite(lineQtyNum) ||
      lineQtyNum <= 0
    ) {
      throw new Error(
        "Each order line needs a finite unit price (price) and positive quantity for inventory movement",
      );
    }

    const productIdStr = String(line.product_id).trim();
    if (!productIdStr || !mongoose.Types.ObjectId.isValid(productIdStr)) {
      throw new Error("Each order line needs a valid product_id");
    }

    const preferredWarehouseId = resolveOrderLineWarehouseId(line, req);

    let allocations;
    let stockChanges;
    try {
      ({ allocations, stockChanges } =
        await WarehouseInventory.applySplitWarehouseOutbound({
          productId: productIdStr,
          companyId: companyIdOid || companyId,
          qtyNeeded: lineQtyNum,
          preferredWarehouseId:
            (
              preferredWarehouseId &&
              mongoose.Types.ObjectId.isValid(preferredWarehouseId)
            ) ?
              preferredWarehouseId
            : null,
          userId: req.user?._id,
          session: mongoSession,
        }));
    } catch (warehouseResolveErr) {
      if (warehouseResolveErr.clientPayload) {
        throwOrderCreateFromGenericFailure(
          warehouseResolveErr.clientPayload,
          "No warehouse with sufficient stock for order line",
        );
      }
      throw warehouseResolveErr;
    }

    for (const whChange of stockChanges) {
      productStockUpdates.push(whChange);
    }

    for (const alloc of allocations) {
      const allocQty = Number(alloc.quantity);
      const totalCostMovement = Math.round(allocQty * unitCost * 100) / 100;
      const bodyBeforeInventoryMovement = req.body;
      const hadRouteParamId = Object.prototype.hasOwnProperty.call(
        req.params,
        "id",
      );
      const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

      req.body = {
        product_id: productIdStr,
        warehouse_id: alloc.warehouse_id,
        quantity: allocQty,
        movement_type: "out",
        unit_cost: unitCost,
        total_cost: totalCostMovement,
        reference_type: "order",
        reference_id: orderId,
        reference_name: "Order",
        company_id: companyIdOid || companyId,
        status: "active",
      };

      try {
        await insertInventoryMovementRecord(req, mongoSession);
      } catch (inventoryMovementErr) {
        if (inventoryMovementErr.clientPayload) {
          throwOrderCreateFromGenericFailure(
            inventoryMovementErr.clientPayload,
            "Inventory movement for order failed",
          );
        }
        throw inventoryMovementErr;
      } finally {
        req.body = bodyBeforeInventoryMovement;
        if (hadRouteParamId) {
          req.params.id = savedRouteParamId;
        } else {
          delete req.params.id;
        }
      }
    }

    const onHandAfterOutbound = await sumWarehouseInventoryQtyForProduct(
      productIdStr,
      companyIdOid || companyId,
      mongoSession,
    );
    const alertResult = await evaluateProductStockAlert({
      req,
      productId: productIdStr,
      companyId: companyIdOid || companyId,
      onHand: onHandAfterOutbound,
      pathQty: onHandAfterOutbound,
      session: mongoSession,
      logUrl,
    });
    if (!alertResult.success) {
      throw new Error(
        alertResult.message ||
          alertResult.error ||
          "Product stock alert check failed",
      );
    }
  }

  return productStockUpdates;
}

/**
 * Delete / void order: restore warehouse qty and insert reversal `in` movements from prior `out` snapshot.
 */
async function applyOrderDeleteInventoryRestore({
  oldOutMovements,
  existingOrderItems,
  orderId,
  companyId,
  companyIdOid,
  req,
  mongoSession = null,
  logUrl = "/api/order/order_delete",
}) {
  const oldMap = buildOutboundQtyMapFromMovements(oldOutMovements);

  if (oldMap.size === 0 && (existingOrderItems || []).length > 0) {
    const defaultWarehouseId = resolveDefaultWarehouseId(req);
    for (const item of existingOrderItems) {
      const pid = item.product_id != null ? String(item.product_id).trim() : "";
      const qty = Number(item.qty);
      if (
        !pid ||
        !mongoose.Types.ObjectId.isValid(pid) ||
        !Number.isFinite(qty) ||
        qty <= 0
      ) {
        continue;
      }
      const wid =
        findPriorWarehouseForProduct(oldMap, pid) ||
        ((
          defaultWarehouseId &&
          mongoose.Types.ObjectId.isValid(defaultWarehouseId)
        ) ?
          String(defaultWarehouseId).trim()
        : null);
      if (!wid) continue;
      const key = warehouseStockKey(pid, wid);
      oldMap.set(key, roundMoney2((oldMap.get(key) || 0) + qty));
    }
  }

  const priceByProduct = new Map();
  for (const item of existingOrderItems || []) {
    const pid = item.product_id != null ? String(item.product_id).trim() : "";
    if (!pid || priceByProduct.has(pid)) continue;
    const p = Number(item.price);
    if (Number.isFinite(p) && p >= 0) {
      priceByProduct.set(pid, p);
    }
  }

  const productStockUpdates = [];
  let reversalMovementsInserted = 0;

  for (const [key, lineQtyNum] of oldMap.entries()) {
    const [productIdStr, warehouseIdStr] = key.split(":");
    const unitCost = Number(priceByProduct.get(productIdStr));
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error(
        `Each order line needs a finite unit price (price) for inventory reversal (product ${productIdStr})`,
      );
    }

    try {
      const whChange = await WarehouseInventory.applyQuantityDelta({
        productId: productIdStr,
        warehouseId: warehouseIdStr,
        companyId: companyIdOid || companyId,
        qtyDelta: lineQtyNum,
        userId: req.user?._id,
        session: mongoSession,
      });
      if (whChange) {
        productStockUpdates.push({
          ...whChange,
          source: "warehouse_inventory",
          qty_delta_reason: "order_delete_restore",
        });
      }
    } catch (whErr) {
      const whMsg = String(
        whErr?.message || "Warehouse inventory restore failed",
      );
      const mapped = new Error(whMsg);
      mapped.clientErrorPayload = {
        success: false,
        status: 400,
        error: "Warehouse inventory restore failed",
        message: whMsg,
        details: whMsg,
        type: "validation",
        product_id: productIdStr,
        warehouse_id: warehouseIdStr,
        qty_restore: lineQtyNum,
      };
      throw mapped;
    }

    const totalCostMovement = Math.round(lineQtyNum * unitCost * 100) / 100;
    const bodyBeforeInventoryMovement = req.body;
    const hadRouteParamId = Object.prototype.hasOwnProperty.call(
      req.params,
      "id",
    );
    const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

    req.body = {
      product_id: productIdStr,
      warehouse_id: warehouseIdStr,
      quantity: lineQtyNum,
      movement_type: "in",
      unit_cost: unitCost,
      total_cost: totalCostMovement,
      reference_type: "order",
      reference_id: orderId,
      reference_name: "Order Delete",
      company_id: companyIdOid || companyId,
      status: "active",
    };

    try {
      await insertInventoryMovementRecord(req, mongoSession);
      reversalMovementsInserted += 1;
    } catch (inventoryMovementErr) {
      if (inventoryMovementErr.clientPayload) {
        throwOrderCreateFromGenericFailure(
          inventoryMovementErr.clientPayload,
          "Inventory movement reversal for order delete failed",
        );
      }
      throw inventoryMovementErr;
    } finally {
      req.body = bodyBeforeInventoryMovement;
      if (hadRouteParamId) {
        req.params.id = savedRouteParamId;
      } else {
        delete req.params.id;
      }
    }

    const onHandAfter = await sumWarehouseInventoryQtyForProduct(
      productIdStr,
      companyIdOid || companyId,
      mongoSession,
    );
    const alertResult = await evaluateProductStockAlert({
      req,
      productId: productIdStr,
      companyId: companyIdOid || companyId,
      onHand: onHandAfter,
      pathQty: onHandAfter,
      session: mongoSession,
      logUrl,
    });
    if (!alertResult.success) {
      throw new Error(
        alertResult.message ||
          alertResult.error ||
          "Product stock alert check failed",
      );
    }
  }

  return { productStockUpdates, reversalMovementsInserted };
}

function normalizeOrderNumericFields(obj) {
  const out = { ...obj };
  for (const key of [
    "discount",
    "shipment",
    "lines_subtotal",
    "amount_received",
    "change_given",
  ]) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === "" || v === null || v === undefined) {
      delete out[key];
      continue;
    }
    const n = typeof v === "number" ? v : Number(String(v).trim());
    if (Number.isFinite(n)) out[key] = n;
    else delete out[key];
  }
  return out;
}

/** Unit cost snapshot for the line: `wholesale_price` from product at time of sale. */
function costPriceAtSaleFromProduct(product) {
  if (!product || typeof product !== "object") return 0;
  const wp = Number(product.wholesale_price);
  if (Number.isFinite(wp) && wp >= 0) {
    return Math.round(wp * 100) / 100;
  }
  return 0;
}

async function buildOrderItemDocuments(orderId, orderSnapshot, lines, req) {
  const orderObjectId =
    orderId instanceof mongoose.Types.ObjectId ?
      orderId
    : new mongoose.Types.ObjectId(String(orderId));
  const companyId =
    coalesceObjectId(orderSnapshot.company_id) ||
    coalesceObjectId(req.user?.company_id);
  const createdBy = req.user?._id;
  if (!createdBy) {
    return {
      error: {
        success: false,
        status: 401,
        error: "Authentication required",
        details: "created_by is required for order items",
        type: "unauthorized",
      },
    };
  }
  if (!companyId) {
    return {
      error: {
        success: false,
        status: 400,
        error: "company_id required",
        details: "Order or user must have company_id to create line items",
        type: "validation",
      },
    };
  }
  const productIds = [
    ...new Set(
      lines
        .map((l) => String(l.product_id ?? "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];
  const products =
    productIds.length === 0 ?
      []
    : await Product.find({ _id: { $in: productIds } })
        .select("product_name wholesale_price")
        .lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const docs = [];
  for (const line of lines) {
    const pid = String(line.product_id ?? "").trim();
    const product =
      mongoose.Types.ObjectId.isValid(pid) ? productById.get(pid) : null;
    const name =
      product && String(product.product_name || "").trim() ?
        String(product.product_name).trim()
      : "Item";
    const cost_price_at_sale = costPriceAtSaleFromProduct(product);

    docs.push({
      order_id: orderObjectId,
      product_id: pid,
      name,
      qty: String(line.qtyRaw ?? line.qty).trim(),
      price: Number(line.price),
      subtotal: Number(line.subtotal),
      cost_price_at_sale,
      profit: Number(line.subtotal) - Number(cost_price_at_sale * line.qty),
      company_id: companyId,
      branch_id: coalesceObjectId(orderSnapshot.branch_id) || undefined,
      created_by: createdBy,
      status: "active",
      deletedAt: null,
    });
  }
  return { docs };
}

function shapeOrderWithItems(orderPlain, items) {
  const order_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);
  return {
    ...orderPlain,
    order_items: items,
    no_of_items: items.length,
    order_items_total,
  };
}

/** Unique product ObjectId strings from order line rows or `built.docs`. */
function collectUniqueProductIdsFromLineRows(rows) {
  const seen = new Set();
  const ids = [];
  for (const row of rows || []) {
    const id = coalesceObjectId(row?.product_id);
    const str = id != null ? String(id) : "";
    if (str && mongoose.Types.ObjectId.isValid(str) && !seen.has(str)) {
      seen.add(str);
      ids.push(str);
    }
  }
  return ids;
}

/**
 * Read `product.stock`, subtract sold qty, persist on `product` (before outbound movement).
 * @param {{ productId: unknown, lineQty: unknown, companyId: unknown, req?: import("express").Request, mongoSession?: object | null }} params
 */
async function decrementProductStockForOrderLine({
  productId,
  lineQty,
  companyId,
  req = null,
  mongoSession = null,
}) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !mongoose.Types.ObjectId.isValid(String(pid))) {
    throw new Error("Valid product_id is required to update product stock");
  }
  if (!cid || !mongoose.Types.ObjectId.isValid(String(cid))) {
    throw new Error("company_id is required to update product stock");
  }

  const qtyToRemove = Number(lineQty);
  if (!Number.isFinite(qtyToRemove) || qtyToRemove <= 0) {
    throw new Error(
      "Each order line needs a positive quantity to update product stock",
    );
  }

  let productQuery = Product.findOne({
    _id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  }).select("stock product_name");
  if (mongoSession) {
    productQuery = productQuery.session(mongoSession);
  }
  const productDoc = await productQuery.lean();
  if (!productDoc) {
    throw new Error(`Product not found for stock update (id ${String(pid)})`);
  }

  const previousStock = Number(productDoc.stock) || 0;
  if (previousStock < qtyToRemove) {
    const msg = `Insufficient product stock: need ${qtyToRemove}, available ${previousStock}`;
    const err = new Error(msg);
    err.statusCode = 400;
    err.clientErrorPayload = {
      success: false,
      status: 400,
      error: "Insufficient product stock",
      message: msg,
      details: msg,
      type: "validation",
      product_id: String(pid),
      previous_stock: previousStock,
      qty_needed: qtyToRemove,
    };
    throw err;
  }

  const nextStock = Math.round((previousStock - qtyToRemove) * 100) / 100;
  const updateOpts = mongoSession ? { session: mongoSession } : {};
  const updated = await Product.findOneAndUpdate(
    { _id: pid, company_id: cid, status: "active", deletedAt: null },
    { $set: { stock: nextStock } },
    { new: true, ...updateOpts },
  ).lean();

  if (!updated) {
    throw new Error(`Failed to update product stock (id ${String(pid)})`);
  }

  const productName =
    productDoc.product_name != null ?
      String(productDoc.product_name).trim()
    : "";
  const nameLabel = productName || `id ${String(pid)}`;
  const description =
    `Product "${nameLabel}" stock updated from ${previousStock} to ${nextStock} ` +
    `(${qtyToRemove} qty sold on order).`;

  if (req) {
    await createApplicationLog(
      req,
      {
        action: "Product stock updated (order)",
        url: req.originalUrl || req.path || "/api/order/order_save",
        tags: ["product", "stock", "order", "sale"],
        description: {
          product_id: String(pid),
          product_name: productName || null,
          qty_sold: qtyToRemove,
          previous_stock: previousStock,
          stock: nextStock,
          message: description,
        },
        reference_id: pid,
        reference_type: "product",
        company_id: cid,
      },
      { session: mongoSession, silent: true },
    );
  }

  return {
    product_id: pid,
    product_name: productDoc.product_name,
    previous_stock: previousStock,
    stock: nextStock,
    qty_removed: qtyToRemove,
  };
}

/** Default reporting window when GET /order/profit-by-order-item omits `from` and `to`. */
const FIND_PROFIT_DEFAULT_RANGE_DAYS = 90;

/**
 * GET `SUM(profit)` from `order_item` for the authenticated user's `company_id` only.
 * Includes lines that have a matching `inventory_movements` row with `movement_type: "out"`.
 * Query: `order_id`, `product_id`, optional `from` / `to` on line `createdAt`.
 * If both dates are omitted, only the last {@link FIND_PROFIT_DEFAULT_RANGE_DAYS} days are included.
 */
async function findProfitByOrderItem(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawOrderId = req.query?.order_id ?? req.params?.order_id;
    if (rawOrderId != null && String(rawOrderId).trim() !== "") {
      const orderIdStr = String(rawOrderId).trim();
      if (!mongoose.Types.ObjectId.isValid(orderIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid order_id",
        });
      }
      match.order_id = new mongoose.Types.ObjectId(orderIdStr);
    }

    const rawProductId = req.query?.product_id;
    if (rawProductId != null && String(rawProductId).trim() !== "") {
      const productIdStr = String(rawProductId).trim();
      if (!mongoose.Types.ObjectId.isValid(productIdStr)) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Invalid product_id",
        });
      }
      match.product_id = new mongoose.Types.ObjectId(productIdStr);
    }

    const hasFrom =
      req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";

    if (!hasFrom && !hasTo) {
      const toDate = new Date();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - FIND_PROFIT_DEFAULT_RANGE_DAYS);
      match.createdAt = { $gte: fromDate, $lte: toDate };
    } else {
      match.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(req.query.from).trim());
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid from date",
          });
        }
        match.createdAt.$gte = fromDate;
      }
      if (hasTo) {
        const toDate = new Date(String(req.query.to).trim());
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid to date",
          });
        }
        match.createdAt.$lte = toDate;
      }
    }

    /*
     * Correlated $lookup per order line — correct for stock-out proof but O(lines) subqueries
     * at scale; prefer denormalized line fields (e.g. cost_price_at_sale, profit) when
     * business rules allow. Subpipeline is tenant-scoped via $$companyId in $expr.
     */
    const rows = await OrderItem.aggregate([
      { $match: match },
      {
        $lookup: {
          from: "inventory_movements",
          let: {
            orderId: "$order_id",
            productId: "$product_id",
            companyId: "$company_id",
          },
          pipeline: [
            {
              $match: {
                status: "active",
                $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
              },
            },
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$company_id", "$$companyId"] },
                    { $eq: ["$product_id", "$$productId"] },
                    { $eq: ["$reference_id", "$$orderId"] },
                    { $eq: ["$reference_type", "order"] },
                    {
                      $eq: [
                        { $toLower: { $ifNull: ["$movement_type", ""] } },
                        "out",
                      ],
                    },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "out_movements",
        },
      },
      { $match: { "out_movements.0": { $exists: true } } },
      /*
       * Scalar $group only — do not $push line _id values (MongoDB 16MB aggregation output
       * cap; multi-tenant line volume can exceed BSON limits). Use paginated OrderItem.find
       * if clients need id lists.
       */
      {
        $group: {
          _id: null,
          profit: { $sum: { $ifNull: ["$profit", 0] } },
          line_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          profit: { $round: ["$profit", 2] },
          line_count: 1,
        },
      },
    ]);

    const profit = rows[0]?.profit ?? 0;
    const line_count = rows[0]?.line_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      profit,
      line_count,
    });
  } catch (error) {
    console.error("❌ findProfitByOrderItem:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/** Default reporting window when GET /order/sales omits `from` and `to` (multi-tenant safety). */
const FIND_SALES_DEFAULT_RANGE_DAYS = 365;

/** Max inclusive span for GET /order/sales-day-wise (`from`–`to`). */
const SALES_DAYWISE_MAX_RANGE_DAYS = 366;

/**
 * GET sum of `total_amount` from `order` for the authenticated user's `company_id` only.
 * Query: `order_status`, optional `from` / `to` on `createdAt`.
 * If both dates are omitted, only the last {@link FIND_SALES_DEFAULT_RANGE_DAYS} days are included.
 */
async function findSales(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawOrderStatus = req.query?.order_status;
    if (rawOrderStatus != null && String(rawOrderStatus).trim() !== "") {
      match.order_status = String(rawOrderStatus).trim();
    }

    const hasFrom =
      req.query?.from != null && String(req.query.from).trim() !== "";
    const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";

    if (!hasFrom && !hasTo) {
      const toDate = new Date();
      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - FIND_SALES_DEFAULT_RANGE_DAYS);
      match.createdAt = { $gte: fromDate, $lte: toDate };
    } else {
      match.createdAt = {};
      if (hasFrom) {
        const fromDate = new Date(String(req.query.from).trim());
        if (Number.isNaN(fromDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid from date",
          });
        }
        match.createdAt.$gte = fromDate;
      }
      if (hasTo) {
        const toDate = new Date(String(req.query.to).trim());
        if (Number.isNaN(toDate.getTime())) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Invalid to date",
          });
        }
        match.createdAt.$lte = toDate;
      }
    }

    /*
     * Summary-only $group (scalars). Do not $push order _id values: MongoDB caps each
     * aggregation result document at 16MB BSON; large tenants would fail or OOM when
     * every matching _id is accumulated in one array. Use paginated Order.find() if
     * clients need id lists.
     */
    const rows = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
          order_count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          total_amount: { $round: ["$total_amount", 2] },
          order_count: 1,
        },
      },
    ]);

    const total_amount = rows[0]?.total_amount ?? 0;
    const order_count = rows[0]?.order_count ?? 0;

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      total_amount,
      order_count,
    });
  } catch (error) {
    console.error("❌ findSales:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}
// async function orderCreate(req, res) {
//   const response = await handleGenericCreate(req, "order", {
//     afterCreate: async (record, req) => {
//       console.log("✅ Record created successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

async function getOrderByorderItem(req, res) {
  const filter = {
    status: "active",
    deletedAt: null,
    company_id: req.user?.company_id,
  };
  const response = await handleGenericGetAll(req, "order", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status).json(response);
  }

  const orderIds = response.data.map((o) => o._id).filter(Boolean);
  if (orderIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    order_id: { $in: orderIds },
    status: "active",
    deletedAt: null,
  };
  const items = await OrderItem.find(itemFilter)
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsByOrderId = new Map();
  for (const id of orderIds) {
    itemsByOrderId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.order_id);
    if (!itemsByOrderId.has(key)) {
      itemsByOrderId.set(key, []);
    }
    itemsByOrderId.get(key).push(item);
  }

  const data = response.data.map((order) => {
    const order_items = itemsByOrderId.get(String(order._id)) || [];
    const order_items_total = order_items.reduce((sum, item) => {
      const sub = Number(item.subtotal);
      return sum + (Number.isFinite(sub) ? sub : 0);
    }, 0);
    return {
      ...order,
      order_items,
      no_of_items: order_items.length,
      order_items_total,
    };
  });

  return res.status(response.status).json({
    ...response,
    data,
  });
}

/**
 * POST /api/order/order_save — create order, GL, line items, outbound inventory, header sync.
 *
 * Flow: (1) pre-txn prep + line validation, (2–6) txn body (order → GL → items → stock/movements → header sync),
 * (7) Mongo transaction wrapper (standalone retry without session), (8) failure logs, (9) success response reload.
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** | **medium** | **high** (ledger aggregate / movement scan).
 *
 * | Step | When              | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | Pre-txn           | —                       | —                  | —            | low    | `parseOrderLineItems`, normalize header, `lines_subtotal`, `transaction_number` |
 * |    2 | In txn            | order                   | insert             | one          | low    | `handleGenericCreate` (model assigns `order_no` when missing) |
 * |    3 | In txn            | transaction             | insert             | many (4)     | medium | `transactionBulkCreate` in `afterCreate` — sales, shipping, discount, payment |
 * |    4 | In txn            | order_item              | insert             | many (L)     | medium | `buildOrderItemDocuments` + `insertMany` |
 * |    5 | In txn            | warehouse_inventory, inventory_movements, logs | read / update / insert | one × L | medium | Per line: resolve warehouse, outbound `warehouse_inventory`, `insertInventoryMovementRecord` (`out`), stock alert |
 * |    6 | In txn            | order                   | update             | one          | low    | `Order.syncHeaderTotalsFromLineItems` |
 * |    7 | Txn wrap          | —                       | —                  | —            | low    | `withTransaction` or standalone retry (`mongoTransactionSupport`) |
 * |    8 | On failure        | logs                    | insert             | one          | low    | `logRollbackFailure` (`ORDER CREATE ROLLBACK`) |
 * |    9 | Post-txn success  | order                   | read               | one          | low    | `findById` + `shapeOrderWithItems` for 201 response |
 *
 * L = line count. Requires at least one valid line (step 1 validation).
 */
async function order_save(req, res) {
  // step 1 start — parse lines + normalize header for `handleGenericCreate`
  const lines = parseOrderLineItems(req.body);
  if (lines.length === 0) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Order lines required",
      details:
        "Send at least one valid line with product_id[n], qty[n], and price[n] (e.g. product_id[0], qty[0], price[0]). Optional warehouse_id[n] per line; when omitted, the company default warehouse is used for stock (out).",
      type: "validation",
    });
  }

  const originalBody = req.body;
  req.body = normalizeOrderNumericFields(stripLineItemKeys(originalBody));
  delete req.body._id;
  // Unique per company (partial index). Model pre-save assigns next `ORD-####` when absent.
  delete req.body.order_no;
  req.body.lines_subtotal = sumParsedLinesSubtotal(lines);

  const transaction_number = generateTransactionNumber();
  req.body.payment_method_accounts_id = req.body?.posPayMethod;
  req.body.transaction_number = transaction_number;
  // step 1 end

  // Outer state survives txn attempt / standalone retry (see `orderSaveExecutionMode` in rollback logs).
  let mongooseClientSession = null;
  let response = null;
  let insertedItemsPlain = [];
  /** Per-line `warehouse_inventory` outbound audit (API `product_stock_updates`). */
  let productStockUpdates = [];
  let txnError = null;
  /** How `runOrderSaveBody` last ran; drives rollback/log diagnosis. */
  let orderSaveExecutionMode = "pending";

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runOrderSaveBody = async (mongoSession) => {
    insertedItemsPlain = [];
    productStockUpdates = [];
    const lineItemSessionOpts = mongoSession ? { session: mongoSession } : {};
    orderSaveExecutionMode =
      mongoSession ? "mongodb_transaction" : "no_session";

    // step 2 start — order insert
    response = await handleGenericCreate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, orderReq, sess) => {
        // step 3 start — transaction insert ×4 (GL)
        const orderTotal = Number(
          lines
            .reduce(
              (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
              0,
            )
            .toFixed(2),
        );

        // Four ledger lines; amounts come from the saved order + line subtotal sum. Same `transaction_number` on all.
        const { created, failed } = await transactionBulkCreate(
          orderReq,
          [
            {
              account_id: orderReq.user.company_id.default_sales_account,
              type: "credit",
              amount: orderTotal,
              reference_user_id: record?.customer_id,
              transaction_number,
              description: "Sale Order",
              reference_id: {
                module: "order",
                ref_id: record._id,
              },
            },
            {
              account_id: orderReq.user.company_id.default_shipping_account,
              type: "credit",
              amount: record?.shipment,
              reference_user_id: record?.customer_id,
              transaction_number,
              description: "Sale Order",
              reference_id: {
                module: "order",
                ref_id: record._id,
              },
            },
            {
              account_id:
                orderReq.user.company_id.default_sales_discount_account,
              type: "debit",
              amount: record?.discount,
              reference_user_id: record?.customer_id,
              transaction_number,
              description: "Sale Discount",
              reference_id: {
                module: "order",
                ref_id: record._id,
              },
            },
            {
              // Debit cash/bank (or payment method account); `posPayMethod` is the account id on the incoming body.
              account_id: orderReq.body?.posPayMethod,
              type: "debit",
              amount: record?.amount_received,
              reference_user_id: record?.customer_id,
              transaction_number,
              description: "Mode of Payment",
              reference_id: {
                module: "order",
                ref_id: record._id,
              },
            },
          ],
          { stopOnError: true, session: sess },
        );
        if (failed.length) {
          const msg = `Post-order transaction bulk insert failed: ${JSON.stringify(
            failed,
          )}`;
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(req, msg, ORDER_TRANSACTION_ERROR_LOG);
          const glErr = new Error(msg);
          glErr.statusCode = 400;
          glErr.responseType = "transaction_bulk";
          glErr.details = failed;
          throw glErr;
        }
        if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
        // step 3 end
      },
    });
    // step 2 end

    if (!response?.success || !response?.data) {
      throwOrderCreateFromGenericFailure(response, "Order create failed");
    }

    const orderId = response.data._id;

    // step 4 start — order_item insertMany
    const built = await buildOrderItemDocuments(
      orderId,
      response.data,
      lines,
      req,
    );
    if (built.error) {
      throw new Error(JSON.stringify(built.error));
    }

    const inserted = await OrderItem.insertMany(
      built.docs,
      lineItemSessionOpts,
    );
    insertedItemsPlain = inserted.map((d) => d.toObject({ flattenMaps: true }));
    // step 4 end

    // step 5 start — per line: warehouse_inventory outbound + inventory_movements insert (`out`)
    const companyIdForMovement =
      coalesceObjectId(response.data.company_id) ||
      coalesceObjectId(req.user?.company_id);
    const companyIdForMovementOid =
      (
        companyIdForMovement &&
        mongoose.Types.ObjectId.isValid(String(companyIdForMovement))
      ) ?
        new mongoose.Types.ObjectId(String(companyIdForMovement))
      : null;

    const outboundAudit = await applyOrderOutboundLines({
      lines,
      orderId: response.data._id,
      companyId: companyIdForMovement,
      companyIdOid: companyIdForMovementOid,
      req,
      mongoSession,
      logUrl: req.originalUrl || req.path || "/api/order/order_save",
    });
    productStockUpdates.push(...outboundAudit);
    // step 5 end

    // step 6 start — order header sync from line items
    await Order.syncHeaderTotalsFromLineItems(orderId, lineItemSessionOpts);
    // step 6 end
  };

  // step 7 start — MongoDB transaction wrapper (or standalone retry)
  try {
    mongooseClientSession = await mongoose.startSession();
    await mongooseClientSession.withTransaction(async () => {
      await runOrderSaveBody(mongooseClientSession);
    });
    orderSaveExecutionMode = "mongodb_transaction_committed";
  } catch (mongoTransactionError) {
    if (isMongoTransactionUnsupportedError(mongoTransactionError)) {
      if (mongooseClientSession) {
        try {
          mongooseClientSession.endSession();
        } catch (_) {
          /* ignore */
        }
        mongooseClientSession = null;
      }
      console.warn(
        "[order_save] MongoDB transactions unavailable (e.g. standalone mongod); continuing without session",
      );
      try {
        response = null;
        insertedItemsPlain = [];
        productStockUpdates = [];
        orderSaveExecutionMode = "standalone_no_transaction_retry";
        await runOrderSaveBody(null);
      } catch (nonSessionRetryError) {
        txnError = nonSessionRetryError;
        const errName = nonSessionRetryError?.name || "Error";
        const errMsg =
          nonSessionRetryError?.message != null ?
            String(nonSessionRetryError.message)
          : String(nonSessionRetryError);
        console.error(
          "[order_save] non-session retry failed —",
          errName + ":",
          errMsg,
        );
        try {
          console.error(
            "[order_save] serialized:",
            serializeErrorForLog(nonSessionRetryError),
          );
        } catch (serializeErr) {
          console.error(
            "[order_save] serializeErrorForLog failed:",
            serializeErr,
          );
        }
        if (nonSessionRetryError?.stack) {
          console.error("[order_save] stack:\n", nonSessionRetryError.stack);
        }
      }
    } else {
      txnError = mongoTransactionError;
      orderSaveExecutionMode = "mongodb_transaction_aborted";
      const errName = mongoTransactionError?.name || "Error";
      const errMsg =
        mongoTransactionError?.message != null ?
          String(mongoTransactionError.message)
        : String(mongoTransactionError);
      console.error(
        "[order_save] withTransaction failed —",
        errName + ":",
        errMsg,
      );
      try {
        console.error(
          "[order_save] serialized:",
          serializeErrorForLog(mongoTransactionError),
        );
      } catch (serializeErr) {
        console.error(
          "[order_save] serializeErrorForLog failed:",
          serializeErr,
        );
      }
      if (mongoTransactionError?.stack) {
        console.error("[order_save] stack:\n", mongoTransactionError.stack);
      }
    }
  } finally {
    if (mongooseClientSession) {
      try {
        mongooseClientSession.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  // step 7 end

  req.body = originalBody;

  // step 8 start — failure path (`logs` + client JSON)
  if (txnError) {
    console.error(
      "[order_save] failure (serializeErrorForLog):\n",
      serializeErrorForLog(txnError),
    );

    const bodyForLog =
      originalBody && typeof originalBody === "object" ? originalBody : {};
    const firstLine = lines[0] || {};
    await logRollbackFailure(req, txnError, {
      action: "ORDER CREATE ROLLBACK",
      tags: ["api", "order", "rollback", "create"],
      fallbackUrl: "/api/order/order_save",
      context: {
        execution_mode: orderSaveExecutionMode,
        rollback_note:
          (
            orderSaveExecutionMode === "mongodb_transaction_aborted" ||
            orderSaveExecutionMode === "mongodb_transaction"
          ) ?
            "MongoDB multi-document transaction aborted; no partial commit from this attempt."
          : orderSaveExecutionMode === "mongodb_transaction_committed" ?
            "Transaction committed but a later step failed (unexpected)."
          : "Standalone / no transaction: partial writes may exist if a step failed mid-flow; check order_item and transactions for orphans.",
        transaction_number,
        line_count: lines.length,
        customer_id:
          coalesceObjectId(bodyForLog.customer_id) ?? bodyForLog.customer_id,
        amount_received: bodyForLog.amount_received,
        posPayMethod:
          coalesceObjectId(bodyForLog.posPayMethod) ?? bodyForLog.posPayMethod,
        payment_method_id:
          coalesceObjectId(bodyForLog.payment_method_id) ??
          bodyForLog.payment_method_id,
        company_id:
          coalesceObjectId(req.user?.company_id) ?? req.user?.company_id,
        first_line_product_id: firstLine.product_id,
        first_line_qty: firstLine.qty,
        partial_order_id:
          response?.data?._id ? String(response.data._id) : null,
        api_client_error: txnError.clientErrorPayload ?? null,
        gl_or_bulk_details: txnError.details ?? null,
        error_message: String(txnError.message || ""),
      },
    });
    if (
      txnError.clientErrorPayload &&
      typeof txnError.clientErrorPayload === "object"
    ) {
      const p = txnError.clientErrorPayload;
      return res.status(Number(p.status) || 400).json(p);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(txnError.message);
    } catch (_) {
      /* not JSON */
    }
    // Inner throws may use `throw new Error(JSON.stringify({ status, ... }))` to pass through a full API payload.
    if (parsed && typeof parsed === "object" && parsed.status) {
      return res.status(parsed.status).json(parsed);
    }
    const msg = String(txnError.message || "");
    // GL bulk path prefixes the message with `Post-order transaction bulk insert failed`.
    const isGl = msg.includes("Post-order");
    const isBulk = txnError.responseType === "transaction_bulk";
    return res.status(isGl || isBulk ? 400 : 500).json({
      success: false,
      status: isGl || isBulk ? 400 : 500,
      error:
        isGl || isBulk ?
          "Order creation rolled back"
        : "Failed to create order",
      message: txnError.message,
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || (isGl ? "transaction_bulk" : "internal"),
    });
  }
  // step 8 end (failure)

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  // step 9 start — order read (response reload)
  const orderId = response.data._id;
  const orderFresh = await Order.findById(orderId).lean();
  const data = shapeOrderWithItems(
    orderFresh || response.data,
    insertedItemsPlain,
  );
  return res.status(201).json({
    success: true,
    status: 201,
    data,
    product_stock_updates: productStockUpdates,
  });
  // step 9 end — 201 response
}

/**
 * PUT/PATCH order — header update, GL rebuild, optional full line replace + warehouse inventory replay.
 *
 * Flow — **line replace** (steps 1–11, 13–16): prep → order update → teardown → GL rebuild → new lines + outbound.
 * **Header-only** (steps 1–3, 12, 13–16): prep → order update + GL soft-delete/rebuild in `afterUpdate` → header sync.
 *
 * Does not update `product.stock`; uses `warehouse_inventory` + `insertInventoryMovementRecord` (same as `order_save`).
 *
 * Collections (Mongo) — op = insert | update | delete | read; scope = one | many
 * Cost (relative): **low** | **medium** | **high** (movement scan on restore).
 *
 * | Step | When              | Collection              | Op                 | One or many  | Cost   | Notes |
 * |------|-------------------|-------------------------|--------------------|--------------|--------|-------|
 * |    1 | Pre-txn           | order_item              | read               | many         | low    | `parseOrderLineItems`, normalize header, `lines_subtotal` (body or DB items) |
 * |    2 | In txn — always   | order                   | update             | one          | low    | `handleGenericUpdate` |
 * |    3 | In txn — header-only | transaction          | update + insert    | many (4)     | medium | In `afterUpdate`: `softDeleteActiveOrderRelatedRecords` (GL) + `rebuildOrderGlTransactions` |
 * |    4 | In txn — lines    | order_item              | —                  | —            | low    | `buildOrderItemDocuments` |
 * |    5 | In txn — lines    | order_item              | read               | many         | low    | Snapshot existing lines before teardown |
 * |    6 | In txn — lines    | transaction, inventory_movements, order_item | read / delete | many | medium | `teardownOrderForLineReplace` — snapshot movements + `softDeleteActiveOrderRelatedRecords` |
 * |    7 | In txn — lines    | transaction             | insert             | many (4)     | medium | `rebuildOrderGlTransactions` (after teardown) |
 * |    8 | In txn — lines    | order_item              | insert             | many (L)     | medium | `insertMany` |
 * |    9 | In txn — lines    | order                   | update             | one          | low    | `syncHeaderTotalsFromLineItems` |
 * |   10 | In txn — lines    | warehouse_inventory, inventory_movements | read / update / insert | one × L | medium | `applyOrderLineReplaceInventory` — warehouse delta (old − new qty), movement insert |
 * |   11 | In txn — lines    | product, logs           | read               | one × P      | low    | Stock alerts for pro  ducts removed from cart |
 * |   12 | In txn — header-only | order                | update             | one          | low    | `syncHeaderTotalsFromLineItems` only |
 * |   13 | Txn wrap          | —                       | —                  | —            | low    | `withTransaction` or standalone retry |
 * |   14 | On failure        | logs                    | insert             | one          | low    | `logRollbackFailure` (`ORDER UPDATE ROLLBACK`) |
 * |   15 | Post-txn success  | order_item              | read               | many         | medium | Populate for response `data` |
 * |   16 | Post-txn success  | order                   | read               | one          | low    | Reload header for response |
 *
 * L = line count; P = products only on old lines; R = prior `out` movement rows restored.
 */
async function order_update(req, res) {
  // step 1 start — parse lines + normalize header for `handleGenericUpdate`
  const lines = parseOrderLineItems(req.body);
  const originalBody = req.body;
  req.body = normalizeOrderNumericFields(stripLineItemKeys(originalBody));
  delete req.body._id;

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    req.body.lines_subtotal = sumParsedLinesSubtotal(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    const items = await OrderItem.find({
      order_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal = roundMoney2(
      items.reduce((s, i) => s + (Number(i.subtotal) || 0), 0),
    );
  }
  // step 1 end

  /** GL bulk result from `afterUpdate` (exposed on success response). */
  const postUpdateTransactions = { created: [], failed: [] };

  let mongooseClientSession = null;
  let response = null;
  let txnError = null;
  let orderUpdateExecutionMode = "pending";
  /** Set when lines are replaced: product ids on old rows vs incoming `built.docs`. */
  let orderLineReplaceSnapshot = null;

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runOrderUpdateBody = async (mongoSession) => {
    const sessOpts = mongoSession ? { session: mongoSession } : {};
    orderUpdateExecutionMode =
      mongoSession ? "mongodb_transaction" : "no_session";

    // step 2 start — order update (header)
    response = await handleGenericUpdate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
        // Header-only: step 3 — line replace runs teardown + GL rebuild in the line block.
        if (lines.length === 0) {
          // step 3 start — GL soft-delete + insert ×4
          await softDeleteActiveOrderRelatedRecords({
            orderId: record._id,
            transactionNumber: record?.transaction_number,
            companyId: record?.company_id,
            mongoSession: sess,
            userId: orderReq.user?._id,
            options: { gl: true },
          });
          await rebuildOrderGlTransactions({
            record,
            orderReq,
            lines,
            mongoSession: sess,
            postUpdateTransactions,
          });
          // step 3 end
        }
      },
      filter: { status: "active", deletedAt: null },
    });
    // step 2 end

    if (!response?.success || !response?.data) {
      throwOrderCreateFromGenericFailure(response, "Order update failed");
    }

    const orderId = response.data._id;

    if (lines.length > 0) {
      // step 4 start — build order_item documents
      const built = await buildOrderItemDocuments(
        orderId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throwOrderCreateFromGenericFailure(
          built.error,
          "Order line build failed",
        );
      }
      // step 4 end

      // step 5 start — snapshot existing lines before replace
      let existingItemsQuery = OrderItem.find({
        order_id: orderId,
        status: "active",
        deletedAt: null,
      }).select("product_id qty price subtotal");
      if (mongoSession) {
        existingItemsQuery = existingItemsQuery.session(mongoSession);
      }
      const existingOrderItems = await existingItemsQuery.lean();

      const previous_product_ids =
        collectUniqueProductIdsFromLineRows(existingOrderItems);
      const new_product_ids = collectUniqueProductIdsFromLineRows(built.docs);
      // step 5 end

      const companyIdForStock =
        coalesceObjectId(response?.data?.company_id) ||
        coalesceObjectId(req.user?.company_id);
      const companyIdForStockOid =
        (
          companyIdForStock &&
          mongoose.Types.ObjectId.isValid(String(companyIdForStock))
        ) ?
          new mongoose.Types.ObjectId(String(companyIdForStock))
        : null;

      // step 6 start — teardown: snapshot movements + soft-delete GL, movements, line items
      const { oldOutMovements } = await teardownOrderForLineReplace({
        orderId,
        transactionNumber: response.data.transaction_number,
        companyId: companyIdForStock,
        mongoSession,
        userId: req.user?._id,
      });
      // step 6 end

      // step 7 start — transaction insert ×4 (GL rebuild after teardown)
      await rebuildOrderGlTransactions({
        record: response.data,
        orderReq: req,
        lines,
        mongoSession,
        postUpdateTransactions,
      });
      // step 7 end

      // step 8 start — order_item insertMany
      await OrderItem.insertMany(built.docs, sessOpts);
      // step 8 end

      // step 9 start — order header sync from line items
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);
      // step 9 end

      // step 10 start — warehouse delta (old − new qty) + inventory_movements insert
      const warehouseInventoryUpdates = await applyOrderLineReplaceInventory({
        oldOutMovements,
        existingOrderItems,
        newLines: lines,
        orderId,
        companyId: companyIdForStock,
        companyIdOid: companyIdForStockOid,
        req,
        mongoSession,
        logUrl: req.originalUrl || req.path || "/api/order/order_update",
      });
      // step 10 end

      // step 11 start — stock alerts for products only on old lines (removed from new cart)
      const productIdsOnlyOnOldLines = previous_product_ids.filter(
        (pid) => !new_product_ids.includes(pid),
      );
      for (const pid of productIdsOnlyOnOldLines) {
        const onHand = await sumWarehouseInventoryQtyForProduct(
          pid,
          companyIdForStock,
          mongoSession,
        );
        const alertResult = await evaluateProductStockAlert({
          req,
          productId: String(pid),
          companyId: companyIdForStock,
          onHand,
          pathQty: onHand,
          session: mongoSession,
          logUrl: req.originalUrl || req.path || "/api/order/order_update",
        });
        if (!alertResult.success) {
          throw new Error(
            alertResult.message ||
              alertResult.error ||
              "Product stock alert check failed",
          );
        }
      }
      // step 11 end

      orderLineReplaceSnapshot = {
        previous_product_ids,
        new_product_ids,
        prior_outbound_movements: oldOutMovements.length,
        warehouse_inventory_updates: warehouseInventoryUpdates,
      };
    } else {
      // step 12 start — header-only: sync totals from persisted lines
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);
      // step 12 end
    }
    // Header-only: steps 1–3 + 12; line replace: steps 4–11.
  };

  // step 13 start — MongoDB transaction wrapper (or standalone retry)
  try {
    mongooseClientSession = await mongoose.startSession();
    await mongooseClientSession.withTransaction(async () => {
      await runOrderUpdateBody(mongooseClientSession);
    });
    orderUpdateExecutionMode = "mongodb_transaction_committed";
  } catch (mongoTransactionError) {
    // Same standalone retry pattern as `order_save`.
    if (isMongoTransactionUnsupportedError(mongoTransactionError)) {
      if (mongooseClientSession) {
        try {
          mongooseClientSession.endSession();
        } catch (_) {
          /* ignore */
        }
        mongooseClientSession = null;
      }
      console.warn(
        "[order_update] MongoDB transactions unavailable (e.g. standalone mongod); continuing without session",
      );
      try {
        response = null;
        postUpdateTransactions.created = [];
        postUpdateTransactions.failed = [];
        orderUpdateExecutionMode = "standalone_no_transaction_retry";
        await runOrderUpdateBody(null);
      } catch (nonSessionRetryError) {
        txnError = nonSessionRetryError;
        console.error(
          "[order_update] non-session retry failed:\n",
          serializeErrorForLog(nonSessionRetryError),
        );
      }
    } else {
      txnError = mongoTransactionError;
      orderUpdateExecutionMode = "mongodb_transaction_aborted";
      console.error(
        "[order_update] withTransaction failed:\n",
        serializeErrorForLog(mongoTransactionError),
      );
    }
  } finally {
    if (mongooseClientSession) {
      try {
        mongooseClientSession.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  // step 13 end

  req.body = originalBody;

  // step 14 start — failure path (`logs` + client JSON)
  if (txnError) {
    console.error(
      "[order_update] failure (serializeErrorForLog):\n",
      serializeErrorForLog(txnError),
    );

    const bodyForLog =
      originalBody && typeof originalBody === "object" ? originalBody : {};
    const firstLine = lines[0] || {};
    await logRollbackFailure(req, txnError, {
      action: "ORDER UPDATE ROLLBACK",
      tags: ["api", "order", "rollback", "update"],
      fallbackUrl: `/api/order/order_update/${recordId}`,
      context: {
        execution_mode: orderUpdateExecutionMode,
        rollback_note:
          (
            orderUpdateExecutionMode === "mongodb_transaction_aborted" ||
            orderUpdateExecutionMode === "mongodb_transaction"
          ) ?
            "MongoDB multi-document transaction aborted; no partial commit from this attempt."
          : orderUpdateExecutionMode === "mongodb_transaction_committed" ?
            "Transaction committed but a later step failed (unexpected)."
          : "Standalone / no transaction: partial writes may exist if a step failed mid-flow; check order_item and transactions for orphans.",
        order_id: recordId,
        line_count: lines.length,
        customer_id:
          coalesceObjectId(bodyForLog.customer_id) ?? bodyForLog.customer_id,
        amount_received: bodyForLog.amount_received,
        posPayMethod:
          coalesceObjectId(bodyForLog.posPayMethod) ?? bodyForLog.posPayMethod,
        payment_method_id:
          coalesceObjectId(bodyForLog.payment_method_id) ??
          bodyForLog.payment_method_id,
        company_id:
          coalesceObjectId(req.user?.company_id) ?? req.user?.company_id,
        first_line_product_id: firstLine.product_id,
        first_line_qty: firstLine.qty,
        partial_order_id:
          response?.data?._id ? String(response.data._id) : recordId || null,
        api_client_error: txnError.clientErrorPayload ?? null,
        gl_or_bulk_details: txnError.details ?? null,
        error_message: String(txnError.message || ""),
      },
    });
    if (
      txnError.clientErrorPayload &&
      typeof txnError.clientErrorPayload === "object"
    ) {
      const p = txnError.clientErrorPayload;
      return res.status(Number(p.status) || 400).json(p);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(txnError.message);
    } catch (_) {
      /* not JSON */
    }
    if (parsed && typeof parsed === "object" && parsed.status) {
      return res.status(parsed.status).json(parsed);
    }
    const msg = String(txnError.message || "");
    const isGl = msg.includes("Post-order");
    const isBulk = txnError.responseType === "transaction_bulk";
    return res.status(isGl || isBulk ? 400 : 500).json({
      success: false,
      status: isGl || isBulk ? 400 : 500,
      error: "Order update rolled back",
      message: txnError.message,
      details: txnError.details ?? txnError.message,
      type: txnError.responseType || (isGl ? "transaction_bulk" : "internal"),
    });
  }
  // step 14 end (failure)

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const orderId = response.data._id;

  // step 15 start — order_item read (response)
  const items = await OrderItem.find({
    order_id: orderId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();
  // step 15 end

  // step 16 start — order read (response reload)
  const orderFresh = await Order.findById(orderId).lean();
  const data = shapeOrderWithItems(orderFresh || response.data, items);

  return res.status(200).json({
    success: true,
    status: 200,
    data,
    created: postUpdateTransactions.created,
    failed: postUpdateTransactions.failed,
    ...(orderLineReplaceSnapshot ?
      { line_replace: orderLineReplaceSnapshot }
    : {}),
  });
  // step 16 end — 200 response
}

async function getOrderByOrderNo(req, res) {
  const param = String(req.params.id || "").trim();
  if (!param) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Record ID is required",
      details: "Please provide id in the URL parameters",
      type: "missing_id",
    });
  }

  const filter = { status: "active", deletedAt: null };

  let order = await Order.findOne({ order_no: param, ...filter });
  if (!order && mongoose.Types.ObjectId.isValid(param)) {
    order = await Order.findOne({ _id: param, ...filter });
  }

  if (!order) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `order with order_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await OrderItem.find({
    order_id: order._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const order_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);

  const data = {
    ...order.toObject({ flattenMaps: true }),
    order_items: items,
    no_of_items: items.length,
    order_items_total,
  };

  return res.status(200).json({
    success: true,
    status: 200,
    data,
  });
}

async function invoiceUpdate(req, res) {
  const response = await handleGenericUpdate(req, "order", {
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

/** Inclusive start/end of a local calendar month (`month` = 0–11). */
function calendarMonthDateRange(year, month) {
  const fromDate = new Date(year, month, 1);
  const toDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
  return { fromDate, toDate, year, month: month + 1 };
}

function currentMonthDateRange(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  return calendarMonthDateRange(d.getFullYear(), d.getMonth());
}

function lastMonthDateRange(refDate = new Date()) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return calendarMonthDateRange(prev.getFullYear(), prev.getMonth());
}

const ORDER_SALES_SUMMARY_GROUP = [
  {
    $group: {
      _id: null,
      total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
      order_count: { $sum: 1 },
    },
  },
  {
    $project: {
      _id: 0,
      total_amount: { $round: ["$total_amount", 2] },
      order_count: 1,
    },
  },
];

function salesSummaryFromAggregateRows(rows) {
  const row = rows?.[0];
  return {
    total_amount: row?.total_amount ?? 0,
    order_count: row?.order_count ?? 0,
  };
}

function periodPayload(label, range) {
  return {
    label,
    year: range.year,
    month: range.month,
    from: range.fromDate.toISOString(),
    to: range.toDate.toISOString(),
  };
}

function formatLocalDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * @param {import("express").Request} req
 * @returns {{ fromDate: Date, toDate: Date, periodLabel: string } | { error: object }}
 */
function resolveOrderSalesDateRange(req) {
  const hasFrom =
    req.query?.from != null && String(req.query.from).trim() !== "";
  const hasTo = req.query?.to != null && String(req.query.to).trim() !== "";

  if (hasFrom || hasTo) {
    const fromDate = hasFrom ? new Date(String(req.query.from).trim()) : null;
    const toDate = hasTo ? new Date(String(req.query.to).trim()) : new Date();
    if (hasFrom && Number.isNaN(fromDate.getTime())) {
      return {
        error: {
          status: 400,
          body: { success: false, status: 400, error: "Invalid from date" },
        },
      };
    }
    if (hasTo && Number.isNaN(toDate.getTime())) {
      return {
        error: {
          status: 400,
          body: { success: false, status: 400, error: "Invalid to date" },
        },
      };
    }
    const rangeStart = startOfLocalDay(hasFrom ? fromDate : toDate);
    const rangeEnd = startOfLocalDay(toDate);
    if (rangeStart > rangeEnd) {
      return {
        error: {
          status: 400,
          body: {
            success: false,
            status: 400,
            error: "Invalid date range",
            message: "`from` must be on or before `to`",
          },
        },
      };
    }
    const spanDays =
      Math.floor((rangeEnd - rangeStart) / (24 * 60 * 60 * 1000)) + 1;
    if (spanDays > SALES_DAYWISE_MAX_RANGE_DAYS) {
      return {
        error: {
          status: 400,
          body: {
            success: false,
            status: 400,
            error: "Date range too large",
            message: `Maximum range is ${SALES_DAYWISE_MAX_RANGE_DAYS} days`,
          },
        },
      };
    }
    return {
      fromDate: hasFrom ? fromDate : rangeStart,
      toDate: hasTo ? toDate : new Date(rangeEnd.getTime() + 86400000 - 1),
      periodLabel: "custom",
    };
  }

  const period = String(req.query?.period || "current_month")
    .trim()
    .toLowerCase();
  if (period === "last_month") {
    const r = lastMonthDateRange();
    return {
      fromDate: r.fromDate,
      toDate: r.toDate,
      periodLabel: "last_month",
    };
  }
  const r = currentMonthDateRange();
  return {
    fromDate: r.fromDate,
    toDate: r.toDate,
    periodLabel: "current_month",
  };
}

/** Merge aggregation rows into every local calendar day (zeros for days with no orders). */
function buildDayWiseSalesSeries(fromDate, toDate, aggregatedRows) {
  const byDate = new Map(
    (aggregatedRows || []).map((row) => [
      String(row.date),
      {
        total_amount: Number(row.total_amount) || 0,
        order_count: Number(row.order_count) || 0,
      },
    ]),
  );

  const days = [];
  const cur = startOfLocalDay(fromDate);
  const end = startOfLocalDay(toDate);
  let total_amount = 0;
  let order_count = 0;

  while (cur <= end) {
    const key = formatLocalDateKey(cur);
    const row = byDate.get(key);
    const dayTotal = row?.total_amount ?? 0;
    const dayCount = row?.order_count ?? 0;
    total_amount += dayTotal;
    order_count += dayCount;
    days.push({
      date: key,
      total_amount: Math.round(dayTotal * 100) / 100,
      order_count: dayCount,
    });
    cur.setDate(cur.getDate() + 1);
  }

  return {
    days,
    summary: {
      total_amount: Math.round(total_amount * 100) / 100,
      order_count,
    },
  };
}

/**
 * GET daily sales totals for charts (`total_amount` + `order_count` per calendar day).
 * Query: optional `from` / `to`, or `period=current_month` (default) | `last_month`, optional `order_status`.
 * Response `days` includes every day in range (zero-filled) for graph axes.
 */
async function findSalesDayWise(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const rangeResolved = resolveOrderSalesDateRange(req);
    if (rangeResolved.error) {
      return res
        .status(rangeResolved.error.status)
        .json(rangeResolved.error.body);
    }

    const { fromDate, toDate, periodLabel } = rangeResolved;
    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const match = {
      company_id: cid,
      status: "active",
      deletedAt: null,
      createdAt: { $gte: fromDate, $lte: toDate },
    };

    const rawOrderStatus = req.query?.order_status;
    if (rawOrderStatus != null && String(rawOrderStatus).trim() !== "") {
      match.order_status = String(rawOrderStatus).trim();
    }

    const aggregatedRows = await Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
          order_count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          total_amount: { $round: ["$total_amount", 2] },
          order_count: 1,
        },
      },
    ]);

    const { days, summary } = buildDayWiseSalesSeries(
      fromDate,
      toDate,
      aggregatedRows,
    );

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      period: {
        label: periodLabel,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      },
      summary,
      days,
    });
  } catch (error) {
    console.error("findSalesDayWise:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * GET total sales (`SUM(order.total_amount)`) for the authenticated company:
 * **current calendar month** and **previous calendar month** (server local time).
 * Same tenant + status filters as `findSales`; optional `?order_status=`.
 */
async function findTotalSalesByOrder(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const currentRange = currentMonthDateRange();
    const lastRange = lastMonthDateRange();
    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const baseMatch = {
      company_id: cid,
      status: "active",
      deletedAt: null,
    };

    const rawOrderStatus = req.query?.order_status;
    if (rawOrderStatus != null && String(rawOrderStatus).trim() !== "") {
      baseMatch.order_status = String(rawOrderStatus).trim();
    }

    const [facetResult] = await Order.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          current_month: [
            {
              $match: {
                createdAt: {
                  $gte: currentRange.fromDate,
                  $lte: currentRange.toDate,
                },
              },
            },
            ...ORDER_SALES_SUMMARY_GROUP,
          ],
          last_month: [
            {
              $match: {
                createdAt: {
                  $gte: lastRange.fromDate,
                  $lte: lastRange.toDate,
                },
              },
            },
            ...ORDER_SALES_SUMMARY_GROUP,
          ],
        },
      },
    ]);

    const currentSummary = salesSummaryFromAggregateRows(
      facetResult?.current_month,
    );
    const lastSummary = salesSummaryFromAggregateRows(facetResult?.last_month);

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      current_month: {
        ...currentSummary,
        period: periodPayload("current_month", currentRange),
      },
      last_month: {
        ...lastSummary,
        period: periodPayload("last_month", lastRange),
      },
    });
  } catch (error) {
    console.error("findTotalSalesByOrder:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * DELETE /api/order/order_delete/:id — soft-delete order and reverse GL / outbound inventory.
 *
 * **Session:** Tries `withTransaction` first; on standalone mongod retries without a session.
 *
 * | Step | Collection              | Op                 | Notes |
 * |------|-------------------------|--------------------|-------|
 * |    0 | order, order_item, inventory_movements | read | Pre-txn validation + outbound snapshot |
 * |    1 | order                   | update (soft)      | `status: inactive`, `deletedAt` |
 * |    2 | transaction             | update (soft)      | By header `transaction_number` |
 * |    3 | inventory_movements     | update (soft)      | Active rows for this order `reference_id` |
 * |    4 | order_item              | update (soft)      | All active lines for this order |
 * |    5 | warehouse_inventory, inventory_movements, logs | update / insert | Restore qty + `in` reversal per prior `out` |
 * |    6 | logs                    | insert             | `createApplicationLog` — success |
 * |    7 | logs                    | insert             | `logRollbackFailure` — failure |
 */
async function order_delete(req, res) {
  const orderId = String(req.params?.id || "").trim();
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid id",
      details: "id must be a valid order ObjectId",
      type: "invalid_id",
    });
  }

  const companyId = coalesceObjectId(req.user?.company_id);
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "company_id is required",
      details: "Authenticated user must have company_id to delete an order",
      type: "validation",
    });
  }

  // step 0 — pre-txn read
  const existingOrder = await Order.findOne({
    _id: orderId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
  }).lean();

  if (!existingOrder) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `order with id "${orderId}" not found or already deleted`,
      type: "not_found",
    });
  }

  const transactionNumber = String(
    existingOrder.transaction_number ?? "",
  ).trim();

  const existingOrderItems = await OrderItem.find({
    order_id: orderId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
  })
    .sort({ createdAt: 1 })
    .lean();

  const oldOutMovementsPreTxn = await InventoryMovements.find({
    reference_type: "order",
    reference_id: orderId,
    movement_type: "out",
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  })
    .select("product_id warehouse_id quantity")
    .lean();

  let clientSession = null;
  let txnError = null;
  /** @type {string|null} */
  let orderDeleteExecutionMode = null;
  let softDeletedOrder = null;
  const productStockUpdates = [];
  const deletedAt = new Date();
  const userId = req.user?._id;
  const deleteSnapshot = {
    gl_rows_soft_deleted: 0,
    movements_soft_deleted: 0,
    items_soft_deleted: 0,
    reversal_movements_inserted: 0,
  };

  /** @param {import("mongoose").ClientSession | null} mongoSession */
  const runOrderDeleteBody = async (mongoSession) => {
    const orderSoftDeleteFilter = {
      _id: orderId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    };
    const orderSoftDeleteSet = {
      deletedAt,
      status: "inactive",
    };
    if (userId) {
      orderSoftDeleteSet.updated_by = userId;
    }

    // step 1 — soft-delete order header
    softDeletedOrder = await Order.findOneAndUpdate(
      orderSoftDeleteFilter,
      { $set: orderSoftDeleteSet },
      { new: true, ...orderSessionOpts(mongoSession) },
    ).lean();
    if (!softDeletedOrder) {
      throw new Error("Order not found or already deleted");
    }

    // step 2 — soft-delete GL rows
    const glSoftDelete = await softDeleteActiveGlByTransactionNumber({
      transactionNumber,
      mongoSession,
      userId,
    });
    deleteSnapshot.gl_rows_soft_deleted = glSoftDelete.modifiedCount || 0;
    if (deleteSnapshot.gl_rows_soft_deleted > 0) {
      console.log(
        "✅ Transaction rows soft-deleted:",
        deleteSnapshot.gl_rows_soft_deleted,
      );
    }

    // step 3 — snapshot outbound movements (in txn) then soft-delete movement rows
    let movQuery = InventoryMovements.find({
      reference_type: "order",
      reference_id: orderId,
      movement_type: "out",
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).select("product_id warehouse_id quantity");
    if (mongoSession) movQuery = movQuery.session(mongoSession);
    const oldOutMovementsInTxn = await movQuery.lean();
    const oldOutMovements =
      oldOutMovementsInTxn.length > 0 ?
        oldOutMovementsInTxn
      : oldOutMovementsPreTxn;

    const movementSoftDelete =
      await InventoryMovements.softDeleteActiveByReference({
        referenceType: "order",
        referenceId: orderId,
        companyId,
        session: mongoSession,
        userId,
      });
    deleteSnapshot.movements_soft_deleted =
      movementSoftDelete.modifiedCount || 0;
    if (deleteSnapshot.movements_soft_deleted > 0) {
      console.log(
        "✅ Order inventory movement rows soft-deleted:",
        deleteSnapshot.movements_soft_deleted,
      );
    }

    // step 4 — soft-delete order_item rows
    const itemSoftDeleteSet = {
      deletedAt,
      status: "inactive",
    };
    if (userId) {
      itemSoftDeleteSet.updated_by = userId;
    }
    const itemSoftDelete = await OrderItem.updateMany(
      {
        order_id: orderId,
        company_id: companyId,
        status: "active",
        deletedAt: null,
      },
      { $set: itemSoftDeleteSet },
      orderSessionOpts(mongoSession),
    );
    deleteSnapshot.items_soft_deleted = itemSoftDelete.modifiedCount || 0;
    if (deleteSnapshot.items_soft_deleted > 0) {
      console.log(
        "✅ Order line items soft-deleted:",
        deleteSnapshot.items_soft_deleted,
      );
    }

    // step 5 — restore warehouse_inventory + insert reversal `in` movements
    const restoreResult = await applyOrderDeleteInventoryRestore({
      oldOutMovements,
      existingOrderItems,
      orderId,
      companyId,
      companyIdOid: companyId,
      req,
      mongoSession,
      logUrl: req.originalUrl || req.path || "/api/order/order_delete",
    });
    productStockUpdates.push(...restoreResult.productStockUpdates);
    deleteSnapshot.reversal_movements_inserted =
      restoreResult.reversalMovementsInserted;
  };

  // txn start — MongoDB transaction wrapper (or standalone retry)
  try {
    clientSession = await mongoose.startSession();
    await clientSession.withTransaction(async () => {
      await runOrderDeleteBody(clientSession);
    });
    orderDeleteExecutionMode = "mongodb_transaction_committed";
  } catch (e) {
    if (isMongoTransactionUnsupportedError(e)) {
      if (clientSession) {
        try {
          clientSession.endSession();
        } catch (_) {
          /* ignore */
        }
        clientSession = null;
      }
      console.warn(
        "[order_delete] MongoDB transactions unavailable (e.g. standalone mongod); continuing without transaction",
      );
      try {
        softDeletedOrder = null;
        productStockUpdates.length = 0;
        deleteSnapshot.gl_rows_soft_deleted = 0;
        deleteSnapshot.movements_soft_deleted = 0;
        deleteSnapshot.items_soft_deleted = 0;
        deleteSnapshot.reversal_movements_inserted = 0;
        orderDeleteExecutionMode = "standalone_no_transaction_retry";
        await runOrderDeleteBody(null);
      } catch (e2) {
        txnError = e2;
        console.error(
          "[order_delete] non-session retry failed:\n",
          serializeErrorForLog(e2),
        );
      }
    } else {
      txnError = e;
      orderDeleteExecutionMode = "mongodb_transaction_aborted";
      console.error(
        "[order_delete] withTransaction failed:\n",
        serializeErrorForLog(e),
      );
    }
  } finally {
    if (clientSession) {
      try {
        clientSession.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  // txn end

  // step 7 — failure path
  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "ORDER DELETE ROLLBACK",
      tags: ["api", "order", "rollback", "delete"],
      fallbackUrl: `/api/order/order_delete/${orderId}`,
      context: {
        execution_mode: orderDeleteExecutionMode,
        rollback_note:
          (
            orderDeleteExecutionMode === "mongodb_transaction_aborted" ||
            orderDeleteExecutionMode === "mongodb_transaction"
          ) ?
            "MongoDB multi-document transaction aborted; no partial commit from this attempt."
          : "Standalone / no transaction: partial writes may exist if a step failed mid-flow.",
        order_id: orderId,
        order_no: existingOrder.order_no ?? null,
        transaction_number: transactionNumber,
        line_count: existingOrderItems.length,
        delete_snapshot: deleteSnapshot,
        api_client_error: txnError.clientErrorPayload ?? null,
        error_message: String(txnError.message || ""),
      },
    });
    if (
      txnError.clientErrorPayload &&
      typeof txnError.clientErrorPayload === "object"
    ) {
      const p = txnError.clientErrorPayload;
      return res.status(Number(p.status) || 400).json({
        success: false,
        message: "Order delete rolled back",
        ...p,
        execution_mode: orderDeleteExecutionMode,
      });
    }
    const msg = String(txnError.message || "");
    const is400 =
      msg.includes("Insufficient warehouse inventory") ||
      msg.includes("Warehouse inventory restore failed") ||
      msg.includes("Validation failed") ||
      msg.includes("company_id is required") ||
      msg.includes("Order not found");
    return res.status(is400 ? 400 : 500).json({
      success: false,
      status: is400 ? 400 : 500,
      error: "Order delete rolled back",
      details: txnError.message,
      execution_mode: orderDeleteExecutionMode,
    });
  }

  // step 6 — success audit log
  await createApplicationLog(
    req,
    {
      action: "Order deleted",
      url: req.originalUrl || req.path || "/api/order/order_delete",
      tags: ["order", "delete", "soft_delete", "inventory"],
      description: {
        order_id: orderId,
        order_no: softDeletedOrder?.order_no ?? existingOrder.order_no ?? null,
        transaction_number: transactionNumber,
        line_count: existingOrderItems.length,
        execution_mode: orderDeleteExecutionMode,
        delete_snapshot: deleteSnapshot,
        warehouse_inventory_updates: productStockUpdates.length,
        message: `Order ${softDeletedOrder?.order_no || orderId} soft-deleted; inventory and GL reversed.`,
      },
      reference_id: orderId,
      reference_type: "order",
      company_id: companyId,
    },
    { silent: true },
  );

  return res.status(200).json({
    success: true,
    status: 200,
    message: "Order deleted successfully",
    data: {
      ...softDeletedOrder,
      order_items: existingOrderItems,
      transaction_number: transactionNumber,
    },
    product_stock_updates: productStockUpdates,
    delete_snapshot: deleteSnapshot,
    execution_mode: orderDeleteExecutionMode,
  });
}

module.exports = {
  // orderCreate,
  // orderUpdate,
  invoiceUpdate,
  getOrderByOrderNo,
  order_save,
  order_update,
  order_delete,
  getOrderByorderItem,
  findProfitByOrderItem,
  findSales,
  findTotalSalesByOrder,
  findSalesDayWise,
};

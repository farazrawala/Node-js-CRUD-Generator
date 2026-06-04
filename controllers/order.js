const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const Product = require("../models/product");
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
const {
  runInventoryMovementTxnBody,
  aggregateNetQtyByWarehouse,
  syncProductStockFromMovementLedger,
} = require("./inventory_movements");
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

/**
 * Pick a warehouse with enough stock for this line (from `inventory_movements` in − out per warehouse).
 * Prefers line/default warehouse when sufficient; otherwise highest available qty that can fulfill the sale.
 */
async function resolveWarehouseForOutboundLine({
  productId,
  companyId,
  qtyNeeded,
  preferredWarehouseId,
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
  // Committed ledger only — do not pass order txn session (snapshot may miss PO `in` rows).
  const movRows = await aggregateNetQtyByWarehouse(pid, cid, null);
  for (const row of movRows) {
    const wid = String(row.warehouse_id);
    const net = Math.max(0, Number(row.net_qty) || 0);
    avail.set(wid, net);
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
      "No inventory_movements ledger stock for this product in any warehouse."
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
    details: `No warehouse has at least ${qty} units in inventory_movements (in − out) for product ${String(pid)} and company ${String(cid)}. ${warehouseSummary}`,
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
 * POST /api/order/order_save — create an order, post GL transactions, insert line items, sync header totals.
 *
 * Flow: (1) parse indexed line keys from `req.body`, (2) replace `req.body` with header-only payload for
 * `handleGenericCreate` (restore original afterward), (3) prefer `session.withTransaction` when the deployment
 * supports multi-document transactions (replica set / Atlas); on standalone `mongod` the same steps retry
 * without a session (see `utils/mongoTransactionSupport`), (4) in `afterCreate`, insert four `transaction` rows,
 * (5) `OrderItem.insertMany`, (6) per line: resolve a warehouse with enough stock, then
 *     `runInventoryMovementTxnBody` (movement `out` ledger). Failure aborts the txn (rolls back when supported).
 * (7) `syncHeaderTotalsFromLineItems`.
 *
 * On failure the transaction aborts (when MongoDB supports it) and a row is written to `logs`
 * (`ORDER CREATE ROLLBACK`) with the real error, stack, and request context. Check server logs for `[order_save]`.
 */
async function order_save(req, res) {
  // ─── Parse & validate cart lines (indexed keys, arrays, or legacy shapes) ───
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

  // ─── Build order header payload (line keys stripped; restored to `originalBody` before response) ───
  const originalBody = req.body;
  req.body = normalizeOrderNumericFields(stripLineItemKeys(originalBody));
  delete req.body._id;
  // Unique per company (partial index). Model pre-save assigns next `ORD-####` from Counter when absent.
  // Drop client `order_no` so double-submit / fixed POS defaults cannot collide with existing rows.
  delete req.body.order_no;
  req.body.lines_subtotal = sumParsedLinesSubtotal(lines);

  const transaction_number = generateTransactionNumber();

  // POS sends `posPayMethod`; order schema expects `payment_method_accounts_id` for the payment GL line.
  req.body.payment_method_accounts_id = req.body?.posPayMethod;
  req.body.transaction_number = transaction_number;

  // Outer state survives txn attempt / standalone retry (see `orderSaveExecutionMode` in rollback logs).
  let mongooseClientSession = null;
  let response = null;
  let insertedItemsPlain = [];
  /** Per-line `product.stock` decrements + audit rows in `logs`. */
  let productStockUpdates = [];
  let txnError = null;
  /** How `runOrderSaveBody` last ran; drives rollback/log diagnosis. */
  let orderSaveExecutionMode = "pending";

  /**
   * Single logical create: order header → GL → order_item rows → product.stock → inventory `out` → header sync.
   * @param {import("mongoose").ClientSession | null} mongoSession
   */
  const runOrderSaveBody = async (mongoSession) => {
    insertedItemsPlain = [];
    productStockUpdates = [];
    const lineItemSessionOpts = mongoSession ? { session: mongoSession } : {};
    orderSaveExecutionMode =
      mongoSession ? "mongodb_transaction" : "no_session";

    // Step 1 — persist `order` document (order_no assigned in model pre-save when missing).
    response = await handleGenericCreate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, orderReq, sess) => {
        // Step 2 — four GL postings (sales, shipping, discount, payment); shared transaction_number.
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
      },
    });

    // `handleGenericCreate` returns a result object on validation/model errors instead of throwing.
    if (!response?.success || !response?.data) {
      throwOrderCreateFromGenericFailure(response, "Order create failed");
    }

    const orderId = response.data._id;

    // Step 3 — `order_item` documents (one row per cart line).
    const built = await buildOrderItemDocuments(
      orderId,
      response.data,
      lines,
      req,
    );
    if (built.error) {
      throw new Error(JSON.stringify(built.error));
    }

    // ─── Persist order line items (`order_item` collection) ───
    // `built.docs` = one document per cart line (product, qty, price, subtotal, order_id, …).
    const inserted = await OrderItem.insertMany(
      built.docs,
      lineItemSessionOpts,
    );
    insertedItemsPlain = inserted.map((d) => d.toObject({ flattenMaps: true }));

    // Step 4 — per line: decrement `product.stock`, pick warehouse, post `inventory_movements` `out`.
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
    const orderIdForMovement = response.data._id;

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

      // 4a — `product.stock` on product document (logs row when stock changes).
      let stockUpdate;
      try {
        stockUpdate = await decrementProductStockForOrderLine({
          productId: productIdStr,
          lineQty: lineQtyNum,
          companyId: companyIdForMovementOid || companyIdForMovement,
          req,
          mongoSession,
        });
        productStockUpdates.push(stockUpdate);
      } catch (stockErr) {
        if (stockErr.clientErrorPayload) {
          throwOrderCreateFromGenericFailure(
            stockErr.clientErrorPayload,
            "Insufficient product stock for order line",
          );
        }
        throw stockErr;
      }

      // 4b — warehouse with enough ledger qty (line warehouse_id or company default).
      let warehouseIdStr;
      try {
        warehouseIdStr = await resolveWarehouseForOutboundLine({
          productId: line.product_id,
          companyId: companyIdForMovementOid || companyIdForMovement,
          qtyNeeded: lineQtyNum,
          preferredWarehouseId:
            resolveOrderLineWarehouseId(line, req) || undefined,
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

      const totalCostMovement = Math.round(lineQtyNum * unitCost * 100) / 100;

      // 4c — `runInventoryMovementTxnBody` mutates `req.body` / `req.params.id`; restore after each line.
      const bodyBeforeInventoryMovement = req.body;
      const hadRouteParamId = Object.prototype.hasOwnProperty.call(
        req.params,
        "id",
      );
      const savedRouteParamId = hadRouteParamId ? req.params.id : undefined;

      req.body = {
        product_id: String(line.product_id).trim(),
        warehouse_id: warehouseIdStr,
        quantity: lineQtyNum,
        movement_type: "out",
        unit_cost: unitCost,
        total_cost: totalCostMovement,
        reference_type: "order",
        reference_id: orderIdForMovement,
        reference_name: "Order",
        company_id: companyIdForMovementOid || companyIdForMovement,
        status: "active",
      };

      try {
        const movementResult = await runInventoryMovementTxnBody(
          req,
          mongoSession,
        );
        if (
          !movementResult?.response?.success ||
          !movementResult?.response?.data?._id
        ) {
          throwOrderCreateFromGenericFailure(
            movementResult?.response || {
              success: false,
              status: 500,
              error: "Inventory movement not persisted",
              details:
                "Outbound movement did not return a saved record; order rolled back",
              type: "server",
            },
            "Inventory movement for order was not saved",
          );
        }
      } catch (inventoryMovementErr) {
        if (inventoryMovementErr.clientErrorPayload) {
          throwOrderCreateFromGenericFailure(
            inventoryMovementErr.clientErrorPayload,
            "Inventory movement for order failed",
          );
        }
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

      const alertResult = await evaluateProductStockAlert({
        req,
        productId: productIdStr,
        companyId: companyIdForMovementOid || companyIdForMovement,
        onHand: stockUpdate.stock,
        pathQty: stockUpdate.stock,
        session: mongoSession,
        logUrl: req.originalUrl || req.path || "/api/order/order_save",
      });
      if (!alertResult.success) {
        throw new Error(
          alertResult.message ||
            alertResult.error ||
            "Product stock alert check failed",
        );
      }
    }

    // Step 5 — recompute header totals from line items (items_total, etc.).
    await Order.syncHeaderTotalsFromLineItems(orderId, lineItemSessionOpts);
  };

  // Prefer multi-document transaction (replica set / Atlas); fallback on standalone mongod.
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

  // Caller / downstream middleware may still need the original multipart or indexed keys.
  req.body = originalBody;

  // Failure path — map to client JSON + `logs` rollback row (`ORDER CREATE ROLLBACK`).
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

  // Defensive: should not happen if the transaction completed without `txnError`.
  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  // Success — reload header after sync; attach line items + stock audit from this request.
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
}

/**
 * PATCH order header + optional line replace. Rebuilds GL for `transaction_number` when lines sent.
 * Does not replay inventory `out` movements (unlike `order_save`); replaces `order_item` only, then
 * `syncProductStockFromMovementLedger` for affected product ids (ledger → `product.stock`, same session when txn supported).
 */
async function order_update(req, res) {
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

    response = await handleGenericUpdate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
        // Replace GL set: delete prior rows for this order's transaction_number, then insert four new lines.
        const transaction_number = record?.transaction_number;
        if (transaction_number) {
          const deleteTransc = await Transaction.deleteMany(
            { transaction_number },
            { session: sess },
          );
          if (deleteTransc.deletedCount > 0) {
            console.log("✅ Transaction deleted:", deleteTransc.deletedCount);
          }
        }
        const orderTotal = Number(
          lines
            .reduce(
              (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
              0,
            )
            .toFixed(2),
        );

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
              createdAt: record.createdAt,
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
              createdAt: record.createdAt,
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
              createdAt: record.createdAt,
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
              createdAt: record.createdAt,
            },
          ],
          { stopOnError: true, session: sess },
        );
        postUpdateTransactions.created = created;
        postUpdateTransactions.failed = failed;
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
      },
      filter: { status: "active", deletedAt: null },
    });

    if (!response?.success || !response?.data) {
      throwOrderCreateFromGenericFailure(response, "Order update failed");
    }

    const orderId = response.data._id;

    // When body includes lines: replace all `order_item` rows for this order, then sync header.
    if (lines.length > 0) {
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

      // Snapshot existing lines before replace (for stock/inventory follow-up and API metadata).
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

      await OrderItem.deleteMany({ order_id: orderId }, sessOpts);
      await OrderItem.insertMany(built.docs, sessOpts);
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);

      // Ledger → product.stock (mongoSession: aggregate + product update + audit log roll back with txn).
      const companyIdForStock =
        coalesceObjectId(response?.data?.company_id) ||
        coalesceObjectId(req.user?.company_id);
      const productIdsToSync = [
        ...new Set([...previous_product_ids, ...new_product_ids]),
      ];
      const stockSyncResults = [];
      for (const pid of productIdsToSync) {
        const syncResult = await syncProductStockFromMovementLedger(
          pid,
          companyIdForStock,
          {
            req,
            mongoSession,
            logUrl: req.originalUrl || "/api/order/order_update",
          },
        );
        if (!syncResult.success) {
          throwOrderCreateFromGenericFailure(
            syncResult,
            `Stock sync failed for product ${pid}`,
          );
        }
        stockSyncResults.push({
          product_id: syncResult.product_id,
          stock_synced: syncResult.stock_synced,
          previous_stock: syncResult.product?.previous_stock,
          stock: syncResult.product?.stock,
          net_qty: syncResult.net_qty,
          qty_in: syncResult.qty_in,
          qty_out: syncResult.qty_out,
        });

        const onHandAfterSync = Number(syncResult.product?.stock);
        const alertResult = await evaluateProductStockAlert({
          req,
          productId: String(pid),
          companyId: companyIdForStock,
          onHand: onHandAfterSync,
          pathQty: onHandAfterSync,
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

      orderLineReplaceSnapshot = {
        previous_product_ids,
        new_product_ids,
        stock_sync: stockSyncResults,
      };
    } else {
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);
    }
  };

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

  req.body = originalBody;

  if (txnError) {
    console.error(
      "[order_update] failure (serializeErrorForLog):\n",
      serializeErrorForLog(txnError),
    );

    const bodyForLog =
      originalBody && typeof originalBody === "object" ? originalBody : {};
    const firstLine = lines[0] || {};
    // `logs` rollback row — see `execution_mode` / `rollback_note` in context.
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

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const orderId = response.data._id;

  // Success — return order + populated line items and GL bulk metadata.
  const items = await OrderItem.find({
    order_id: orderId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

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
    const fromDate = hasFrom ?
      new Date(String(req.query.from).trim())
    : null;
    const toDate =
      hasTo ? new Date(String(req.query.to).trim()) : new Date();
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

module.exports = {
  // orderCreate,
  // orderUpdate,
  invoiceUpdate,
  getOrderByOrderNo,
  order_save,
  order_update,
  getOrderByorderItem,
  findProfitByOrderItem,
  findSales,
  findTotalSalesByOrder,
  findSalesDayWise,
};

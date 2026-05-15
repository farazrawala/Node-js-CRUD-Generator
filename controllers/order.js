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
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");
const { runInventoryMovementTxnBody } = require("./inventory_movements");

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
  const companyId = orderSnapshot.company_id || req.user?.company_id;
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
  const productById = new Map(
    products.map((p) => [String(p._id), p]),
  );

  const docs = [];
  for (const line of lines) {
    const pid = String(line.product_id ?? "").trim();
    const product = mongoose.Types.ObjectId.isValid(pid) ?
      productById.get(pid)
    : null;
    const name =
      product && String(product.product_name || "").trim() ?
        String(product.product_name).trim()
      : "Item";
    const cost_price_at_sale = costPriceAtSaleFromProduct(product);

    docs.push({
      order_id: orderId,
      product_id: pid,
      name,
      qty: String(line.qtyRaw ?? line.qty).trim(),
      price: Number(line.price),
      subtotal: Number(line.subtotal),
      cost_price_at_sale,
      company_id: companyId,
      branch_id: orderSnapshot.branch_id || undefined,
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

// async function orderCreate(req, res) {
//   const response = await handleGenericCreate(req, "order", {
//     afterCreate: async (record, req) => {
//       console.log("✅ Record created successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

async function getOrderByorderItem(req, res) {
  const filter = { status: "active", deletedAt: null };
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
 * (5) `OrderItem.insertMany`, (6) for each line with `warehouse_id`, `runInventoryMovementTxnBody` (movement `out`),
 * (7) `syncHeaderTotalsFromLineItems`.
 *
 * On failure the transaction aborts; `req.body` is restored after `endSession`. Check server logs for `[order_save]` detail.
 */
async function order_save(req, res) {
  // Lines are parsed from the raw body; header create uses a stripped `req.body` (restored before the HTTP response).
  const lines = parseOrderLineItems(req.body);
  if (lines.length === 0) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Order lines required",
      details:
        "Send at least one valid line with product_id[n], qty[n], and price[n] (e.g. product_id[0], qty[0], price[0]). Optional warehouse_id[n] per line records an inventory movement (out).",
      type: "validation",
    });
  }

  // `handleGenericCreate` only reads header fields from `req.body`; stash the client payload and restore after the session block.
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

  let mongooseClientSession = null;
  let response = null;
  let insertedItemsPlain = [];
  let txnError = null;

  const runOrderSaveBody = async (mongoSession) => {
    insertedItemsPlain = [];
    const lineItemSessionOpts = mongoSession ? { session: mongoSession } : {};

    response = await handleGenericCreate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterCreate: async (record, orderReq, sess) => {
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
          const msg = `Post-order transaction bulk insert failed: ${JSON.stringify(failed)}`;
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(req, msg, ORDER_TRANSACTION_ERROR_LOG);
          throw new Error(msg);
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

    // Outbound inventory movement for each line that sent `warehouse_id[n]` (ledger via `runInventoryMovementTxnBody` only).
    const companyIdForMovement =
      coalesceObjectId(response.data.company_id) ||
      coalesceObjectId(req.user?.company_id);
    const orderIdForMovement = response.data._id;

    for (const line of lines) {
      const warehouseIdStr =
        line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
      if (
        !warehouseIdStr ||
        !mongoose.Types.ObjectId.isValid(warehouseIdStr)
      ) {
        continue;
      }
      const unitCost = Number(line.price);
      const lineQtyNum = Number(line.qty);
      if (
        !Number.isFinite(unitCost) ||
        unitCost < 0 ||
        !Number.isFinite(lineQtyNum) ||
        lineQtyNum <= 0
      ) {
        throw new Error(
          "Each order line with a warehouse needs a finite unit price (price) and positive quantity for inventory movement",
        );
      }
      const totalCostMovement =
        Math.round(lineQtyNum * unitCost * 100) / 100;

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
        company_id: companyIdForMovement,
        status: "active",
      };

      try {
        await runInventoryMovementTxnBody(req, mongoSession);
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

    await Order.syncHeaderTotalsFromLineItems(orderId, lineItemSessionOpts);
  };

  try {
    mongooseClientSession = await mongoose.startSession();
    await mongooseClientSession.withTransaction(async () => {
      await runOrderSaveBody(mongooseClientSession);
    });
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

  if (txnError) {
    await logRollbackFailure(req, txnError, {
      action: "ORDER CREATE ROLLBACK",
      tags: ["api", "order", "rollback", "create"],
      fallbackUrl: "/api/order/order_save",
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
    return res.status(isGl ? 400 : 500).json({
      success: false,
      status: isGl ? 400 : 500,
      error: isGl ? "Order creation rolled back" : "Failed to create order",
      details: txnError.message,
    });
  }

  // Defensive: should not happen if the transaction completed without `txnError`.
  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  // Reload from DB so header fields updated by `syncHeaderTotalsFromLineItems` are included in the response.
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
  });
}

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

  const postUpdateTransactions = { created: [], failed: [] };

  let mongooseClientSession = null;
  let response = null;
  let txnError = null;

  const runOrderUpdateBody = async (mongoSession) => {
    const sessOpts = mongoSession ? { session: mongoSession } : {};

    response = await handleGenericUpdate(req, "order", {
      ...(mongoSession ? { session: mongoSession } : {}),
      afterUpdate: async (record, orderReq, _existing, sess) => {
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
          req,
          [
            {
              account_id: req.user.company_id.default_sales_account,
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
              account_id: req.user.company_id.default_shipping_account,
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
              account_id: req.user.company_id.default_sales_discount_account,
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
              account_id: req.body?.posPayMethod,
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
          const msg = `Post-order transaction bulk insert failed: ${JSON.stringify(failed)}`;
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(req, msg, ORDER_TRANSACTION_ERROR_LOG);
          throw new Error(msg);
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

    if (lines.length > 0) {
      const built = await buildOrderItemDocuments(
        orderId,
        response.data,
        lines,
        req,
      );
      if (built.error) {
        throw new Error(JSON.stringify(built.error));
      }
      await OrderItem.deleteMany({ order_id: orderId }, sessOpts);
      await OrderItem.insertMany(built.docs, sessOpts);
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);
    } else {
      await Order.syncHeaderTotalsFromLineItems(orderId, sessOpts);
    }
  };

  try {
    mongooseClientSession = await mongoose.startSession();
    await mongooseClientSession.withTransaction(async () => {
      await runOrderUpdateBody(mongooseClientSession);
    });
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
        "[order_update] MongoDB transactions unavailable (e.g. standalone mongod); continuing without session",
      );
      try {
        response = null;
        postUpdateTransactions.created = [];
        postUpdateTransactions.failed = [];
        await runOrderUpdateBody(null);
      } catch (nonSessionRetryError) {
        txnError = nonSessionRetryError;
        console.error(
          "[order_update] non-session retry failed:",
          serializeErrorForLog(nonSessionRetryError),
        );
      }
    } else {
      txnError = mongoTransactionError;
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
    await logRollbackFailure(req, txnError, {
      action: "ORDER UPDATE ROLLBACK",
      tags: ["api", "order", "rollback", "update"],
      fallbackUrl: "/api/order/order_update",
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
    return res.status(isGl ? 400 : 500).json({
      success: false,
      status: isGl ? 400 : 500,
      error: "Order update rolled back",
      details: txnError.message,
    });
  }

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const orderId = response.data._id;

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

module.exports = {
  // orderCreate,
  // orderUpdate,
  invoiceUpdate,
  getOrderByOrderNo,
  order_save,
  order_update,
  getOrderByorderItem,
};

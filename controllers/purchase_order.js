const mongoose = require("mongoose");
const PurchaseOrder = require("../models/purchase_order");
const PurchaseOrderItem = require("../models/purchase_order_item");

const Transaction = require("../models/transaction");

const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");
const { logControllerError } = require("../utils/logControllerError");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
} = require("../utils/modelHelper");
const { createStockMovementRecord } = require("./stock_movement");

const PURCHASE_ORDER_TRANSACTION_ERROR_LOG = {
  action: "POST PURCHASE ORDER TRANSACTION ERROR",
  tags: ["api", "purchase_order", "transaction", "error"],
  fallbackUrl: "/api/purchase_order/save",
};

function purchaseOrderLinesSubtotalSum(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  return Number(
    lineItems
      .reduce(
        (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
        0,
      )
      .toFixed(2),
  );
}

function normalizePurchaseOrderNumericFields(obj) {
  const out = { ...obj };
  for (const key of [
    "discount",
    "shipment",
    "lines_subtotal",
    "total_amount",
    "amount_paid",
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

/** Same as order: qs / express-fileupload parseNested turn `product_id[0]` into nested structures. */
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

/** e.g. product_id[0], qty[0], price[0] — raw flat keys (some clients / multipart) */
function parseBracketLineItems(body) {
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
    m = key.match(/^total\[(\d+)\]$/);
    if (m) {
      const i = parseInt(m[1], 10);
      if (!byIndex.has(i)) byIndex.set(i, {});
      byIndex.get(i).total = body[key];
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
    const qty = parseFloat(String(row.qty ?? "").trim());
    const price = parseFloat(String(row.price ?? "").trim());
    const fromTotal = parseFloat(String(row.total ?? "").trim());
    const subtotal =
      Number.isFinite(fromTotal) ? fromTotal
      : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
      : NaN;
    lines.push({
      product_id: row.product_id,
      qty,
      price,
      subtotal,
      warehouse_id: row.warehouse_id,
    });
  }
  return lines.filter(
    (l) =>
      l.product_id &&
      String(l.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
      Number.isFinite(l.qty) &&
      Number.isFinite(l.price) &&
      Number.isFinite(l.subtotal),
  );
}

/**
 * `body.product_id` / `body.qty` / `body.price` as arrays or `{ 0: x, 1: y }`
 * (typical after `application/x-www-form-urlencoded` with bracket notation).
 */
function parseLineItemsFromIndexedContainers(body) {
  if (!body || typeof body !== "object") return [];
  const p = body.product_id;
  const q = body.qty;
  const pr = body.price;
  const t = body.total;
  const w = body.warehouse_id;
  const len = Math.max(
    indexedContainerLength(p),
    indexedContainerLength(q),
    indexedContainerLength(pr),
    indexedContainerLength(t),
    indexedContainerLength(w),
  );
  if (len === 0) return [];

  const lines = [];
  for (let i = 0; i < len; i++) {
    const product_id = indexedContainerGet(p, i);
    const qtyRaw = indexedContainerGet(q, i);
    const priceRaw = indexedContainerGet(pr, i);
    const totalRaw = indexedContainerGet(t, i);
    const warehouse_id = indexedContainerGet(w, i);
    const qty = parseFloat(String(qtyRaw ?? "").trim());
    const price = parseFloat(String(priceRaw ?? "").trim());
    const fromTotal = parseFloat(String(totalRaw ?? "").trim());
    const subtotal =
      Number.isFinite(fromTotal) ? fromTotal
      : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
      : NaN;
    lines.push({ product_id, qty, price, subtotal, warehouse_id });
  }
  return lines.filter(
    (l) =>
      l.product_id &&
      String(l.product_id).trim() !== "" &&
      mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
      Number.isFinite(l.qty) &&
      Number.isFinite(l.price) &&
      Number.isFinite(l.subtotal),
  );
}

function parseLegacyArrayLineItems(body) {
  const productIdArray =
    Array.isArray(body["product_id[]"]) ?
      body["product_id[]"]
    : [body["product_id[]"]].filter(Boolean);
  const qtyArray =
    Array.isArray(body["qty[]"]) ?
      body["qty[]"]
    : [body["qty[]"]].filter(Boolean);
  const priceArray =
    Array.isArray(body["price[]"]) ?
      body["price[]"]
    : [body["price[]"]].filter(Boolean);
  const totalArray =
    Array.isArray(body["total[]"]) ?
      body["total[]"]
    : [body["total[]"]].filter(Boolean);
  const warehouseIdArray =
    Array.isArray(body["warehouse_id[]"]) ?
      body["warehouse_id[]"]
    : [body["warehouse_id[]"]].filter(Boolean);
  if (productIdArray.length === 0) return [];
  return productIdArray
    .map((productId, index) => {
      const qty = parseFloat(String(qtyArray[index] ?? "").trim());
      const price = parseFloat(String(priceArray[index] ?? "").trim());
      const fromTotal = parseFloat(String(totalArray[index] ?? "").trim());
      const warehouse_id = warehouseIdArray[index];
      const subtotal =
        Number.isFinite(fromTotal) ? fromTotal
        : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
        : NaN;
      return { product_id: productId, qty, price, subtotal, warehouse_id };
    })
    .filter(
      (l) =>
        l.product_id &&
        mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
        Number.isFinite(l.qty) &&
        Number.isFinite(l.price) &&
        Number.isFinite(l.subtotal),
    );
}

function parseProductIdsBodyArray(body) {
  if (!body.product_ids || !Array.isArray(body.product_ids)) return [];
  return body.product_ids
    .map((row) => {
      const qty = parseFloat(String(row.qty ?? "").trim());
      const price = parseFloat(String(row.price ?? "").trim());
      const subtotal =
        row.subtotal != null && String(row.subtotal).trim() !== "" ?
          parseFloat(String(row.subtotal).trim())
        : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
        : NaN;
      return {
        product_id: row.product_id,
        qty,
        price,
        subtotal,
        warehouse_id: row.warehouse_id,
      };
    })
    .filter(
      (l) =>
        l.product_id &&
        mongoose.Types.ObjectId.isValid(String(l.product_id).trim()) &&
        Number.isFinite(l.qty) &&
        Number.isFinite(l.price) &&
        Number.isFinite(l.subtotal),
    );
}

function stripLineItemKeysFromBody(body) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (/^(product_id|qty|price|total|warehouse_id)\[\d+\]$/.test(k)) continue;
    if (
      [
        "product_id[]",
        "qty[]",
        "price[]",
        "total[]",
        "warehouse_id[]",
      ].includes(k)
    )
      continue;
    out[k] = body[k];
  }
  if (indexedContainerLength(out.product_id) > 0) {
    delete out.product_id;
    delete out.qty;
    delete out.price;
    delete out.total;
    delete out.warehouse_id;
  }
  return out;
}

/** Match order model required fields when the client omits them (e.g. line-item–only payloads). */
function ensurePurchaseOrderHeaderFields(body, user) {
  const b = body || {};
  if (!String(b.name ?? "").trim()) {
    b.name = "Purchase order";
  }
  if (!String(b.email ?? "").trim()) {
    b.email = user?.email || "pending@example.com";
  }
  if (!String(b.phone ?? "").trim()) {
    b.phone = String(user?.phone ?? "").trim() || "-";
  }
}

function collectLineItems(body) {
  let lines = parseBracketLineItems(body);
  if (lines.length === 0) lines = parseLineItemsFromIndexedContainers(body);
  if (lines.length === 0) lines = parseLegacyArrayLineItems(body);
  if (lines.length === 0) lines = parseProductIdsBodyArray(body);
  return lines;
}

function buildPurchaseOrderItemDocuments(poId, poSnapshot, lines, req) {
  const companyId = poSnapshot.company_id || req.user?.company_id;
  if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
    return {
      docs: [],
      error:
        "company_id is required on purchase order line items (set on the PO or authenticated user)",
    };
  }
  const userId = req.user?._id;
  const docs = [];
  for (const line of lines) {
    const doc = {
      purchase_order_id: poId,
      product_id: String(line.product_id).trim(),
      qty: line.qty,
      price: line.price,
      subtotal: line.subtotal,
      status: "active",
      deletedAt: null,
      company_id: companyId,
    };
    const wid =
      line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
    if (wid && mongoose.Types.ObjectId.isValid(wid)) {
      doc.warehouse_id = wid;
    }
    if (userId) {
      doc.created_by = userId;
      doc.updated_by = userId;
    }
    docs.push(doc);
  }
  return { docs };
}

function shapePurchaseOrderWithItems(poPlain, items) {
  const purchase_order_items_total = items.reduce((sum, item) => {
    const sub = Number(item.subtotal);
    return sum + (Number.isFinite(sub) ? sub : 0);
  }, 0);
  return {
    ...poPlain,
    purchase_order_items: items,
    no_of_items: items.length,
    purchase_order_items_total,
  };
}

async function getPurchaseOrderByPurchaseItem(req, res) {
  const idParam =
    req.params && req.params.id != null ? String(req.params.id).trim() : "";

  if (idParam && !mongoose.Types.ObjectId.isValid(idParam)) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Invalid id",
      details: "id must be a valid purchase_order ObjectId",
      type: "invalid_id",
    });
  }

  const filter = { status: "active", deletedAt: null };
  if (idParam) {
    filter._id = idParam;
  }

  const response = await handleGenericGetAll(req, "purchase_order", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status).json(response);
  }

  if (idParam && response.data.length === 0) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `purchase_order with id "${idParam}" not found`,
      type: "not_found",
    });
  }

  const poIds = response.data.map((o) => o._id).filter(Boolean);
  if (poIds.length === 0) {
    return res.status(response.status).json(response);
  }

  const itemFilter = {
    purchase_order_id: { $in: poIds },
    status: "active",
    deletedAt: null,
  };
  const items = await PurchaseOrderItem.find(itemFilter)
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const itemsByPoId = new Map();
  for (const id of poIds) {
    itemsByPoId.set(String(id), []);
  }
  for (const item of items) {
    const key = String(item.purchase_order_id);
    if (!itemsByPoId.has(key)) {
      itemsByPoId.set(key, []);
    }
    itemsByPoId.get(key).push(item);
  }

  const data = response.data.map((po) => {
    const purchase_order_items = itemsByPoId.get(String(po._id)) || [];
    const purchase_order_items_total = purchase_order_items.reduce(
      (sum, row) => {
        const sub = Number(row.subtotal);
        return sum + (Number.isFinite(sub) ? sub : 0);
      },
      0,
    );
    return {
      ...po,
      purchase_order_items,
      no_of_items: purchase_order_items.length,
      purchase_order_items_total,
    };
  });

  return res.status(response.status).json({
    ...response,
    data,
  });
}

async function getPurchaseOrderByOrderNo(req, res) {
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

  let po = await PurchaseOrder.findOne({
    purchase_order_no: param,
    ...filter,
  });
  if (!po && mongoose.Types.ObjectId.isValid(param)) {
    po = await PurchaseOrder.findOne({ _id: param, ...filter });
  }

  if (!po) {
    return res.status(404).json({
      success: false,
      status: 404,
      error: "Record not found",
      details: `purchase_order with purchase_order_no or id "${param}" not found`,
      type: "not_found",
    });
  }

  const items = await PurchaseOrderItem.find({
    purchase_order_id: po._id,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapePurchaseOrderWithItems(
    po.toObject({ flattenMaps: true }),
    items,
  );

  return res.status(200).json({
    success: true,
    status: 200,
    data,
  });
}

async function purchaseOrderCreate(req, res) {
  const originalBody = req.body;
  const lines = collectLineItems(originalBody);

  try {
    req.body = normalizePurchaseOrderNumericFields(
      stripLineItemKeysFromBody(originalBody),
    );
    delete req.body._id;
    ensurePurchaseOrderHeaderFields(req.body, req.user);

    req.body.lines_subtotal =
      lines.length > 0 ?
        purchaseOrderLinesSubtotalSum(lines)
      : purchaseOrderLinesSubtotalSum([]);

    const transaction_number = `TXN-${Date.now()}-${Math.floor(
      Math.random() * 1000000,
    )
      .toString()
      .padStart(6, "0")}`;

    req.body.transaction_number = transaction_number;

    const session = await mongoose.startSession();
    let purchaseOrderResponse = null;
    const purchaseOrderItems = [];
    let txnError = null;

    try {
      await session.withTransaction(async () => {
        purchaseOrderResponse = await handleGenericCreate(
          req,
          "purchase_order",
          {
            session,
            afterCreate: async (record, orderReq, sess) => {
              const { created, failed } = await transactionBulkCreate(
                orderReq,
                [
                  {
                    account_id:
                      orderReq.user.company_id.default_purchase_account,
                    type: "debit",
                    amount: record?.total_amount ?? 0,
                    reference_user_id: record?.vendor_id,
                    transaction_number,
                    description: "Purchase Order",
                    reference_id: {
                      module: "purchase_order",
                      ref_id: record._id,
                    },
                  },
                  {
                    account_id:
                      orderReq.user.company_id
                        .default_purchase_discount_account,
                    type: "debit",
                    amount: record?.discount ?? 0,
                    reference_user_id: record?.vendor_id,
                    transaction_number,
                    description: "Purchase Discount",
                  },
                  {
                    account_id:
                      orderReq.user.company_id.default_shipping_account,
                    type: "debit",
                    amount: record?.shipment ?? 0,
                    reference_user_id: record?.vendor_id,
                    transaction_number,
                    description: "Purchase Shipment",
                    reference_id: {
                      module: "purchase_order",
                      ref_id: record._id,
                    },
                  },
                  {
                    account_id: record?.payment_method_accounts_id,
                    type: "credit",
                    amount: record?.amount_paid ?? 0,
                    reference_user_id: record?.vendor_id,
                    transaction_number,
                    description: "Mode of Payment",
                    reference_id: {
                      module: "purchase_order",
                      ref_id: record._id,
                    },
                  },
                  {
                    account_id:
                      orderReq.user.company_id.default_account_payable_account,
                    type: "credit",
                    amount: req.body?.remaining_amount || 0,
                    reference_user_id: record?.vendor_id,
                    transaction_number,
                    description: "A/c Payable",
                    reference_id: {
                      module: "purchase_order",
                      ref_id: record._id,
                    },
                  },
                ],
                { stopOnError: true, session: sess },
              );
              if (failed.length) {
                const msg = `Post-purchase_order transaction bulk insert failed: ${JSON.stringify(failed)}`;
                console.error("⚠️ Post-purchase_order transaction bulk insert failed:", failed);
                await logControllerError(
                  orderReq,
                  msg,
                  PURCHASE_ORDER_TRANSACTION_ERROR_LOG,
                );
                throw new Error(msg);
              }
              if (created[0]?.data?._id) {
                console.log(
                  "✅ Transaction(s) created:",
                  created.map((c) => c.data._id),
                );
              }
            },
          },
        );

        if (!purchaseOrderResponse?.success || !purchaseOrderResponse.data) {
          throw new Error(
            purchaseOrderResponse?.error ||
              purchaseOrderResponse?.message ||
              "Purchase order create failed",
          );
        }

        const poId = purchaseOrderResponse.data._id;
        const companyId =
          purchaseOrderResponse.data.company_id || req.user?.company_id;

        if (lines.length === 0) {
          return;
        }

        if (!companyId || !mongoose.Types.ObjectId.isValid(String(companyId))) {
          throw new Error(
            "company_id is required to create purchase order line items",
          );
        }

        for (const line of lines) {
          const itemData = {
            purchase_order_id: poId,
            product_id: String(line.product_id).trim(),
            qty: line.qty,
            price: line.price,
            subtotal: line.subtotal,
            status: "active",
            company_id: companyId,
          };

          const wid =
            line.warehouse_id != null ? String(line.warehouse_id).trim() : "";
          if (wid && mongoose.Types.ObjectId.isValid(wid)) {
            itemData.warehouse_id = wid;
          }

          const savedItemBody = req.body;
          req.body = itemData;
          const itemResponse = await handleGenericCreate(
            req,
            "purchase_order_item",
            { session },
          );
          req.body = savedItemBody;

          if (!itemResponse.success || !itemResponse.data) {
            throw new Error(
              itemResponse.error ||
                (Array.isArray(itemResponse.missing) ?
                  itemResponse.missing.join(", ")
                : "Purchase order line item failed"),
            );
          }

          if (wid && mongoose.Types.ObjectId.isValid(wid)) {
            const stockMovementResult = await createStockMovementRecord({
              body: {
                product_id: String(line.product_id).trim(),
                warehouse_id: wid,
                quantity: line.qty,
                direction: "in",
                type: "purchase",
                reference_id: itemResponse.data._id,
                reason: "Purchase order",
                company_id: companyId,
              },
              user: req.user,
              session,
            });
            if (!stockMovementResult.success || !stockMovementResult.data) {
              throw new Error(
                stockMovementResult.message ||
                  "Purchase order stock movement failed",
              );
            }
          }

          purchaseOrderItems.push(itemResponse.data);
        }

        await PurchaseOrder.syncHeaderTotalsFromLineItems(poId, { session });
      });
    } catch (e) {
      txnError = e;
    } finally {
      session.endSession();
    }

    req.body = originalBody;

    if (txnError) {
      console.error("Purchase Order creation error:", txnError);
      const msg = String(txnError.message || "");
      const isGl =
        msg.includes("Post-purchase_order") ||
        msg.includes("company_id is required");
      return res.status(isGl ? 400 : 500).json({
        success: false,
        status: isGl ? 400 : 500,
        error: isGl ? "Purchase order creation rolled back" : "Failed to create purchase order",
        details: txnError.message,
      });
    }

    if (!purchaseOrderResponse?.success || !purchaseOrderResponse.data) {
      return res
        .status(purchaseOrderResponse?.status || 400)
        .json(purchaseOrderResponse);
    }

    const poId = purchaseOrderResponse.data._id;

    if (lines.length === 0) {
      return res.status(201).json({
        ...purchaseOrderResponse,
        status: 201,
        items: [],
      });
    }

    const items_total = purchaseOrderItems.reduce(
      (s, it) => s + (Number(it.subtotal) || 0),
      0,
    );

    const poFresh = await PurchaseOrder.findById(poId).lean();

    return res.status(201).json({
      ...purchaseOrderResponse,
      status: 201,
      data: { ...purchaseOrderResponse.data, ...poFresh },
      items: purchaseOrderItems,
      items_total,
    });
  } catch (error) {
    console.error("Purchase Order creation error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase order",
      error: error.message,
    });
  }
}

async function purchase_order_update(req, res) {
  const lines = collectLineItems(req.body);
  const originalBody = req.body;
  req.body = normalizePurchaseOrderNumericFields(
    stripLineItemKeysFromBody(originalBody),
  );
  delete req.body._id;

  const recordId = String(req.params?.id || "").trim();
  if (lines.length > 0) {
    req.body.lines_subtotal = purchaseOrderLinesSubtotalSum(lines);
  } else if (recordId && mongoose.Types.ObjectId.isValid(recordId)) {
    const existingItems = await PurchaseOrderItem.find({
      purchase_order_id: recordId,
      status: "active",
      deletedAt: null,
    })
      .select("subtotal")
      .lean();
    req.body.lines_subtotal =
      purchaseOrderLinesSubtotalSum(existingItems);
  }

  const session = await mongoose.startSession();
  let response = null;
  let txnError = null;

  try {
    await session.withTransaction(async () => {
      response = await handleGenericUpdate(req, "purchase_order", {
        session,
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

          const { created, failed } = await transactionBulkCreate(
            orderReq,
            [
              {
                account_id: orderReq.user.company_id.default_purchase_account,
                type: "debit",
                amount: record?.total_amount ?? 0,
                reference_user_id: record?.vendor_id,
                transaction_number,
                description: "Purchase Order",
                reference_id: {
                  module: "purchase_order",
                  ref_id: record._id,
                },
              },
              {
                account_id:
                  orderReq.user.company_id.default_purchase_discount_account,
                type: "debit",
                amount: record?.discount ?? 0,
                reference_user_id: record?.vendor_id,
                transaction_number,
                description: "Purchase Discount",
              },
              {
                account_id: orderReq.user.company_id.default_shipping_account,
                type: "debit",
                amount: record?.shipment ?? 0,
                reference_user_id: record?.vendor_id,
                transaction_number,
                description: "Purchase Shipment",
                reference_id: {
                  module: "purchase_order",
                  ref_id: record._id,
                },
              },
              {
                account_id: record?.payment_method_accounts_id,
                type: "credit",
                amount: record?.amount_paid ?? 0,
                reference_user_id: record?.vendor_id,
                transaction_number,
                description: "Mode of Payment",
                reference_id: {
                  module: "purchase_order",
                  ref_id: record._id,
                },
              },
              {
                account_id:
                  orderReq.user.company_id.default_account_payable_account,
                type: "credit",
                amount: req.body?.remaining_amount || 0,
                reference_user_id: record?.vendor_id,
                transaction_number,
                description: "A/c Payable",
                reference_id: {
                  module: "purchase_order",
                  ref_id: record._id,
                },
              },
            ],
            { stopOnError: true, session: sess },
          );
          if (failed.length) {
            const msg = `Post-purchase_order transaction bulk insert failed: ${JSON.stringify(failed)}`;
            console.error(
              "⚠️ Post-purchase_order transaction bulk insert failed:",
              failed,
            );
            await logControllerError(
              orderReq,
              msg,
              PURCHASE_ORDER_TRANSACTION_ERROR_LOG,
            );
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
        throw new Error(
          response?.error || response?.message || "Purchase order update failed",
        );
      }

      const poId = response.data._id;

      if (lines.length > 0) {
        const built = buildPurchaseOrderItemDocuments(
          poId,
          response.data,
          lines,
          req,
        );
        if (built.error) {
          throw new Error(built.error);
        }
        await PurchaseOrderItem.deleteMany(
          { purchase_order_id: poId },
          { session },
        );
        await PurchaseOrderItem.insertMany(built.docs, { session });
        await PurchaseOrder.syncHeaderTotalsFromLineItems(poId, { session });
      } else {
        await PurchaseOrder.syncHeaderTotalsFromLineItems(poId, { session });
      }
    });
  } catch (e) {
    txnError = e;
  } finally {
    session.endSession();
  }

  req.body = originalBody;

  if (txnError) {
    const msg = String(txnError.message || "");
    const is400 =
      msg.includes("Post-purchase_order") ||
      msg.includes("company_id is required");
    return res.status(is400 ? 400 : 500).json({
      success: false,
      status: is400 ? 400 : 500,
      error: "Purchase order update rolled back",
      details: txnError.message,
    });
  }

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const poId = response.data._id;

  const items = await PurchaseOrderItem.find({
    purchase_order_id: poId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const poFresh = await PurchaseOrder.findById(poId).lean();
  const data = shapePurchaseOrderWithItems(poFresh || response.data, items);
  return res.status(200).json({
    success: true,
    status: 200,
    data,
  });
}

module.exports = {
  purchaseOrderCreate,
  purchase_order_update,
  getPurchaseOrderByPurchaseItem,
  getPurchaseOrderByOrderNo,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};

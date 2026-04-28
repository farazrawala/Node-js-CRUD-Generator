const mongoose = require("mongoose");
const Order = require("../models/order");
const OrderItem = require("../models/order_item");
const Product = require("../models/product");
const Transaction = require("../models/transaction");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
} = require("../utils/modelHelper");
const { logControllerError } = require("../utils/logControllerError");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");

const ORDER_TRANSACTION_ERROR_LOG = {
  action: "POST ORDER TRANSACTION ERROR",
  tags: ["api", "order", "transaction", "error"],
  fallbackUrl: "/api/order/save",
};

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
  const len = Math.max(
    indexedContainerLength(p),
    indexedContainerLength(q),
    indexedContainerLength(pr),
  );
  if (len === 0) return [];

  const lines = [];
  for (let i = 0; i < len; i++) {
    const product_id = indexedContainerGet(p, i);
    const qtyRaw = indexedContainerGet(q, i);
    const priceRaw = indexedContainerGet(pr, i);
    const qtyNum = parseFloat(String(qtyRaw ?? "").trim());
    const priceNum = parseFloat(String(priceRaw ?? "").trim());
    const subtotal =
      Number.isFinite(qtyNum) && Number.isFinite(priceNum) ?
        qtyNum * priceNum
      : NaN;
    lines.push({
      product_id,
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
    if (/^(product_id|qty|price)\[\d+\]$/.test(k)) continue;
    out[k] = body[k];
  }
  if (Array.isArray(out.product_id)) delete out.product_id;
  if (Array.isArray(out.qty)) delete out.qty;
  if (Array.isArray(out.price)) delete out.price;
  return out;
}

function normalizeOrderNumericFields(obj) {
  const out = { ...obj };
  for (const key of ["discount", "amount_received", "change_given"]) {
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

async function getProductLineName(productId) {
  const id = String(productId || "").trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return "Item";
  const p = await Product.findById(id).select("product_name").lean();
  return (p && p.product_name) || "Item";
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
  const docs = [];
  for (const line of lines) {
    const name = await getProductLineName(line.product_id);
    docs.push({
      order_id: orderId,
      product_id: String(line.product_id).trim(),
      name,
      qty: String(line.qtyRaw ?? line.qty).trim(),
      price: Number(line.price),
      subtotal: Number(line.subtotal),
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

async function order_save(req, res) {
  const lines = parseOrderLineItems(req.body);
  if (lines.length === 0) {
    return res.status(400).json({
      success: false,
      status: 400,
      error: "Order lines required",
      details:
        "Send at least one valid line with product_id[n], qty[n], and price[n] (e.g. product_id[0], qty[0], price[0]).",
      type: "validation",
    });
  }

  const originalBody = req.body;
  req.body = normalizeOrderNumericFields(stripLineItemKeys(originalBody));
  delete req.body._id;

  const transaction_number = `TXN-${Date.now()}-${Math.floor(
    Math.random() * 1000000,
  )
    .toString()
    .padStart(6, "0")}`;

  req.body.payment_method_accounts_id = req.body?.posPayMethod;
  req.body.transaction_number = transaction_number;

  const response = await handleGenericCreate(req, "order", {
    afterCreate: async (record, orderReq) => {
      console.log("✅ Order created successfully:", record);

      // Same insert path as POST /api/transaction/bulk-create (`createTransactionsFromItems`).
      try {
        const orderTotal = Number(
          lines
            .reduce(
              (sum, l) => sum + (Number.isFinite(l.subtotal) ? l.subtotal : 0),
              0,
            )
            .toFixed(2),
        );

        // cash 75
        // discount 75
        //     sales 100
        //     shipment 50

        const { created, failed } = await transactionBulkCreate(
          orderReq,
          [
            {
              // sales
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
              // shipment
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
              // Sales Discount
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
              // Cash
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
          { stopOnError: true },
        );
        if (failed.length) {
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(
            req,
            `Post-order transaction bulk insert failed: ${JSON.stringify(failed)}`,
            ORDER_TRANSACTION_ERROR_LOG,
          );
        } else if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-order transaction error: ${e.message}`,
          ORDER_TRANSACTION_ERROR_LOG,
        );
      }
    },
  });

  req.body = originalBody;

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const orderId = response.data._id;
  const built = await buildOrderItemDocuments(
    orderId,
    response.data,
    lines,
    req,
  );
  if (built.error) {
    await Order.findByIdAndDelete(orderId);
    return res.status(built.error.status).json(built.error);
  }

  try {
    const inserted = await OrderItem.insertMany(built.docs);
    const items = inserted.map((d) => d.toObject({ flattenMaps: true }));
    const data = shapeOrderWithItems(response.data, items);
    return res.status(201).json({
      success: true,
      status: 201,
      data,
    });
  } catch (err) {
    await Order.findByIdAndDelete(orderId);
    return res.status(500).json({
      success: false,
      status: 500,
      error: "Failed to create order line items",
      details: err.message,
      type: "order_item_insert",
    });
  }
}

async function order_update(req, res) {
  const lines = parseOrderLineItems(req.body);
  const originalBody = req.body;
  req.body = normalizeOrderNumericFields(stripLineItemKeys(originalBody));
  delete req.body._id;

  /** Filled inside `afterUpdate` when post-order `transactionBulkCreate` runs */
  const postUpdateTransactions = { created: [], failed: [] };

  const response = await handleGenericUpdate(req, "order", {
    afterUpdate: async (record, orderReq) => {
      try {
        const transaction_number = record?.transaction_number;
        const deleteTransc =
          transaction_number ?
            await Transaction.deleteMany({ transaction_number })
          : { deletedCount: 0 };
        if (deleteTransc.deletedCount > 0) {
          console.log("✅ Transaction deleted:", deleteTransc.deletedCount);
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
              // sales
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
              // shipment
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
              // Sales Discount
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
              // accounts_id
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
          { stopOnError: true },
        );
        postUpdateTransactions.created = created;
        postUpdateTransactions.failed = failed;
        if (failed.length) {
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(
            req,
            `Post-order transaction bulk insert failed: ${JSON.stringify(failed)}`,
            ORDER_TRANSACTION_ERROR_LOG,
          );
        } else if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-order transaction error: ${e.message}`,
          ORDER_TRANSACTION_ERROR_LOG,
        );
      }
    },
    filter: { status: "active", deletedAt: null },
  });

  //response?.data?.transaction_number
  // console.log("___data_update", response?.data?.transaction_number);
  // return;

  req.body = originalBody;

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
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
      return res.status(built.error.status).json(built.error);
    }
    const previousItems = await OrderItem.find({ order_id: orderId }).lean();
    try {
      await OrderItem.deleteMany({ order_id: orderId });
      const inserted = await OrderItem.insertMany(built.docs);
      const items = inserted.map((d) => d.toObject({ flattenMaps: true }));
      const data = shapeOrderWithItems(response.data, items);
      return res.status(200).json({
        success: true,
        status: 200,
        data,
        created: postUpdateTransactions.created,
        failed: postUpdateTransactions.failed,
      });
    } catch (err) {
      if (previousItems.length > 0) {
        try {
          await OrderItem.insertMany(previousItems, { ordered: false });
        } catch (restoreErr) {
          console.error("Order item restore failed:", restoreErr);
        }
      }
      return res.status(500).json({
        success: false,
        status: 500,
        error: "Failed to replace order line items",
        details: err.message,
        type: "order_item_insert",
      });
    }
  }

  const items = await OrderItem.find({
    order_id: orderId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapeOrderWithItems(response.data, items);

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

const mongoose = require("mongoose");
const PurchaseOrder = require("../models/purchase_order");
const PurchaseOrderItem = require("../models/purchase_order_item");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
} = require("../utils/modelHelper");

/** e.g. product_id[0], qty[0], price[0] */
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
  if (productIdArray.length === 0) return [];
  return productIdArray
    .map((productId, index) => {
      const qty = parseFloat(String(qtyArray[index] ?? "").trim());
      const price = parseFloat(String(priceArray[index] ?? "").trim());
      const fromTotal = parseFloat(String(totalArray[index] ?? "").trim());
      const subtotal =
        Number.isFinite(fromTotal) ? fromTotal
        : Number.isFinite(qty) && Number.isFinite(price) ? qty * price
        : NaN;
      return { product_id: productId, qty, price, subtotal };
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
    if (/^(product_id|qty|price|total)\[\d+\]$/.test(k)) continue;
    if (["product_id[]", "qty[]", "price[]", "total[]"].includes(k)) continue;
    out[k] = body[k];
  }
  return out;
}

function collectLineItems(body) {
  let lines = parseBracketLineItems(body);
  if (lines.length === 0) lines = parseLegacyArrayLineItems(body);
  if (lines.length === 0) lines = parseProductIdsBodyArray(body);
  return lines;
}

function buildPurchaseOrderItemDocuments(poId, poSnapshot, lines, req) {
  const companyId = poSnapshot.company_id || req.user?.company_id;
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
    };
    if (companyId) doc.company_id = companyId;
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
    req.body = stripLineItemKeysFromBody(originalBody);
    delete req.body._id;

    const purchaseOrderResponse = await handleGenericCreate(
      req,
      "purchase_order",
      {
        afterCreate: async (record) => {
          console.log("✅ Purchase Order created:", record._id);
        },
      },
    );

    req.body = originalBody;

    if (!purchaseOrderResponse.success || !purchaseOrderResponse.data) {
      return res
        .status(purchaseOrderResponse.status || 400)
        .json(purchaseOrderResponse);
    }

    const poId = purchaseOrderResponse.data._id;
    const companyId =
      purchaseOrderResponse.data.company_id || req.user?.company_id;

    if (lines.length === 0) {
      return res.status(201).json({
        ...purchaseOrderResponse,
        status: 201,
        items: [],
      });
    }

    const purchaseOrderItems = [];
    for (const line of lines) {
      const itemData = {
        purchase_order_id: poId,
        product_id: String(line.product_id).trim(),
        qty: line.qty,
        price: line.price,
        subtotal: line.subtotal,
        status: "active",
      };
      if (companyId) itemData.company_id = companyId;

      const savedItemBody = req.body;
      req.body = itemData;
      const itemResponse = await handleGenericCreate(
        req,
        "purchase_order_item",
      );
      req.body = savedItemBody;

      if (!itemResponse.success || !itemResponse.data) {
        await PurchaseOrderItem.deleteMany({ purchase_order_id: poId });
        await PurchaseOrder.findByIdAndDelete(poId);
        return res.status(itemResponse.status || 400).json({
          success: false,
          status: itemResponse.status || 400,
          error: "Purchase order rolled back: line item failed",
          details: itemResponse.error || itemResponse.missing,
          lineItem: itemResponse,
        });
      }
      purchaseOrderItems.push(itemResponse.data);
    }

    const items_total = purchaseOrderItems.reduce(
      (s, it) => s + (Number(it.subtotal) || 0),
      0,
    );

    return res.status(201).json({
      ...purchaseOrderResponse,
      status: 201,
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
  req.body = stripLineItemKeysFromBody(originalBody);
  delete req.body._id;

  const response = await handleGenericUpdate(req, "purchase_order", {
    afterUpdate: async () => {},
    filter: { status: "active", deletedAt: null },
  });

  req.body = originalBody;

  if (!response || !response.success || !response.data) {
    return res
      .status(response && response.status ? response.status : 400)
      .json(response);
  }

  const poId = response.data._id;

  if (lines.length > 0) {
    const built = buildPurchaseOrderItemDocuments(
      poId,
      response.data,
      lines,
      req,
    );
    const previousItems = await PurchaseOrderItem.find({
      purchase_order_id: poId,
    }).lean();
    try {
      await PurchaseOrderItem.deleteMany({ purchase_order_id: poId });
      const inserted = await PurchaseOrderItem.insertMany(built.docs);
      const items = inserted.map((d) => d.toObject({ flattenMaps: true }));
      const data = shapePurchaseOrderWithItems(response.data, items);
      return res.status(200).json({
        success: true,
        status: 200,
        data,
      });
    } catch (err) {
      if (previousItems.length > 0) {
        try {
          await PurchaseOrderItem.insertMany(previousItems, {
            ordered: false,
          });
        } catch (restoreErr) {
          console.error("Purchase order item restore failed:", restoreErr);
        }
      }
      return res.status(500).json({
        success: false,
        status: 500,
        error: "Failed to replace purchase order line items",
        details: err.message,
        type: "purchase_order_item_insert",
      });
    }
  }

  const items = await PurchaseOrderItem.find({
    purchase_order_id: poId,
    status: "active",
    deletedAt: null,
  })
    .populate("product_id")
    .sort({ createdAt: 1 })
    .lean();

  const data = shapePurchaseOrderWithItems(response.data, items);
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

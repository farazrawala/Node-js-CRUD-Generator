const mongoose = require("mongoose");
const PurchaseOrder = require("../models/purchase_order");
const PurchaseOrderItem = require("../models/purchase_order_item");
const { handleGenericCreate } = require("../utils/modelHelper");

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
      Number.isFinite(fromTotal) ?
        fromTotal
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
    Array.isArray(body["qty[]"]) ? body["qty[]"] : [body["qty[]"]].filter(Boolean);
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
        Number.isFinite(fromTotal) ?
          fromTotal
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

module.exports = {
  purchaseOrderCreate,
  // purchase_orderUpdate,
  // purchase_orderById,
  // getAllpurchase_order,
  // getallpurchase_orderactive,
  // purchase_orderdelete,
  // findActiveBlogByTitle,
  // findBlogByParams,
};

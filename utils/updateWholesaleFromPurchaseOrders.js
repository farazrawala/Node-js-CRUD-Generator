const mongoose = require("mongoose");
const PurchaseOrderItem = require("../models/purchase_order_item");
const Product = require("../models/product");

function coalesceCompanyId(companyId) {
  if (companyId && typeof companyId === "object" && companyId._id) {
    return companyId._id;
  }
  return companyId;
}

function collectProductIdsFromLines(lines) {
  const set = new Set();
  for (const line of lines || []) {
    const pid = line?.product_id;
    if (pid == null) continue;
    const s =
      typeof pid === "object" && pid._id != null ?
        String(pid._id)
      : String(pid).trim();
    if (s && mongoose.Types.ObjectId.isValid(s)) set.add(s);
  }
  return [...set];
}

/**
 * Recompute weighted landed unit cost from all active PO lines for one product
 * and persist `wholesale_price` (same formula as PATCH …/wholesale-from-purchases).
 *
 * @param {string|mongoose.Types.ObjectId} productId
 * @param {{ companyId?: unknown, userId?: unknown }} [options]
 * @returns {Promise<object>}
 */
async function updateWholesalePriceForProduct(productId, options = {}) {
  const companyId =
    options.companyId != null ? coalesceCompanyId(options.companyId) : null;
  const userId = options.userId;

  const idStr = String(productId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(idStr)) {
    return { ok: false, skipped: "invalid_product_id", product_id: idStr };
  }

  const itemFilter = {
    product_id: idStr,
    status: "active",
    deletedAt: null,
  };
  if (
    companyId != null &&
    companyId !== "" &&
    mongoose.Types.ObjectId.isValid(String(companyId))
  ) {
    itemFilter.company_id = companyId;
  }

  const purchaseOrderItems = await PurchaseOrderItem.find(itemFilter).lean();
  if (purchaseOrderItems.length === 0) {
    return { ok: false, skipped: "no_purchase_lines", product_id: idStr };
  }

  let totalPurchaseValue = 0;
  let totalQty = 0;
  for (const item of purchaseOrderItems) {
    const qty = Number(item.qty);
    const subtotal = Number(item.subtotal);
    const lineShipping = Number(item.total_shipping);
    const lineValue =
      (Number.isFinite(subtotal) ? subtotal : 0) +
      (Number.isFinite(lineShipping) ? lineShipping : 0);
    if (Number.isFinite(qty) && qty > 0 && Number.isFinite(lineValue)) {
      totalPurchaseValue += lineValue;
      totalQty += qty;
    }
  }

  if (totalQty <= 0 || !Number.isFinite(totalPurchaseValue)) {
    return { ok: false, skipped: "invalid_totals", product_id: idStr };
  }

  const wholesale_price =
    Math.round((totalPurchaseValue / totalQty) * 100) / 100;

  const productFilter = {
    _id: idStr,
    deletedAt: null,
  };
  if (
    companyId != null &&
    companyId !== "" &&
    mongoose.Types.ObjectId.isValid(String(companyId))
  ) {
    productFilter.company_id = companyId;
  }

  const $set = { wholesale_price };
  if (userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    $set.updated_by = userId;
  }

  const result = await Product.updateOne(productFilter, { $set });
  if (!result.matchedCount) {
    return { ok: false, skipped: "product_not_found", product_id: idStr };
  }

  return {
    ok: true,
    product_id: idStr,
    wholesale_price,
    total_purchase_value: totalPurchaseValue,
    total_qty: totalQty,
    line_count: purchaseOrderItems.length,
  };
}

/**
 * After PO create/update: refresh `wholesale_price` for every product on the mutation.
 * Uses `lines` when non-empty; otherwise distinct `product_id` from persisted PO lines for `poId`.
 *
 * @param {{ lines?: unknown[], poId?: string|mongoose.Types.ObjectId, companyId?: unknown, userId?: unknown }} options
 * @returns {Promise<Array<{ product_id: string } & Record<string, unknown>>>}
 */
async function afterPurchaseOrderMutationSyncWholesale(options = {}) {
  const { lines, poId, companyId, userId } = options;
  let productIds = [];

  if (Array.isArray(lines) && lines.length > 0) {
    productIds = collectProductIdsFromLines(lines);
  } else {
    const idStr = poId != null ? String(poId).trim() : "";
    if (mongoose.Types.ObjectId.isValid(idStr)) {
      const distinctIds = await PurchaseOrderItem.distinct("product_id", {
        purchase_order_id: idStr,
        status: "active",
        deletedAt: null,
      });
      productIds = [
        ...new Set(
          distinctIds
            .map((x) => (x != null ? String(x) : ""))
            .filter((s) => mongoose.Types.ObjectId.isValid(s)),
        ),
      ];
    }
  }

  const results = [];
  for (const productId of productIds) {
    try {
      const r = await updateWholesalePriceForProduct(productId, {
        companyId,
        userId,
      });
      results.push({ product_id: productId, ...r });
    } catch (err) {
      console.error(
        "[afterPurchaseOrderMutationSyncWholesale]",
        productId,
        err?.message || err,
      );
      results.push({
        product_id: productId,
        ok: false,
        skipped: "error",
        error: err?.message || String(err),
      });
    }
  }
  return results;
}

module.exports = {
  updateWholesalePriceForProduct,
  collectProductIdsFromLines,
  afterPurchaseOrderMutationSyncWholesale,
};

const mongoose = require("mongoose");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const { coalesceObjectId } = require("./modelHelper");

/**
 * Centralized Weighted Average Cost (WAC) for `product.wholesale_price`.
 *
 * Single source of truth for the WAC formula across every stock-in flow
 * (purchase orders, purchase-return reversal, sales return, stock adjustment
 * increase, opening stock, manufacturing output, inventory import, …).
 *
 * Negative existing inventory is fully supported: quantities are signed and are
 * NEVER clamped with `Math.max(0, qty)`. Clamping was the historical bug that
 * produced an incorrect average whenever on-hand went negative.
 */

/** Round money / cost to 2 decimals (project convention). */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Pure weighted-average cost for a stock-IN layer.
 *
 *   existingValue = existingQty × existingCost        (signed)
 *   incomingValue = incomingQty × incomingCost
 *   newQty        = existingQty + incomingQty
 *   newCost       = (existingValue + incomingValue) / newQty
 *
 * Edge cases:
 *  - incomingQty <= 0  → stock-in only; returns existing cost unchanged (skipped).
 *  - existingQty == 0  → newCost = incomingCost.
 *  - existingQty < 0   → contributes to the average (NOT ignored).
 *  - newQty == 0       → division-by-zero guard; keeps previous WAC.
 *
 * @param {object} params
 * @param {number} params.existingQty  Signed on-hand BEFORE the inbound layer.
 * @param {number} params.existingCost Current WAC / wholesale unit price.
 * @param {number} params.incomingQty  Inbound quantity (> 0).
 * @param {number} params.incomingCost Inbound unit cost.
 * @returns {{ skipped: boolean, reason: string, newQty: number, newCost: number, existingValue: number, incomingValue: number }}
 */
function computeWeightedAverageCost({
  existingQty,
  existingCost,
  incomingQty,
  incomingCost,
}) {
  const exQty = toFiniteNumber(existingQty, 0);
  const exCost = toFiniteNumber(existingCost, 0);
  const inQty = toFiniteNumber(incomingQty, 0);
  const inCost = toFiniteNumber(incomingCost, 0);

  // Stock-in only: ignore non-positive incoming qty (Case 5).
  if (inQty <= 0) {
    return {
      skipped: true,
      reason: "incoming_qty_not_positive",
      newQty: round2(exQty),
      newCost: round2(exCost),
      existingValue: round2(exQty * exCost),
      incomingValue: 0,
    };
  }

  const existingValue = exQty * exCost;
  const incomingValue = inQty * inCost;
  const newQty = exQty + inQty;

  // Division-by-zero guard: keep previous WAC (Case 4).
  if (round2(newQty) === 0) {
    return {
      skipped: false,
      reason: "new_qty_zero_keep_previous",
      newQty: 0,
      newCost: round2(exCost),
      existingValue: round2(existingValue),
      incomingValue: round2(incomingValue),
    };
  }

  return {
    skipped: false,
    reason: "ok",
    newQty: round2(newQty),
    newCost: round2((existingValue + incomingValue) / newQty),
    existingValue: round2(existingValue),
    incomingValue: round2(incomingValue),
  };
}

/**
 * Pure inverse of a stock-IN layer (used when an inbound is undone / reversed,
 * e.g. PO delete, sales-return delete).
 *
 *   qtyBefore  = remainingQty + removedQty
 *   valueAfter = qtyBefore × currentCost − removedQty × removedCost
 *   newCost    = valueAfter / remainingQty
 *
 * @param {object} params
 * @param {number} params.remainingQty Signed on-hand AFTER the layer qty was removed.
 * @param {number} params.currentCost  Current WAC (still reflecting the layer).
 * @param {number} params.removedQty   Quantity of the layer being reversed (> 0).
 * @param {number} params.removedCost  Unit cost of the reversed layer.
 * @returns {{ skipped: boolean, reason: string, newCost: number }}
 */
function computeReverseWeightedAverageCost({
  remainingQty,
  currentCost,
  removedQty,
  removedCost,
}) {
  const remQty = toFiniteNumber(remainingQty, 0);
  const curCost = toFiniteNumber(currentCost, 0);
  const rmQty = toFiniteNumber(removedQty, 0);
  const rmCost = toFiniteNumber(removedCost, 0);

  if (rmQty <= 0) {
    return {
      skipped: true,
      reason: "removed_qty_not_positive",
      newCost: round2(curCost),
    };
  }

  // Division-by-zero guard: keep previous WAC.
  if (round2(remQty) === 0) {
    return {
      skipped: false,
      reason: "remaining_qty_zero_keep_previous",
      newCost: round2(curCost),
    };
  }

  const qtyBefore = remQty + rmQty;
  const valueAfter = qtyBefore * curCost - rmQty * rmCost;
  return {
    skipped: false,
    reason: "ok",
    newCost: round2(valueAfter / remQty),
  };
}

/**
 * Signed sum of `warehouse_inventory.quantity` for a product (tenant-scoped).
 * NOT clamped — negative on-hand is preserved for correct WAC.
 *
 * @param {*} productId
 * @param {*} companyId
 * @param {import("mongoose").ClientSession|null} [session]
 * @param {*} [warehouseId] Optional: scope to a single warehouse.
 */
async function sumWarehouseQtySigned(
  productId,
  companyId,
  session = null,
  warehouseId = null,
) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !cid) return 0;

  const match = {
    product_id: pid,
    company_id: cid,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
  const wid = warehouseId ? coalesceObjectId(warehouseId) : null;
  if (wid) match.warehouse_id = wid;

  let agg = WarehouseInventory.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ]);
  if (session) agg = agg.session(session);
  const rows = await agg;
  return round2(rows[0]?.total || 0);
}

/**
 * Generic, transaction-safe WAC update for ANY stock-in transaction.
 *
 * Reads signed on-hand + current `product.wholesale_price`, computes the new
 * weighted average, and persists it (only when it actually changes) inside the
 * caller's session. Use from purchase orders, sales returns, stock adjustments
 * (increase), opening stock, manufacturing output, inventory import, etc.
 *
 * Call this BEFORE the warehouse on-hand is increased by the inbound layer (or
 * pass `existingQty` explicitly) so the average reflects the prior balance.
 *
 * @param {object} params
 * @param {*} params.productId
 * @param {*} params.companyId
 * @param {number} params.incomingQty   Inbound quantity (> 0).
 * @param {number} params.incomingCost  Inbound unit cost.
 * @param {number} [params.existingQty] Optional signed on-hand override (else read from warehouse_inventory).
 * @param {*} [params.warehouseId]      Optional: scope existing on-hand to one warehouse.
 * @param {import("mongoose").ClientSession|null} [params.session]
 * @param {object|null} [params.productDoc] Optional preloaded `{ _id, product_name, wholesale_price }`.
 * @returns {Promise<object>} Audit row describing the change (or `{ skipped: true }`).
 */
async function updateWeightedAverageCost({
  productId,
  companyId,
  incomingQty,
  incomingCost,
  existingQty = undefined,
  warehouseId = null,
  session = null,
  productDoc = null,
}) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !cid) {
    throw new Error("productId and companyId are required for WAC update");
  }

  const inQty = toFiniteNumber(incomingQty, 0);
  if (inQty <= 0) {
    return {
      skipped: true,
      reason: "incoming_qty_not_positive",
      product_id: String(pid),
    };
  }

  const existingSignedQty =
    existingQty !== undefined && existingQty !== null ?
      toFiniteNumber(existingQty, 0)
    : await sumWarehouseQtySigned(pid, cid, session, warehouseId);

  let product = productDoc;
  if (!product) {
    let q = Product.findOne({
      _id: pid,
      company_id: cid,
      status: "active",
      deletedAt: null,
    }).select("product_name wholesale_price");
    if (session) q = q.session(session);
    product = await q.lean();
  }
  if (!product) {
    throw new Error(`Product not found for WAC update (id ${String(pid)})`);
  }

  const existingCost = toFiniteNumber(product.wholesale_price, 0);
  const result = computeWeightedAverageCost({
    existingQty: existingSignedQty,
    existingCost,
    incomingQty: inQty,
    incomingCost,
  });

  const newCost = result.newCost;
  const changed = round2(existingCost) !== round2(newCost);

  if (changed) {
    const updated = await Product.findOneAndUpdate(
      { _id: pid, company_id: cid, status: "active", deletedAt: null },
      { $set: { wholesale_price: newCost } },
      { new: true, ...(session ? { session } : {}) },
    ).lean();
    if (!updated) {
      throw new Error(
        `Failed to update wholesale_price for product (id ${String(pid)})`,
      );
    }
  }

  return {
    skipped: false,
    changed,
    reason: result.reason,
    product_id: String(pid),
    product_name: product.product_name,
    existing_qty: round2(existingSignedQty),
    incoming_qty: round2(inQty),
    total_qty: result.newQty,
    wholesale_price_before: round2(existingCost),
    wholesale_price: newCost,
    existing_value: result.existingValue,
    incoming_value: result.incomingValue,
  };
}

module.exports = {
  round2,
  computeWeightedAverageCost,
  computeReverseWeightedAverageCost,
  sumWarehouseQtySigned,
  updateWeightedAverageCost,
};

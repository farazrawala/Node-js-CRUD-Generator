const mongoose = require("mongoose");
const Product = require("../models/product");
const { coalesceObjectId } = require("./modelHelper");
const { round2, sumWarehouseQtySigned, computeWeightedAverageCost } = require("./weightedAverageCost");

/**
 * Full ledger replay for product WAC (`wholesale_price`).
 *
 * Rebuilds qty / average cost from transaction #1 by replaying every active
 * WAC-affecting inbound (purchase, sales return) and WAC-neutral outbound
 * (sale, purchase return) in chronological order.
 *
 * `grandTotal` is kept as a running float during replay; `round2` is applied
 * only when persisting WAC or formatting inventory value for output.
 */

const WAC_INBOUND_TYPES = new Set(["purchase", "sales_return"]);
const WAC_OUTBOUND_NEUTRAL_TYPES = new Set(["sale", "purchase_return"]);

/**
 * Display / API inventory value — never use as an intermediate in replay math.
 * Uses round2(qty × WAC) only — never round the float `grandTotal` for display.
 * @param {number} qty Signed on-hand (warehouse qty for API output)
 * @param {number} wac  Weighted average unit cost (round2 for display)
 */
function displayInventoryValue(qty, wac) {
  const q = round2(qty);
  if (q === 0) return 0;
  return round2(q * round2(wac));
}

/**
 * Replay an ordered list of ledger events from transaction #1.
 *
 * @param {Array<{ type: string, qty: number, unitCost?: number }>} events
 * @returns {{ qty: number, wac: number, grandTotal: number, inventoryValue: number, eventCount: number }}
 */
function replayWacLedger(events) {
  let qty = 0;
  let grandTotal = 0;
  let avg = 0;

  for (const ev of events || []) {
    const type = String(ev?.type || "").trim();
    const moveQty = Number(ev?.qty) || 0;
    if (moveQty <= 0) continue;

    if (WAC_INBOUND_TYPES.has(type)) {
      const unitCost = Number(ev.unitCost) || 0;
      grandTotal += moveQty * unitCost;
      qty += moveQty;
      avg = qty !== 0 ? grandTotal / qty : 0;
      continue;
    }

    if (WAC_OUTBOUND_NEUTRAL_TYPES.has(type)) {
      grandTotal -= moveQty * avg;
      qty -= moveQty;
      if (round2(qty) === 0) {
        qty = 0;
        grandTotal = 0;
        avg = 0;
      } else {
        avg = grandTotal / qty;
      }
    }
  }

  const wac = qty !== 0 ? round2(avg) : 0;
  return {
    qty: round2(qty),
    wac,
    grandTotal,
    inventoryValue: displayInventoryValue(qty, wac),
    eventCount: (events || []).length,
  };
}

/**
 * Decide which WAC to persist after a replay when warehouse on-hand may differ
 * from ledger replay qty (e.g. replay-history PO delete keeps stock but drops
 * the purchase from the event log).
 *
 * @param {object} params
 * @param {{ qty: number, wac: number }} params.replay
 * @param {number} params.warehouseQty Signed warehouse on-hand after the txn
 * @param {number} params.wholesaleBefore Current stored WAC before this txn
 * @param {boolean} [params.preserveWholesalePrice] PO delete replay-history
 * @param {{ incomingQty: number, incomingCost: number }|null} [params.inboundLayer] PO create inbound
 * @returns {number} WAC to persist (round2)
 */
function resolvePersistedWac({
  replay,
  warehouseQty,
  wholesaleBefore,
  preserveWholesalePrice = false,
  inboundLayer = null,
}) {
  if (preserveWholesalePrice) {
    return round2(wholesaleBefore);
  }

  const ledgerQty = round2(replay.qty);
  const whQty = round2(warehouseQty);
  if (ledgerQty === whQty) {
    return replay.wac;
  }

  const inQty = Number(inboundLayer?.incomingQty) || 0;
  const inCost = Number(inboundLayer?.incomingCost) || 0;
  if (inQty > 0 && Number.isFinite(inCost)) {
    const existingQty = round2(whQty - inQty);
    return computeWeightedAverageCost({
      existingQty,
      existingCost: wholesaleBefore,
      incomingQty: inQty,
      incomingCost: inCost,
    }).newCost;
  }

  // PO edit while ledger is out of sync with warehouse — keep current WAC.
  return round2(wholesaleBefore);
}

function parseWarehouseId(line) {
  const raw = line?.warehouse_id != null ? String(line.warehouse_id).trim() : "";
  return raw && mongoose.Types.ObjectId.isValid(raw) ? raw : null;
}

function eventSortKey(dateLike, tieBreak = "") {
  const t =
    dateLike instanceof Date ? dateLike.getTime()
    : dateLike ? new Date(dateLike).getTime()
    : 0;
  return { t: Number.isFinite(t) ? t : 0, tie: String(tieBreak) };
}

/**
 * Load all active WAC ledger events for one product (tenant-scoped), chronological.
 * Soft-deleted parents/lines are excluded — deleting a PO removes it from replay.
 */
async function loadWacLedgerEventsForProduct(productId, companyId, session = null) {
  const pid = coalesceObjectId(productId);
  const cid = coalesceObjectId(companyId);
  if (!pid || !cid) return [];

  const PurchaseOrderItem = require("../models/purchase_order_item");
  const PurchaseOrder = require("../models/purchase_order");
  const SalesReturnItem = require("../models/sales_return_item");
  const SalesReturn = require("../models/sales_return");
  const PurchaseReturnItem = require("../models/purchase_return_item");
  const PurchaseReturn = require("../models/purchase_return");
  const OrderItem = require("../models/order_item");
  const Order = require("../models/order");

  const sess = session ? { session } : {};
  const events = [];

  // --- Purchases (one event per PO, weighted unit cost across warehouse lines) ---
  let poItems = PurchaseOrderItem.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("purchase_order_id qty price warehouse_id createdAt")
    .lean();
  if (session) poItems = poItems.session(session);
  poItems = await poItems;

  const poItemsWithWh = poItems.filter((row) => parseWarehouseId(row));
  const poIds = [
    ...new Set(poItemsWithWh.map((row) => String(row.purchase_order_id))),
  ];

  const poCreatedAt = new Map();
  if (poIds.length) {
    let poRows = PurchaseOrder.find({
      _id: { $in: poIds },
      company_id: cid,
      status: "active",
      deletedAt: null,
    })
      .select("_id createdAt")
      .lean();
    if (session) poRows = poRows.session(session);
    poRows = await poRows;
    for (const po of poRows) {
      poCreatedAt.set(String(po._id), po.createdAt);
    }
  }

  const purchaseAgg = new Map();
  for (const row of poItemsWithWh) {
    const poId = String(row.purchase_order_id);
    if (!poCreatedAt.has(poId)) continue;
    const qty = Number(row.qty) || 0;
    const price = Number(row.price) || 0;
    if (qty <= 0 || price < 0) continue;

    const entry = purchaseAgg.get(poId) || {
      qty: 0,
      extendedCost: 0,
      sortAt: poCreatedAt.get(poId) || row.createdAt,
      refId: poId,
    };
    entry.qty += qty;
    entry.extendedCost += qty * price;
    purchaseAgg.set(poId, entry);
  }

  for (const agg of purchaseAgg.values()) {
    if (agg.qty <= 0) continue;
    events.push({
      type: "purchase",
      qty: agg.qty,
      unitCost: agg.extendedCost / agg.qty,
      sortAt: agg.sortAt,
      refId: agg.refId,
    });
  }

  // --- Sales returns (inbound at frozen cost) ---
  let srItems = SalesReturnItem.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("sales_return_id qty cost_price_at_return price warehouse_id createdAt")
    .lean();
  if (session) srItems = srItems.session(session);
  srItems = await srItems;

  const srIds = [...new Set(srItems.map((r) => String(r.sales_return_id)))];
  const srCreatedAt = new Map();
  if (srIds.length) {
    let srRows = SalesReturn.find({
      _id: { $in: srIds },
      company_id: cid,
      status: "active",
      deletedAt: null,
    })
      .select("_id createdAt")
      .lean();
    if (session) srRows = srRows.session(session);
    srRows = await srRows;
    for (const sr of srRows) {
      srCreatedAt.set(String(sr._id), sr.createdAt);
    }
  }

  for (const row of srItems) {
    if (!parseWarehouseId(row)) continue;
    const srId = String(row.sales_return_id);
    if (!srCreatedAt.has(srId)) continue;
    const qty = Number(row.qty) || 0;
    if (qty <= 0) continue;
    const unitCost =
      Number.isFinite(Number(row.cost_price_at_return)) ?
        Number(row.cost_price_at_return)
      : Number(row.price) || 0;
    events.push({
      type: "sales_return",
      qty,
      unitCost,
      sortAt: srCreatedAt.get(srId) || row.createdAt,
      refId: srId,
    });
  }

  // --- Purchase returns (WAC-neutral outbound) ---
  let prItems = PurchaseReturnItem.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("purchase_return_id qty warehouse_id createdAt")
    .lean();
  if (session) prItems = prItems.session(session);
  prItems = await prItems;

  const prIds = [...new Set(prItems.map((r) => String(r.purchase_return_id)))];
  const prCreatedAt = new Map();
  if (prIds.length) {
    let prRows = PurchaseReturn.find({
      _id: { $in: prIds },
      company_id: cid,
      status: "active",
      deletedAt: null,
    })
      .select("_id createdAt")
      .lean();
    if (session) prRows = prRows.session(session);
    prRows = await prRows;
    for (const pr of prRows) {
      prCreatedAt.set(String(pr._id), pr.createdAt);
    }
  }

  for (const row of prItems) {
    if (!parseWarehouseId(row)) continue;
    const prId = String(row.purchase_return_id);
    if (!prCreatedAt.has(prId)) continue;
    const qty = Number(row.qty) || 0;
    if (qty <= 0) continue;
    events.push({
      type: "purchase_return",
      qty,
      sortAt: prCreatedAt.get(prId) || row.createdAt,
      refId: prId,
    });
  }

  // --- Sales (WAC-neutral outbound) ---
  let orderItems = OrderItem.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("order_id qty createdAt")
    .lean();
  if (session) orderItems = orderItems.session(session);
  orderItems = await orderItems;

  const orderIds = [...new Set(orderItems.map((r) => String(r.order_id)))];
  const orderCreatedAt = new Map();
  if (orderIds.length) {
    let orderRows = Order.find({
      _id: { $in: orderIds },
      company_id: cid,
      status: "active",
      deletedAt: null,
    })
      .select("_id createdAt")
      .lean();
    if (session) orderRows = orderRows.session(session);
    orderRows = await orderRows;
    for (const order of orderRows) {
      orderCreatedAt.set(String(order._id), order.createdAt);
    }
  }

  for (const row of orderItems) {
    const orderId = String(row.order_id);
    if (!orderCreatedAt.has(orderId)) continue;
    const qty = Number(row.qty) || 0;
    if (qty <= 0) continue;
    events.push({
      type: "sale",
      qty,
      sortAt: orderCreatedAt.get(orderId) || row.createdAt,
      refId: orderId,
    });
  }

  events.sort((a, b) => {
    const ka = eventSortKey(a.sortAt, a.refId);
    const kb = eventSortKey(b.sortAt, b.refId);
    if (ka.t !== kb.t) return ka.t - kb.t;
    return ka.tie.localeCompare(kb.tie);
  });

  return events;
}

/**
 * Full ledger replay for one or more products; persists `product.wholesale_price`.
 *
 * @param {object} params
 * @param {string[]} params.productIds
 * @param {*} params.companyId
 * @param {import('mongoose').ClientSession|null} [params.session]
 * @param {object} [params.req]
 * @param {string[]} [params.logTags]
 * @param {string} [params.fallbackUrl]
 * @param {Function} [params.logChange] async (req, { productIdStr, productName, wholesaleBefore, averageCost, ... })
 * @param {boolean} [params.preserveWholesalePrice] When true (PO delete replay-history),
 *   remove the PO from the event log but leave `product.wholesale_price` unchanged.
 * @param {Record<string, { incomingQty: number, incomingCost: number }>} [params.inboundLayersByProduct]
 *   Per-product inbound layer for PO create (incremental forward when ledger ≠ warehouse).
 */
async function applyWacLedgerReplayForProducts({
  productIds = [],
  companyId,
  session = null,
  req = null,
  logTags = ["purchase_order", "wac_replay"],
  fallbackUrl = "/api/purchase_order/update",
  logChange = null,
  preserveWholesalePrice = false,
  inboundLayersByProduct = null,
} = {}) {
  const cid = coalesceObjectId(companyId);
  if (!cid) {
    throw new Error("companyId is required for WAC ledger replay");
  }

  const uniqueIds = [
    ...new Set(
      (productIds || [])
        .map((id) => String(id || "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id)),
    ),
  ];

  const wholesaleUpdates = [];

  for (const productIdStr of uniqueIds) {
    const pid = coalesceObjectId(productIdStr);
    const events = await loadWacLedgerEventsForProduct(pid, cid, session);
    const replay = replayWacLedger(events);
    const warehouseQty = await sumWarehouseQtySigned(pid, cid, session);

    let productQuery = Product.findOne({
      _id: pid,
      company_id: cid,
      status: "active",
      deletedAt: null,
    }).select("product_name wholesale_price");
    if (session) productQuery = productQuery.session(session);
    const productDoc = await productQuery.lean();
    if (!productDoc) {
      throw new Error(
        `Product not found for WAC ledger replay (id ${productIdStr})`,
      );
    }

    const wholesaleBefore = Number(productDoc.wholesale_price) || 0;
    const inboundLayer =
      inboundLayersByProduct && inboundLayersByProduct[productIdStr] ?
        inboundLayersByProduct[productIdStr]
      : null;
    const averageCost = resolvePersistedWac({
      replay,
      warehouseQty,
      wholesaleBefore,
      preserveWholesalePrice,
      inboundLayer,
    });
    const ledgerAligned = round2(replay.qty) === round2(warehouseQty);
    const changed = round2(wholesaleBefore) !== round2(averageCost);

    if (changed) {
      const updated = await Product.findOneAndUpdate(
        { _id: pid, company_id: cid, status: "active", deletedAt: null },
        { $set: { wholesale_price: averageCost } },
        { new: true, ...(session ? { session } : {}) },
      ).lean();
      if (!updated) {
        throw new Error(
          `Failed to update wholesale_price after WAC replay (id ${productIdStr})`,
        );
      }
    }

    if (typeof logChange === "function" && changed) {
      await logChange(req, {
        productIdStr,
        productName: productDoc.product_name,
        wholesaleBefore,
        averageCost,
        companyId: cid,
        mongoSession: session,
        fallbackUrl,
        logTags,
      });
    }

    wholesaleUpdates.push({
      product_id: productIdStr,
      product_name: productDoc.product_name,
      replay_qty: replay.qty,
      warehouse_qty: warehouseQty,
      grand_total: replay.grandTotal,
      replay_wac: replay.wac,
      inventory_value: displayInventoryValue(warehouseQty, averageCost),
      wholesale_price_before: round2(wholesaleBefore),
      wholesale_price: averageCost,
      changed,
      direction:
        preserveWholesalePrice ?
          "wac_ledger_replay_delete_preserve"
        : ledgerAligned ?
          "wac_ledger_replay"
        : inboundLayer ?
          "wac_ledger_replay_inbound_forward"
        : "wac_ledger_replay_preserve_diverged",
      event_count: replay.eventCount,
      wholesale_price_preserved:
        preserveWholesalePrice || (!ledgerAligned && !inboundLayer),
      ledger_qty: replay.qty,
    });
  }

  return wholesaleUpdates;
}

module.exports = {
  WAC_INBOUND_TYPES,
  WAC_OUTBOUND_NEUTRAL_TYPES,
  displayInventoryValue,
  replayWacLedger,
  resolvePersistedWac,
  loadWacLedgerEventsForProduct,
  applyWacLedgerReplayForProducts,
};

const mongoose = require("mongoose");
const { logWarehouseInventoryChange } = require("../utils/warehouseInventoryLogs");

function toObjectId(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(s);
}

function roundQty(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parseWarehouseId(line) {
  const raw = line?.warehouse_id != null ? String(line.warehouse_id).trim() : "";
  return raw && mongoose.Types.ObjectId.isValid(raw) ? raw : null;
}

function parsePositiveQty(line) {
  const q = Number(line?.qty);
  return Number.isFinite(q) && q > 0 ? q : null;
}

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      index: true,
    },

    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      index: true,
    },

    quantity: {
      // No `min: 0` — oversell (negative on-hand) is allowed when a company
      // enables it; the JS guards in `applyQuantityDelta` still block negative
      // for every normal flow unless `allowNegative` is explicitly passed.
      type: Number,
      default: 0,
      required: true,
    },

    last_purchase_order_item: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "purchase_order_item",
      field_name: "Last Purchase Order Item",
    },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

modelSchema.index(
  { company_id: 1, product_id: 1, warehouse_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      company_id: { $exists: true, $ne: null },
      deletedAt: null,
    },
  },
);

modelSchema.index({ company_id: 1, warehouse_id: 1 });

/**
 * Find active row filter for company + product + warehouse.
 */
modelSchema.statics.activeRowFilter = function (productId, warehouseId, companyId) {
  const pid = toObjectId(productId);
  const wid = toObjectId(warehouseId);
  const cid = toObjectId(companyId);
  if (!pid || !wid || !cid) return null;
  return {
    product_id: pid,
    warehouse_id: wid,
    company_id: cid,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };
};

/**
 * Upsert one row: add `qtyDelta` to existing quantity, or insert with `quantity = qtyDelta`.
 * Negative `qtyDelta` subtracts (throws if result &lt; 0 or row missing on subtract).
 *
 * @returns {Promise<object|null>} Change audit object, or null when delta is 0
 */
modelSchema.statics.applyQuantityDelta = async function ({
  productId,
  warehouseId,
  companyId,
  qtyDelta,
  lastLineItemId = null,
  userId = null,
  session = null,
  req = null,
  logContext = null,
  allowNegative = false,
} = {}) {
  const delta = roundQty(qtyDelta);
  if (!Number.isFinite(delta) || delta === 0) return null;

  const filter = this.activeRowFilter(productId, warehouseId, companyId);
  if (!filter) {
    throw new Error(
      "Valid product_id, warehouse_id, and company_id are required for warehouse inventory",
    );
  }

  let rowQuery = this.findOne(filter);
  if (session) rowQuery = rowQuery.session(session);
  let row = await rowQuery;

  if (row) {
    const previousQty = Number(row.quantity) || 0;
    const nextQty = roundQty(previousQty + delta);
    // Only an OUTBOUND (delta < 0) can be blocked for insufficient stock.
    // An inbound (delta > 0) must never be rejected — even when on-hand is
    // already negative, adding stock is a legitimate recovery toward zero
    // (e.g. sales return / purchase into an oversold balance).
    if (delta < 0 && nextQty < 0 && !allowNegative) {
      throw new Error(
        `Insufficient warehouse inventory quantity (need ${Math.abs(delta)}, available ${previousQty})`,
      );
    }
    row.quantity = nextQty;
    if (lastLineItemId && delta > 0) {
      row.last_purchase_order_item = lastLineItemId;
    }
    if (userId) row.updated_by = userId;
    await row.save(session ? { session } : {});
    const change = {
      product_id: String(filter.product_id),
      warehouse_id: String(filter.warehouse_id),
      previous_quantity: previousQty,
      quantity: nextQty,
      qty_delta: delta,
      warehouse_inventory_id: row._id,
    };
    await logWarehouseInventoryChange(req, change, filter.company_id, logContext, session);
    return change;
  }

  if (delta < 0 && !allowNegative) {
    throw new Error("Insufficient warehouse inventory to subtract stock");
  }

  const doc = {
    product_id: filter.product_id,
    warehouse_id: filter.warehouse_id,
    company_id: filter.company_id,
    quantity: delta,
    status: "active",
    deletedAt: null,
    ...(lastLineItemId ? { last_purchase_order_item: lastLineItemId } : {}),
    ...(userId ? { created_by: userId, updated_by: userId } : {}),
  };

  if (session) {
    const [created] = await this.create([doc], { session });
    row = created;
  } else {
    row = await this.create(doc);
  }

  const change = {
    product_id: String(filter.product_id),
    warehouse_id: String(filter.warehouse_id),
    previous_quantity: 0,
    quantity: delta,
    qty_delta: delta,
    warehouse_inventory_id: row._id,
  };
  await logWarehouseInventoryChange(req, change, filter.company_id, logContext, session);
  return change;
};

/**
 * Plan outbound qty across one or more warehouses (preferred first, then highest on-hand).
 * @returns {Promise<Array<{ warehouse_id: string, quantity: number }>>}
 */
modelSchema.statics.planOutboundAllocation = async function ({
  productId,
  companyId,
  qtyNeeded,
  preferredWarehouseId = null,
  session = null,
  allowNegative = false,
  fallbackWarehouseId = null,
} = {}) {
  const qty = roundQty(qtyNeeded);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error("Invalid quantity for warehouse allocation");
  }

  const pid = toObjectId(productId);
  const cid = toObjectId(companyId);
  if (!pid || !cid) {
    throw new Error(
      "product_id and company_id are required for warehouse allocation",
    );
  }

  let whQuery = this.find({
    product_id: pid,
    company_id: cid,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    quantity: { $gt: 0 },
  }).select("warehouse_id quantity");
  if (session) whQuery = whQuery.session(session);
  const rows = await whQuery.lean();

  const pref =
    (
      preferredWarehouseId &&
      mongoose.Types.ObjectId.isValid(String(preferredWarehouseId).trim())
    ) ?
      String(preferredWarehouseId).trim()
    : null;

  const sorted = [...rows].sort((a, b) => {
    const aId = String(a.warehouse_id);
    const bId = String(b.warehouse_id);
    if (pref) {
      if (aId === pref && bId !== pref) return -1;
      if (bId === pref && aId !== pref) return 1;
    }
    return (Number(b.quantity) || 0) - (Number(a.quantity) || 0);
  });

  let remaining = qty;
  const allocations = [];
  for (const row of sorted) {
    if (remaining <= 0) break;
    const onHand = roundQty(Number(row.quantity) || 0);
    if (onHand <= 0) continue;
    const take = roundQty(Math.min(remaining, onHand));
    allocations.push({
      warehouse_id: String(row.warehouse_id),
      quantity: take,
    });
    remaining = roundQty(remaining - take);
  }

  if (remaining > 0.0001) {
    // Oversell: when the company allows insufficient-stock checkout, absorb the
    // shortfall into a single warehouse (preferred → explicit fallback → the
    // warehouse we already drew from) and let its on-hand go negative.
    if (allowNegative) {
      const fallback =
        (
          fallbackWarehouseId &&
          mongoose.Types.ObjectId.isValid(String(fallbackWarehouseId).trim())
        ) ?
          String(fallbackWarehouseId).trim()
        : null;
      const shortfallWarehouseId =
        pref || fallback || (sorted[0] && String(sorted[0].warehouse_id)) || null;

      if (!shortfallWarehouseId) {
        const err = new Error(
          `Cannot oversell product ${String(pid)}: no warehouse available to absorb negative stock`,
        );
        err.clientPayload = {
          success: false,
          status: 400,
          error: "No warehouse for oversell",
          details: err.message,
          type: "validation",
          qty_needed: qty,
          product_id: String(pid),
          company_id: String(cid),
        };
        throw err;
      }

      const existing = allocations.find(
        (a) => String(a.warehouse_id) === shortfallWarehouseId,
      );
      if (existing) {
        existing.quantity = roundQty(existing.quantity + remaining);
      } else {
        allocations.push({
          warehouse_id: shortfallWarehouseId,
          quantity: roundQty(remaining),
        });
      }
      remaining = 0;
      return allocations;
    }

    const totalAvailable = roundQty(qty - remaining);
    const err = new Error(
      `Insufficient warehouse inventory for product ${String(pid)}: need ${qty}, available ${totalAvailable} across warehouses`,
    );
    err.clientPayload = {
      success: false,
      status: 400,
      error: "Insufficient stock",
      details: err.message,
      type: "validation",
      qty_needed: qty,
      qty_available: totalAvailable,
      product_id: String(pid),
      company_id: String(cid),
      preferred_warehouse_id: pref,
    };
    throw err;
  }

  return allocations;
};

/**
 * Subtract outbound qty from warehouse_inventory, splitting across warehouses when needed.
 * @returns {Promise<{ allocations: object[], stockChanges: object[] }>}
 */
modelSchema.statics.applySplitWarehouseOutbound = async function ({
  productId,
  companyId,
  qtyNeeded,
  preferredWarehouseId = null,
  userId = null,
  session = null,
  req = null,
  logContext = null,
  allowNegative = false,
  fallbackWarehouseId = null,
} = {}) {
  const allocations = await this.planOutboundAllocation({
    productId,
    companyId,
    qtyNeeded,
    preferredWarehouseId,
    session,
    allowNegative,
    fallbackWarehouseId: fallbackWarehouseId || preferredWarehouseId,
  });

  const stockChanges = [];
  for (const alloc of allocations) {
    const change = await this.applyQuantityDelta({
      productId,
      warehouseId: alloc.warehouse_id,
      companyId,
      qtyDelta: -alloc.quantity,
      userId,
      session,
      req,
      logContext,
      allowNegative,
    });
    if (change) {
      stockChanges.push({ ...change, source: "warehouse_inventory" });
    }
  }

  return { allocations, stockChanges };
};

/**
 * Generic warehouse stock from document lines (purchase return, PO, etc.).
 *
 * | Step | When | Op |
 * |------|------|-----|
 * | 1 | `reverseLines` non-empty | Subtract each line's qty from matching warehouse row |
 * | 2 | `inboundLines` | Add qty per line with valid `warehouse_id` (find → update or insert) |
 *
 * Lines need `product_id`, optional `warehouse_id`, and `qty`. Pair with `savedLineItemRows[i]`
 * to set `last_purchase_order_item` on inbound inserts (optional).
 *
 * @param {object} options
 * @param {object[]} options.inboundLines
 * @param {object[]} [options.savedLineItemRows] Same order/length as inbound lines
 * @param {object[]} [options.reverseLines] Lines to subtract before inbound (e.g. PO line replace)
 * @param {*} options.companyId
 * @param {import("mongoose").ClientSession|null} [options.session]
 * @param {*} [options.userId]
 * @param {string} [options.auditSource] Default `warehouse_inventory`
 * @param {boolean} [options.allowNegativeReverse] Allow `reverseLines` outbound to drive
 *   on-hand negative (default `true`). Reversing a recorded inbound is bookkeeping, not a sale.
 * @returns {Promise<object[]>} Audit entries (`source` set on each)
 */
modelSchema.statics.applyStockChangesFromLines = async function ({
  inboundLines = [],
  savedLineItemRows = [],
  reverseLines = [],
  companyId,
  session = null,
  userId = null,
  auditSource = "warehouse_inventory",
  req = null,
  logContext = null,
  // Reversing a previously-recorded inbound (e.g. PO edit/delete) is a
  // bookkeeping correction, not a real sale. It MUST be allowed to drive
  // on-hand negative — otherwise a PO could never be edited/deleted once any
  // of its received stock was sold. Negative on-hand is fully supported by the
  // weighted-average-cost logic, so this is safe.
  allowNegativeReverse = true,
} = {}) {
  const stockChangeAuditLog = [];

  for (const previousLine of reverseLines) {
    const warehouseIdToReverse = parseWarehouseId(previousLine);
    const quantityToReverse = parsePositiveQty(previousLine);
    if (!warehouseIdToReverse || quantityToReverse == null) continue;

    const reverseChanges = await this.applySplitWarehouseOutbound({
      productId: previousLine.product_id,
      companyId,
      qtyNeeded: quantityToReverse,
      preferredWarehouseId: warehouseIdToReverse,
      userId,
      session,
      req,
      logContext,
      allowNegative: allowNegativeReverse,
    });
    for (const row of reverseChanges.stockChanges || []) {
      stockChangeAuditLog.push({ ...row, source: auditSource });
    }
  }

  const pairedLineCount = Math.min(
    (inboundLines || []).length,
    (savedLineItemRows || []).length,
  );

  for (let lineIndex = 0; lineIndex < pairedLineCount; lineIndex++) {
    const inboundLine = inboundLines[lineIndex];
    const targetWarehouseId = parseWarehouseId(inboundLine);
    const receivedQuantity = parsePositiveQty(inboundLine);
    if (!targetWarehouseId || receivedQuantity == null) continue;

    const savedLineRow = savedLineItemRows[lineIndex];

    const warehouseInventoryChange = await this.applyQuantityDelta({
      productId: inboundLine.product_id,
      warehouseId: targetWarehouseId,
      companyId,
      qtyDelta: receivedQuantity,
      lastLineItemId: savedLineRow?._id,
      userId,
      session,
      req,
      logContext,
    });

    if (warehouseInventoryChange) {
      stockChangeAuditLog.push({
        ...warehouseInventoryChange,
        source: auditSource,
      });
    }
  }

  return stockChangeAuditLog;
};

const MODEL = mongoose.model("warehouse_inventory", modelSchema);

module.exports = MODEL;

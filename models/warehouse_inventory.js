const mongoose = require("mongoose");

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
      type: Number,
      default: 0,
      min: 0,
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
    if (nextQty < 0) {
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
    return {
      product_id: String(filter.product_id),
      warehouse_id: String(filter.warehouse_id),
      previous_quantity: previousQty,
      quantity: nextQty,
      qty_delta: delta,
      warehouse_inventory_id: row._id,
    };
  }

  if (delta < 0) {
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

  return {
    product_id: String(filter.product_id),
    warehouse_id: String(filter.warehouse_id),
    previous_quantity: 0,
    quantity: delta,
    qty_delta: delta,
    warehouse_inventory_id: row._id,
  };
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
} = {}) {
  const allocations = await this.planOutboundAllocation({
    productId,
    companyId,
    qtyNeeded,
    preferredWarehouseId,
    session,
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

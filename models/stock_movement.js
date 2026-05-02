const mongoose = require("mongoose");

/** How reference / line linkage is interpreted (polymorphic ids, no refPath). */
const SOURCE_TYPES = [
  "purchase_order_item",
  "order_item",
  "adjustment",
  "manual",
];

function docHasId(v) {
  if (v == null || v === "") return false;
  if (v instanceof mongoose.Types.ObjectId) return true;
  return mongoose.Types.ObjectId.isValid(String(v));
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
    // type: "purchase" | "sale" | "return" | "adjustment",
    type: {
      type: String,
      enum: ["purchase", "sale", "return", "adjustment"],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
    },
    direction: {
      type: String,
      enum: ["in", "out"],
      required: true,
    },
    /**
     * Purchase order line this movement came from (when source_type is purchase_order_item).
     * Legacy DB rows may only have this field set — see post("init") + pre("validate").
     */
    reference_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "purchase_order_item",
    },
    /** POS / sales line linkage when source_type is order_item. */
    order_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order_item",
      field_name: "Order line",
    },
    /** Inventory adjustment / batch id (no ref until an adjustment model exists). */
    adjustment_id: {
      type: mongoose.Schema.Types.ObjectId,
      field_name: "Adjustment",
    },
    source_type: {
      type: String,
      enum: SOURCE_TYPES,
      field_name: "Reference type",
    },
    /**
     * Optional client-supplied or server-derived key for exactly-once inventory effect
     * per company (unique index). Omitted for anonymous manual movements.
     */
    idempotency_key: {
      type: String,
      maxlength: 200,
      field_name: "Idempotency key",
    },
    // default fields
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

/** Legacy rows: only reference_id set → treat as PO line for reporting / populate. */
modelSchema.post("init", function (doc) {
  if (!doc || doc.isNew) return;
  if (doc.reference_id && !doc.order_item_id && !doc.adjustment_id) {
    const st = doc.get("source_type");
    if (st === undefined || st === null || st === "manual") {
      doc.set("source_type", "purchase_order_item");
    }
  }
});

modelSchema.pre("validate", function (next) {
  if (typeof this.idempotency_key === "string") {
    this.idempotency_key = this.idempotency_key.trim() || undefined;
  }
  const hasPo = docHasId(this.reference_id);
  const hasOi = docHasId(this.order_item_id);
  const hasAdj = docHasId(this.adjustment_id);
  const count = [hasPo, hasOi, hasAdj].filter(Boolean).length;
  if (count > 1) {
    this.invalidate(
      "reference_id",
      "Set only one of reference_id (PO line), order_item_id, or adjustment_id",
    );
    return next();
  }
  if (hasAdj) this.source_type = "adjustment";
  else if (hasOi) this.source_type = "order_item";
  else if (hasPo) this.source_type = "purchase_order_item";
  else this.source_type = "manual";
  next();
});

modelSchema.index({ company_id: 1, product_id: 1, createdAt: -1 });
modelSchema.index({ company_id: 1, warehouse_id: 1, createdAt: -1 });
/**
 * One active stock effect per POS line + type + direction (prevents double stock-out on same order_item).
 * PO lines use reference_id without this constraint (split receipts may share a PO line).
 */
modelSchema.index(
  { company_id: 1, order_item_id: 1, type: 1, direction: 1 },
  {
    unique: true,
    partialFilterExpression: {
      order_item_id: { $exists: true, $ne: null },
      deletedAt: null,
      status: "active",
    },
    name: "company_order_item_type_direction_1",
  },
);
modelSchema.index(
  { company_id: 1, adjustment_id: 1 },
  { sparse: true, name: "company_adjustment_1" },
);

/**
 * At most one active movement per idempotency key per tenant (retries / double POST).
 * Soft-deleted rows drop out of the partial filter so a new movement may reuse the key
 * after inventory was reverted in deleteStockMovement.
 */
modelSchema.index(
  { company_id: 1, idempotency_key: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotency_key: { $exists: true, $nin: [null, ""] },
      deletedAt: null,
      status: "active",
    },
    name: "company_idempotency_key_1",
  },
);

const MODEL = mongoose.model("stock_movement", modelSchema);
MODEL.SOURCE_TYPES = SOURCE_TYPES;

module.exports = MODEL;

const mongoose = require("mongoose");

function roundQty(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

const modelSchema = new mongoose.Schema(
  {
    stock_recount_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
      field_name: "Stock Recount Session",
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      index: true,
      field_name: "Product",
    },
    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      index: true,
      field_name: "Warehouse",
    },
    warehouse_inventory_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse_inventory",
      required: true,
      field_name: "Warehouse Inventory",
    },
    system_qty: {
      type: Number,
      required: true,
      field_name: "System Qty",
    },
    counted_qty: {
      type: Number,
      default: null,
      field_name: "Counted Qty",
    },
    variance_qty: {
      type: Number,
      default: 0,
      field_name: "Variance Qty",
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
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

modelSchema.index(
  { company_id: 1, stock_recount_id: 1, product_id: 1, warehouse_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      company_id: { $exists: true, $ne: null },
      deletedAt: null,
    },
  },
);

modelSchema.index({ company_id: 1, warehouse_id: 1, stock_recount_id: 1 });

function applyVarianceToUpdate(update, systemQty) {
  const set =
    update.$set && typeof update.$set === "object" ? update.$set : update;
  if (!Object.prototype.hasOwnProperty.call(set, "counted_qty")) return;

  const countedRaw = set.counted_qty;
  if (countedRaw == null || countedRaw === "") {
    set.counted_qty = null;
    set.variance_qty = 0;
    return;
  }

  const counted = roundQty(countedRaw);
  if (counted == null) return;
  set.counted_qty = counted;

  const system = roundQty(systemQty);
  if (system == null) return;
  set.variance_qty = roundQty(counted - system);
}

/** variance_qty = counted_qty - system_qty (snapshot from warehouse_inventory.quantity). */
modelSchema.pre("validate", function (next) {
  if (this.counted_qty == null || this.counted_qty === "") {
    this.variance_qty = 0;
    return next();
  }
  const counted = roundQty(this.counted_qty);
  const system = roundQty(this.system_qty);
  if (counted == null || system == null) return next();
  this.variance_qty = roundQty(counted - system);
  next();
});

/** Generic PATCH /update/:id uses findOneAndUpdate and skips document validate. */
modelSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const update = this.getUpdate() || {};
    const set =
      update.$set && typeof update.$set === "object" ? update.$set : update;
    if (!Object.prototype.hasOwnProperty.call(set, "counted_qty")) {
      return next();
    }

    let systemQty = set.system_qty;
    if (systemQty == null) {
      const current = await this.model
        .findOne(this.getQuery())
        .select("system_qty")
        .lean();
      systemQty = current?.system_qty;
    }
    applyVarianceToUpdate(update, systemQty);
    next();
  } catch (err) {
    next(err);
  }
});

const MODEL = mongoose.model("stock_recount", modelSchema);

module.exports = MODEL;

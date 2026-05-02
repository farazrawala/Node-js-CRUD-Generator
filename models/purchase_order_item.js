const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    purchase_order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "purchase_order",
      required: true,
      field_name: "Purchase Order ID",
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      field_name: "Product",
    },
    qty: {
      type: Number,
      required: true,
      min: 0,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    subtotal: {
      type: Number,
      required: true,
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

/** Line total: 2 decimal places from price × qty (same as order_item). */
function computeLineSubtotal(price, qty) {
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(p) || !Number.isFinite(q)) {
    return null;
  }
  return Math.round(p * q * 100) / 100;
}

modelSchema.pre("validate", function (next) {
  const computed = computeLineSubtotal(this.price, this.qty);
  if (computed !== null) {
    this.subtotal = computed;
  }
  next();
});

/**
 * findByIdAndUpdate does not run document pre("validate"); recompute subtotal when
 * price, qty, or subtotal appear in the update payload.
 */
modelSchema.pre(
  ["findOneAndUpdate", "findByIdAndUpdate"],
  async function (next) {
    try {
      const raw = this.getUpdate();
      if (!raw || Array.isArray(raw)) return next();

      const moneyKeys = ["price", "qty", "subtotal"];
      const plain =
        raw.$set && typeof raw.$set === "object" ?
          { ...raw.$set }
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => !k.startsWith("$")),
          );
      if (!moneyKeys.some((k) => Object.prototype.hasOwnProperty.call(plain, k))) {
        return next();
      }

      const filter = this.getFilter();
      if (!filter || !(filter._id ?? filter.id)) return next();

      const existing = await this.model
        .findOne(filter)
        .select("price qty")
        .lean();
      if (!existing) return next();

      const price =
        plain.price !== undefined ?
          Number(plain.price)
        : Number(existing.price);
      const qty =
        plain.qty !== undefined ? Number(plain.qty) : Number(existing.qty);
      const computed = computeLineSubtotal(price, qty);
      if (computed === null) return next();

      if (raw.$set && typeof raw.$set === "object") {
        this.setUpdate({
          ...raw,
          $set: {
            ...raw.$set,
            subtotal: computed,
          },
        });
      } else {
        const operators = Object.fromEntries(
          Object.entries(raw).filter(([k]) => k.startsWith("$")),
        );
        const top = Object.fromEntries(
          Object.entries(raw).filter(([k]) => !k.startsWith("$")),
        );
        this.setUpdate({
          ...operators,
          $set: {
            ...top,
            subtotal: computed,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

modelSchema.index({ purchase_order_id: 1, company_id: 1 });

const MODEL = mongoose.model("purchase_order_item", modelSchema);

module.exports = MODEL;

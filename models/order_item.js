const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    qty: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
    },
    subtotal: {
      type: Number,
      required: true,
    },
    // image: {
    //   type: String,
    //   field_type: "image",
    // },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
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
    },
  },
  { timestamps: true },
);

/** Monetary line total: 2 decimal places, single source of truth from price × qty */
function computeLineSubtotal(price, qty) {
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(p) || !Number.isFinite(q)) {
    return null;
  }
  return Math.round(p * q * 100) / 100;
}

modelSchema.pre("validate", async function (next) {
  try {
    const computed = computeLineSubtotal(this.price, this.qty);
    if (computed !== null) {
      this.subtotal = computed;
    }

    if (this.order_id) {
      const Order = mongoose.model("order");
      const order = await Order.findById(this.order_id)
        .select("company_id branch_id")
        .lean();
      if (!order) {
        this.invalidate("order_id", "Referenced order does not exist");
        return next();
      }
      if (String(order.company_id) !== String(this.company_id)) {
        this.invalidate(
          "company_id",
          "company_id must match the parent order's company_id",
        );
        return next();
      }
      const lineBranchUnset =
        this.branch_id === undefined || this.branch_id === null;
      if (lineBranchUnset && order.branch_id != null) {
        this.branch_id = order.branch_id;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
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

modelSchema.index({ company_id: 1, order_id: 1 });

const MODEL = mongoose.model("order_item", modelSchema);

module.exports = MODEL;

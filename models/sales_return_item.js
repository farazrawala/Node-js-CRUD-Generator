const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    sales_return_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "sales_return",
      required: true,
      field_name: "Sales Return ID",
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

    shipping_per_unit: {
      type: Number,
      required: true,
      min: 0,
    },

    /** Frozen unit cost at return (order line `cost_price_at_sale` or wholesale at save). */
    cost_price_at_return: {
      type: Number,
      min: 0,
    },

    /** (`cost_price_at_return` − price) × qty; uses frozen cost, not live wholesale. */
    profit: {
      type: Number,
      default: 0,
    },

    total_shipping: {
      type: Number,
      required: true,
      min: 0,
    },

    subtotal: {
      type: Number,
      required: true,
    },
    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse_inventories",
      required: true,
      field_name: "Warehouse Inventory",
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

/** Line total: 2 decimal places from price × qty (same as purchase_return_item). */
function computeLineSubtotal(price, qty) {
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(p) || !Number.isFinite(q)) {
    return null;
  }
  return Math.round(p * q * 100) / 100;
}

/** Margin per line: frozen unit cost minus return price, × qty. */
function computeLineProfit(unitCost, price, qty) {
  const cost = Number(unitCost);
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(cost) || !Number.isFinite(p) || !Number.isFinite(q)) {
    return 0;
  }
  return Math.round((cost - p) * q * 100) / 100;
}

function frozenUnitCostFromLine(line) {
  const stored = Number(line?.cost_price_at_return);
  if (Number.isFinite(stored) && stored >= 0) {
    return Math.round(stored * 100) / 100;
  }
  return null;
}

function wholesaleUnitFromProduct(product) {
  if (!product || typeof product !== "object") return 0;
  const wp = Number(product.wholesale_price);
  if (Number.isFinite(wp) && wp >= 0) {
    return Math.round(wp * 100) / 100;
  }
  return 0;
}

modelSchema.pre("validate", async function (next) {
  try {
    const computed = computeLineSubtotal(this.price, this.qty);
    if (computed !== null) {
      this.subtotal = computed;
    }

    const frozenCost = frozenUnitCostFromLine(this);
    if (frozenCost != null) {
      this.cost_price_at_return = frozenCost;
      this.profit = computeLineProfit(frozenCost, this.price, this.qty);
    } else if (this.product_id) {
      const Product = mongoose.model("product");
      const session =
        typeof this.$session === "function" ? this.$session() : null;
      let productQuery = Product.findById(this.product_id).select(
        "wholesale_price",
      );
      if (session) productQuery = productQuery.session(session);
      const product = await productQuery.lean();
      const unitCost = wholesaleUnitFromProduct(product);
      this.cost_price_at_return = unitCost;
      this.profit = computeLineProfit(unitCost, this.price, this.qty);
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

      const moneyKeys = ["price", "qty", "subtotal", "product_id"];
      const plain =
        raw.$set && typeof raw.$set === "object" ?
          { ...raw.$set }
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => !k.startsWith("$")),
          );
      if (
        !moneyKeys.some((k) => Object.prototype.hasOwnProperty.call(plain, k))
      ) {
        return next();
      }

      const filter = this.getFilter();
      if (!filter || !(filter._id ?? filter.id)) return next();

      const existing = await this.model
        .findOne(filter)
        .select("price qty product_id cost_price_at_return")
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

      const productId =
        plain.product_id !== undefined ?
          plain.product_id
        : existing.product_id;
      let unitCost = frozenUnitCostFromLine({
        cost_price_at_return:
          plain.cost_price_at_return !== undefined ?
            plain.cost_price_at_return
          : existing.cost_price_at_return,
      });
      if (unitCost == null && productId) {
        const Product = mongoose.model("product");
        const product = await Product.findById(productId)
          .select("wholesale_price")
          .lean();
        unitCost = wholesaleUnitFromProduct(product);
      }
      const profit =
        unitCost != null ? computeLineProfit(unitCost, price, qty) : 0;
      const extraFields = {
        subtotal: computed,
        profit,
        ...(unitCost != null ? { cost_price_at_return: unitCost } : {}),
      };

      if (raw.$set && typeof raw.$set === "object") {
        this.setUpdate({
          ...raw,
          $set: {
            ...raw.$set,
            ...extraFields,
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
            ...extraFields,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

/** `insertMany` does not run document `validate` hooks; set subtotal and profit here. */
modelSchema.pre("insertMany", async function (next, docs) {
  try {
    const rows = Array.isArray(docs) ? docs : [];
    if (rows.length === 0) return next();

    const Product = mongoose.model("product");
    const productIds = [
      ...new Set(
        rows
          .map((d) => String(d.product_id ?? "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id)),
      ),
    ];
    const products =
      productIds.length === 0 ?
        []
      : await Product.find({ _id: { $in: productIds } })
          .select("wholesale_price")
          .lean();
    const productById = new Map(products.map((p) => [String(p._id), p]));

    for (const doc of rows) {
      const sub = computeLineSubtotal(doc.price, doc.qty);
      if (sub !== null) doc.subtotal = sub;
      const frozenCost = frozenUnitCostFromLine(doc);
      const unitCost =
        frozenCost != null ?
          frozenCost
        : wholesaleUnitFromProduct(productById.get(String(doc.product_id)));
      if (frozenCost == null) {
        doc.cost_price_at_return = unitCost;
      }
      doc.profit = computeLineProfit(unitCost, doc.price, doc.qty);
    }
    next();
  } catch (err) {
    next(err);
  }
});

modelSchema.index({ sales_return_id: 1, company_id: 1 });

const MODEL = mongoose.model("sales_return_item", modelSchema);

module.exports = MODEL;

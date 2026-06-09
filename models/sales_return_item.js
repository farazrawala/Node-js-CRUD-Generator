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

    /** (product.wholesale_price − price) × qty at save time. */
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

/** Margin per line: wholesale unit cost minus return price, × qty. */
function computeLineProfit(wholesalePrice, price, qty) {
  const wp = Number(wholesalePrice);
  const p = Number(price);
  const q = Number(qty);
  if (!Number.isFinite(wp) || !Number.isFinite(p) || !Number.isFinite(q)) {
    return 0;
  }
  return Math.round((wp - p) * q * 100) / 100;
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

    if (this.product_id) {
      const Product = mongoose.model("product");
      const session =
        typeof this.$session === "function" ? this.$session() : null;
      let productQuery = Product.findById(this.product_id).select(
        "wholesale_price",
      );
      if (session) productQuery = productQuery.session(session);
      const product = await productQuery.lean();
      this.profit = computeLineProfit(
        wholesaleUnitFromProduct(product),
        this.price,
        this.qty,
      );
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
        .select("price qty product_id")
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
      let profit = 0;
      if (productId) {
        const Product = mongoose.model("product");
        const product = await Product.findById(productId)
          .select("wholesale_price")
          .lean();
        profit = computeLineProfit(
          wholesaleUnitFromProduct(product),
          price,
          qty,
        );
      }

      const extraFields = { subtotal: computed, profit };

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
      const product = productById.get(String(doc.product_id));
      doc.profit = computeLineProfit(
        wholesaleUnitFromProduct(product),
        doc.price,
        doc.qty,
      );
    }
    next();
  } catch (err) {
    next(err);
  }
});

modelSchema.index({ sales_return_id: 1, company_id: 1 });

const MODEL = mongoose.model("sales_return_item", modelSchema);

module.exports = MODEL;

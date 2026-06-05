const mongoose = require("mongoose");

function toMoneyNumber(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney2(n) {
  return Math.round(toMoneyNumber(n, 0) * 100) / 100;
}

/** Grand total from line subtotal snapshot, discount, and shipping (return header). */
function computeTotalAmount(linesSubtotal, discount, shipment) {
  const lines = roundMoney2(Math.max(0, linesSubtotal));
  const disc = roundMoney2(Math.max(0, discount));
  const ship = roundMoney2(Math.max(0, shipment));
  return roundMoney2(Math.max(0, lines - disc + ship));
}

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.counter || mongoose.model("counter", counterSchema);

async function getNextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return counter.seq;
}

/** Numeric suffix from standard tenant format `SR-####`. */
function parseSrNumericSuffix(salesReturnNo) {
  const m = String(salesReturnNo ?? "")
    .trim()
    .match(/^SR-(\d+)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function getMaxSalesReturnSeqForCompany(companyId) {
  if (!companyId) return 0;
  const cid =
    companyId instanceof mongoose.Types.ObjectId ?
      companyId
    : new mongoose.Types.ObjectId(String(companyId));
  const SalesReturn = mongoose.model("sales_return");
  const rows = await SalesReturn.find({
    company_id: cid,
    deletedAt: null,
    sales_return_no: /^SR-\d+$/i,
  })
    .select("sales_return_no")
    .lean();
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, parseSrNumericSuffix(row.sales_return_no));
  }
  return max;
}

async function allocateSalesReturnNoForCompany(companyId) {
  const counterKey =
    companyId ?
      `sales_return_no_${companyId.toString()}`
    : "sales_return_no__no_company";
  const maxFromDb = await getMaxSalesReturnSeqForCompany(companyId);
  await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $set: { seq: maxFromDb } },
    { upsert: true },
  );
  const seq = await getNextSequence(counterKey);
  return `SR-${String(seq).padStart(4, "0")}`;
}

async function assertCustomerUserMatchesCompany(customerId, companyId) {
  if (!customerId || !companyId) return null;
  const User = mongoose.model("user");
  const user = await User.findById(customerId).select("company_id").lean();
  if (!user) return "Referenced customer user not found";
  if (user.company_id == null) {
    return "Customer user must have a company_id for tenant sales returns";
  }
  if (String(user.company_id) !== String(companyId)) {
    return "customer_id must belong to the sales return's company_id";
  }
  return null;
}

/** When set, source order must exist, not be deleted, and match tenant `company_id`. */
async function assertOrderRefMatchesCompany(orderId, companyId) {
  if (!orderId) {
    return null;
  }
  if (!companyId) {
    return "company_id is required";
  }
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return "order_id must be a valid ObjectId";
  }
  const Order = mongoose.model("order");
  const order = await Order.findById(orderId)
    .select("company_id deletedAt order_no")
    .lean();
  if (!order || order.deletedAt) {
    return "Referenced order not found";
  }
  if (String(order.company_id) !== String(companyId)) {
    return "order_id must belong to the same company_id as the return";
  }
  return null;
}

const RETURN_STATUS_VALUES = ["drafted", "pending", "completed", "cancelled"];

/**
 * Sales return header — mirrors order money fields; optional link to `order_id`.
 * Document number: `sales_return_no` (`SR-####`). Line rows: `sales_return_item`.
 */
const modelSchema = new mongoose.Schema(
  {
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Customer",
    },

    /** Optional link to source sales order (validated only when provided). */
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      field_name: "Order",
    },

    /** Denormalized from source order for lists/reports (optional on create). */
    order_no: {
      type: String,
      field_name: "Source Order No.",
    },
    sales_return_no: {
      type: String,
      field_name: "Sales Return No",
    },
    description: {
      type: String,
    },
    discount: {
      type: Number,
      default: 0,
    },
    shipment: {
      type: Number,
      default: 0,
    },
    /** Sum of return line subtotals (sync via syncHeaderTotalsFromLineItems). */
    lines_subtotal: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Lines subtotal",
    },
    /** lines_subtotal − discount + shipment (pre-validate / update hooks). */
    total_amount: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Total amount",
    },
    amount_refunded: {
      type: Number,
      field_name: "Amount Refunded",
      default: 0,
    },
    payment_method_accounts_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Mode of payment",
    },
    return_status: {
      type: String,
      enum: RETURN_STATUS_VALUES,
      default: "drafted",
      field_name: "Return status",
    },
    transaction_number: {
      type: String,
      field_name: "Transaction Number",
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
    },
    ref_no: {
      type: String,
    },
    image: {
      type: String,
      field_name: "Image",
    },
    stock_update: {
      type: String,
      required: true,
      enum: ["yes", "no"],
      field_name: "Stock Update",
      default: "yes",
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

modelSchema.pre("validate", function (next) {
  this.lines_subtotal = roundMoney2(
    Math.max(0, toMoneyNumber(this.lines_subtotal, 0)),
  );
  this.discount = roundMoney2(Math.max(0, toMoneyNumber(this.discount, 0)));
  this.shipment = roundMoney2(Math.max(0, toMoneyNumber(this.shipment, 0)));
  this.amount_refunded = roundMoney2(
    Math.max(0, toMoneyNumber(this.amount_refunded, 0)),
  );
  this.total_amount = computeTotalAmount(
    this.lines_subtotal,
    this.discount,
    this.shipment,
  );
  next();
});

modelSchema.pre("validate", async function (next) {
  try {
    const customerMsg = await assertCustomerUserMatchesCompany(
      this.customer_id,
      this.company_id,
    );
    if (customerMsg) {
      this.invalidate("customer_id", customerMsg);
      return next();
    }

    const orderMsg = await assertOrderRefMatchesCompany(
      this.order_id,
      this.company_id,
    );
    if (orderMsg) {
      this.invalidate("order_id", orderMsg);
      return next();
    }

    if (
      (!this.order_no || !String(this.order_no).trim()) &&
      this.order_id
    ) {
      const Order = mongoose.model("order");
      const order = await Order.findById(this.order_id)
        .select("order_no")
        .lean();
      if (order?.order_no) {
        this.order_no = String(order.order_no).trim();
      }
    }

    next();
  } catch (err) {
    next(err);
  }
});

modelSchema.pre(
  ["findOneAndUpdate", "findByIdAndUpdate"],
  async function (next) {
    try {
      const raw = this.getUpdate();
      if (!raw || Array.isArray(raw)) return next();
      const filter = this.getFilter();
      if (!filter || !(filter._id ?? filter.id)) return next();

      const plain =
        raw.$set && typeof raw.$set === "object" ?
          { ...raw.$set }
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => !k.startsWith("$")),
          );

      const touchesCustomer = Object.prototype.hasOwnProperty.call(
        plain,
        "customer_id",
      );
      const touchesCompany = Object.prototype.hasOwnProperty.call(
        plain,
        "company_id",
      );
      const touchesOrder = Object.prototype.hasOwnProperty.call(
        plain,
        "order_id",
      );
      const unsetCustomer =
        raw.$unset &&
        typeof raw.$unset === "object" &&
        Object.prototype.hasOwnProperty.call(raw.$unset, "customer_id");

      if (touchesCustomer || touchesCompany || unsetCustomer || touchesOrder) {
        const existing = await this.model
          .findOne(filter)
          .select("customer_id company_id order_id")
          .lean();
        if (!existing) return next();

        let customerAfter = existing.customer_id;
        if (unsetCustomer) customerAfter = null;
        else if (touchesCustomer) customerAfter = plain.customer_id;

        let companyAfter = existing.company_id;
        if (touchesCompany) companyAfter = plain.company_id;

        let orderAfter = existing.order_id;
        if (touchesOrder) orderAfter = plain.order_id;

        const customerMsg = await assertCustomerUserMatchesCompany(
          customerAfter,
          companyAfter,
        );
        if (customerMsg) return next(new Error(customerMsg));

        const orderMsg = await assertOrderRefMatchesCompany(
          orderAfter,
          companyAfter,
        );
        if (orderMsg) return next(new Error(orderMsg));
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

modelSchema.pre(
  ["findOneAndUpdate", "findByIdAndUpdate"],
  async function (next) {
    try {
      const raw = this.getUpdate();
      if (!raw || Array.isArray(raw)) return next();

      const filter = this.getFilter();
      if (!filter || !(filter._id ?? filter.id)) return next();

      const plain =
        raw.$set && typeof raw.$set === "object" ?
          { ...raw.$set }
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => !k.startsWith("$")),
          );

      const moneyKeys = [
        "lines_subtotal",
        "discount",
        "shipment",
        "total_amount",
        "amount_refunded",
      ];
      if (
        !moneyKeys.some((k) => Object.prototype.hasOwnProperty.call(plain, k))
      ) {
        return next();
      }

      const existing = await this.model
        .findOne(filter)
        .select("lines_subtotal discount shipment amount_refunded")
        .lean();
      if (!existing) return next();

      const lines_subtotal = roundMoney2(
        Math.max(
          0,
          plain.lines_subtotal !== undefined ?
            toMoneyNumber(plain.lines_subtotal, 0)
          : toMoneyNumber(existing.lines_subtotal, 0),
        ),
      );
      const discount = roundMoney2(
        Math.max(
          0,
          plain.discount !== undefined ?
            toMoneyNumber(plain.discount, 0)
          : toMoneyNumber(existing.discount, 0),
        ),
      );
      const shipment = roundMoney2(
        Math.max(
          0,
          plain.shipment !== undefined ?
            toMoneyNumber(plain.shipment, 0)
          : toMoneyNumber(existing.shipment, 0),
        ),
      );
      const amount_refunded = roundMoney2(
        Math.max(
          0,
          plain.amount_refunded !== undefined ?
            toMoneyNumber(plain.amount_refunded, 0)
          : toMoneyNumber(existing.amount_refunded, 0),
        ),
      );
      const total_amount = computeTotalAmount(
        lines_subtotal,
        discount,
        shipment,
      );

      if (raw.$set && typeof raw.$set === "object") {
        this.setUpdate({
          ...raw,
          $set: {
            ...raw.$set,
            lines_subtotal,
            discount,
            shipment,
            amount_refunded,
            total_amount,
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
            lines_subtotal,
            discount,
            shipment,
            amount_refunded,
            total_amount,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

modelSchema.statics.syncHeaderTotalsFromLineItems = async function (
  salesReturnId,
  options = {},
) {
  const session = options.session;
  const idStr = String(salesReturnId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(idStr)) return null;
  const oid = new mongoose.Types.ObjectId(idStr);

  const Item = mongoose.model("sales_return_item");
  let agg = Item.aggregate([
    {
      $match: {
        sales_return_id: oid,
        status: "active",
        deletedAt: null,
      },
    },
    { $group: { _id: null, sum: { $sum: "$subtotal" } } },
  ]);
  if (session) agg = agg.session(session);
  const rows = await agg;
  const lines_subtotal = roundMoney2(Math.max(0, Number(rows[0]?.sum) || 0));

  let q = this.findById(oid).select("discount shipment");
  if (session) q = q.session(session);
  const header = await q.lean();
  if (!header) return null;

  const discount = roundMoney2(Math.max(0, toMoneyNumber(header.discount, 0)));
  const shipment = roundMoney2(Math.max(0, toMoneyNumber(header.shipment, 0)));
  const total_amount = computeTotalAmount(lines_subtotal, discount, shipment);

  return this.findByIdAndUpdate(
    oid,
    { $set: { lines_subtotal, total_amount } },
    { new: true, session, runValidators: true },
  );
};

modelSchema.index(
  { company_id: 1, sales_return_no: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true },
    },
  },
);

modelSchema.index({ company_id: 1, order_id: 1 });

modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  if (!this.sales_return_no || this.sales_return_no.trim() === "") {
    try {
      const SalesReturn = this.constructor;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await allocateSalesReturnNoForCompany(
          this.company_id,
        );
        const exists = await SalesReturn.exists({
          company_id: this.company_id,
          sales_return_no: candidate,
          deletedAt: null,
        });
        if (!exists) {
          this.sales_return_no = candidate;
          break;
        }
      }
      if (!this.sales_return_no || !this.sales_return_no.trim()) {
        return next(new Error("Could not allocate unique sales_return_no"));
      }
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("sales_return", modelSchema);

module.exports = MODEL;

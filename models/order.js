const mongoose = require("mongoose");

function toMoneyNumber(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney2(n) {
  return Math.round(toMoneyNumber(n, 0) * 100) / 100;
}

/** Grand total from line subtotal snapshot, discount, and shipping (POS header). */
function computeTotalAmount(linesSubtotal, discount, shipment) {
  const lines = roundMoney2(Math.max(0, linesSubtotal));
  const disc = roundMoney2(Math.max(0, discount));
  const ship = roundMoney2(Math.max(0, shipment));
  return roundMoney2(Math.max(0, lines - disc + ship));
}

/** Change due to customer: overpay only; never negative (server-derived, not client-trusted). */
function deriveChangeGiven(amountReceived, totalAmount) {
  const ar = roundMoney2(Math.max(0, toMoneyNumber(amountReceived, 0)));
  const tot = roundMoney2(Math.max(0, toMoneyNumber(totalAmount, 0)));
  return roundMoney2(Math.max(0, ar - tot));
}

function trimOrEmpty(v) {
  if (v == null) return "";
  return String(v).trim();
}

/** Loose email check only when a value is present (walk-in may omit). */
function isPlausibleEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Single source of truth for `order_status` enum (keep purchase_order aligned manually if shared). */
const ORDER_STATUS_VALUES = [
  "active",
  "placed",
  "confirmed",
  "shipped",
  "delivered",
  "drafted",
  "pending",
  "completed",
  "cancelled",
  "refunded",
  "failed",
];

/**
 * Suggested lifecycle groupings for app logic (stock, revenue, UI filters).
 * Not enforced by Mongoose — use `classifyOrderStatus` / Sets in controllers.
 */
const ORDER_STATUS_GROUPS = {
  /** Before firm commit / payment intent */
  draftLike: new Set(["drafted", "pending"]),
  /** Open sales / work in progress */
  open: new Set(["active", "placed", "confirmed"]),
  /** Physical / digital fulfillment */
  fulfillment: new Set(["shipped", "delivered"]),
  /** Closed — no further fulfillment; adjust stock/GL rules carefully per value */
  terminal: new Set(["completed", "cancelled", "refunded", "failed"]),
};

// Counter schema for auto-increment
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.counter || mongoose.model("counter", counterSchema);

// Function to get next sequence number
async function getNextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return counter.seq;
}

/** Cross-tenant guard: optional POS `customer_id` must reference a user with the same `company_id`. */
async function assertCustomerUserMatchesOrderCompany(customerId, companyId) {
  if (!customerId || !companyId) return null;
  const User = mongoose.model("user");
  const user = await User.findById(customerId).select("company_id").lean();
  if (!user) return "Referenced customer user not found";
  if (user.company_id == null) {
    return "Customer user must have a company_id for tenant orders";
  }
  if (String(user.company_id) !== String(companyId)) {
    return "customer_id must belong to the order's company_id";
  }
  return null;
}

/**
 * Sales document number: `order_no` (e.g. ORD-####). Purchase orders use `purchase_order_no` in
 * `models/purchase_order.js` — same snake_case style with an entity prefix, not two different casing systems.
 */
const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      // required: true,
    },
    order_no: {
      type: String,
      field_name: "Order No",
    },

    email: {
      type: String,
      // required: true,
    },
    phone: {
      type: String,
      // required: true,
    },
    /** Optional POS / CRM link; transactions use reference_user_id when set. */
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Customer",
    },
    address: {
      type: String,
      // required: true,
    },
    description: {
      type: String,
      // required: true
    },
    discount: {
      type: Number,
      default: 0,
    },
    shipment: {
      type: Number,
      default: 0,
    },
    amount_received: {
      type: Number,
      field_name: "Amount Received",
      default: 0,
      min: 0,
    },
    change_given: {
      type: Number,
      field_name: "Change Given",
      default: 0,
      min: 0,
    },
    payment_method_accounts_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Payment Method Accounts",
    },
    /** Sum of order line subtotals (snapshot at save; keep in sync with order_item). */
    lines_subtotal: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Lines subtotal",
    },
    /** lines_subtotal − discount + shipment (stored; derived in pre-validate / update hooks). */
    total_amount: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Total amount",
    },
    /**
     * Sales lifecycle (mixed semantics historically). Prefer `ORDER_STATUS_GROUPS` +
     * `classifyOrderStatus` for stock and revenue rules instead of ad-hoc string checks.
     */
    order_status: {
      type: String,
      enum: {
        values: ORDER_STATUS_VALUES,
        message: "{VALUE} is not a valid order_status",
      },
      default: "placed",
    },
    transaction_number: {
      type: String,
      field_name: "Transaction Number",
    },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company",
      required: true,
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
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

modelSchema.statics.classifyOrderStatus = function (status) {
  const s = status == null ? "" : String(status);
  if (ORDER_STATUS_GROUPS.terminal.has(s)) return "terminal";
  if (ORDER_STATUS_GROUPS.fulfillment.has(s)) return "fulfillment";
  if (ORDER_STATUS_GROUPS.open.has(s)) return "open";
  if (ORDER_STATUS_GROUPS.draftLike.has(s)) return "draftLike";
  return "unknown";
};

// Unique order_no per tenant among non-deleted rows only (soft-deleted reuse allowed).
modelSchema.index(
  { company_id: 1, order_no: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true, $ne: null },
    },
  },
);

/** Tenant order lists and status dashboards (partialFilter: active sales rows). */
modelSchema.index(
  { company_id: 1, order_status: 1, createdAt: -1 },
  {
    name: "company_order_status_created_1",
    partialFilterExpression: {
      deletedAt: null,
      status: "active",
      company_id: { $exists: true, $ne: null },
    },
  },
);

modelSchema.pre("validate", function (next) {
  this.name = trimOrEmpty(this.name);
  this.email = trimOrEmpty(this.email);
  this.phone = trimOrEmpty(this.phone);

  const hasEmail = this.email.length > 0;
  if (hasEmail && !isPlausibleEmail(this.email)) {
    this.invalidate("email", "Invalid email format");
  }
  // Walk-in / anonymous POS: customer_id, email, and phone may all be empty (no "at least one" hard rule).

  this.lines_subtotal = roundMoney2(
    Math.max(0, toMoneyNumber(this.lines_subtotal, 0)),
  );
  this.discount = roundMoney2(Math.max(0, toMoneyNumber(this.discount, 0)));
  this.shipment = roundMoney2(Math.max(0, toMoneyNumber(this.shipment, 0)));
  this.total_amount = computeTotalAmount(
    this.lines_subtotal,
    this.discount,
    this.shipment,
  );

  this.amount_received = roundMoney2(
    Math.max(0, toMoneyNumber(this.amount_received, 0)),
  );
  this.change_given = deriveChangeGiven(
    this.amount_received,
    this.total_amount,
  );
  next();
});

modelSchema.pre("validate", async function (next) {
  try {
    const msg = await assertCustomerUserMatchesOrderCompany(
      this.customer_id,
      this.company_id,
    );
    if (msg) {
      this.invalidate("customer_id", msg);
      return next();
    }
    next();
  } catch (err) {
    next(err);
  }
});

/** Trim string contact fields on partial updates (findByIdAndUpdate bypasses document pre-validate). */
modelSchema.pre(["findOneAndUpdate", "findByIdAndUpdate"], function (next) {
  const raw = this.getUpdate();
  if (!raw || Array.isArray(raw)) return next();
  const trimKeys = ["name", "email", "phone"];
  const trimObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of trimKeys) {
      if (typeof obj[k] === "string") obj[k] = trimOrEmpty(obj[k]);
    }
  };
  if (raw.$set && typeof raw.$set === "object") trimObj(raw.$set);
  trimObj(raw);
  next();
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
      const unsetCustomer =
        raw.$unset &&
        typeof raw.$unset === "object" &&
        Object.prototype.hasOwnProperty.call(raw.$unset, "customer_id");

      if (touchesCustomer || touchesCompany || unsetCustomer) {
        const existing = await this.model
          .findOne(filter)
          .select("customer_id company_id")
          .lean();
        if (!existing) return next();

        let customerAfter = existing.customer_id;
        if (unsetCustomer) customerAfter = null;
        else if (touchesCustomer) customerAfter = plain.customer_id;

        let companyAfter = existing.company_id;
        if (touchesCompany) companyAfter = plain.company_id;

        const msg = await assertCustomerUserMatchesOrderCompany(
          customerAfter,
          companyAfter,
        );
        if (msg) return next(new Error(msg));
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * findByIdAndUpdate uses this path; runValidators alone does not run document `pre('validate')`.
 * Recompute total_amount, amount_received rounding, and server-derived change_given when any
 * header money field is in the update payload.
 */
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
        "amount_received",
        "change_given",
      ];
      if (
        !moneyKeys.some((k) => Object.prototype.hasOwnProperty.call(plain, k))
      )
        return next();

      const existing = await this.model
        .findOne(filter)
        .select("lines_subtotal discount shipment amount_received")
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
      const total_amount = computeTotalAmount(
        lines_subtotal,
        discount,
        shipment,
      );

      const amount_received = roundMoney2(
        Math.max(
          0,
          plain.amount_received !== undefined ?
            toMoneyNumber(plain.amount_received, 0)
          : toMoneyNumber(existing.amount_received, 0),
        ),
      );
      const change_given = deriveChangeGiven(amount_received, total_amount);

      if (raw.$set && typeof raw.$set === "object") {
        this.setUpdate({
          ...raw,
          $set: {
            ...raw.$set,
            lines_subtotal,
            discount,
            shipment,
            total_amount,
            amount_received,
            change_given,
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
            total_amount,
            amount_received,
            change_given,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

// Pre-save hook to auto-generate order_no if not provided
modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next(); // Only generate for new documents
  }

  if (!this.order_no || this.order_no.trim() === "") {
    try {
      // One Counter document per company ObjectId — each tenant gets 1, 2, 3, ...
      const counterKey =
        this.company_id ?
          `order_no_${this.company_id.toString()}`
        : "order_no__no_company";
      const seq = await getNextSequence(counterKey);
      this.order_no = `ORD-${String(seq).padStart(4, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

/**
 * Recompute lines_subtotal from persisted order lines and total_amount from discount/shipment.
 * Call after line inserts/replaces (optionally inside a Mongo session).
 */
modelSchema.statics.syncHeaderTotalsFromLineItems = async function (
  orderId,
  options = {},
) {
  const session = options.session;
  const idStr = String(orderId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(idStr)) return null;
  const oid = new mongoose.Types.ObjectId(idStr);

  const Item = mongoose.model("order_item");
  let agg = Item.aggregate([
    {
      $match: {
        order_id: oid,
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
  const ord = await q.lean();
  if (!ord) return null;

  const discount = roundMoney2(Math.max(0, toMoneyNumber(ord.discount, 0)));
  const shipment = roundMoney2(Math.max(0, toMoneyNumber(ord.shipment, 0)));
  const total_amount = computeTotalAmount(lines_subtotal, discount, shipment);

  return this.findByIdAndUpdate(
    oid,
    { $set: { lines_subtotal, total_amount } },
    { new: true, session, runValidators: true },
  );
};

const MODEL = mongoose.model("order", modelSchema);

MODEL.ORDER_STATUS_VALUES = ORDER_STATUS_VALUES;
MODEL.ORDER_STATUS_GROUPS = ORDER_STATUS_GROUPS;

module.exports = MODEL;

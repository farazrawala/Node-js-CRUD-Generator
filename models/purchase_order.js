const mongoose = require("mongoose");

function toMoneyNumber(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney2(n) {
  return Math.round(toMoneyNumber(n, 0) * 100) / 100;
}

/** Grand total from line subtotal snapshot, discount, and shipping (PO header). */
function computeTotalAmount(linesSubtotal, discount, shipment) {
  const lines = roundMoney2(Math.max(0, linesSubtotal));
  const disc = roundMoney2(Math.max(0, discount));
  const ship = roundMoney2(Math.max(0, shipment));
  return roundMoney2(Math.max(0, lines - disc + ship));
}

// Counter schema for auto-increment (shared pattern with order model)
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

/** Numeric suffix from standard tenant format `PO-####` (ignores legacy formats). */
function parsePoNumericSuffix(purchaseOrderNo) {
  const m = String(purchaseOrderNo ?? "").trim().match(/^PO-(\d+)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Highest `PO-####` suffix for this company (active, non-deleted rows only). */
async function getMaxPurchaseOrderSeqForCompany(companyId) {
  if (!companyId) return 0;
  const cid =
    companyId instanceof mongoose.Types.ObjectId ?
      companyId
    : new mongoose.Types.ObjectId(String(companyId));
  const PurchaseOrder = mongoose.model("purchase_order");
  const rows = await PurchaseOrder.find({
    company_id: cid,
    deletedAt: null,
    purchase_order_no: /^PO-\d+$/i,
  })
    .select("purchase_order_no")
    .lean();
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, parsePoNumericSuffix(row.purchase_order_no));
  }
  return max;
}

/**
 * Allocate next `PO-####` for one tenant. Syncs the counter to the DB max first so failed
 * saves (duplicate index, rollback) do not burn sequence numbers.
 */
async function allocatePurchaseOrderNoForCompany(companyId) {
  const counterKey =
    companyId ?
      `purchase_order_no_${companyId.toString()}`
    : "purchase_order_no__no_company";
  const maxFromDb = await getMaxPurchaseOrderSeqForCompany(companyId);
  await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $set: { seq: maxFromDb } },
    { upsert: true },
  );
  const seq = await getNextSequence(counterKey);
  return `PO-${String(seq).padStart(4, "0")}`;
}

/** Cross-tenant guard: optional `vendor_id` must reference a user with the same `company_id`. */
async function assertVendorUserMatchesPoCompany(vendorId, companyId) {
  if (!vendorId || !companyId) return null;
  const User = mongoose.model("user");
  const user = await User.findById(vendorId).select("company_id").lean();
  if (!user) return "Referenced vendor user not found";
  if (user.company_id == null) {
    return "Vendor user must have a company_id for tenant purchase orders";
  }
  if (String(user.company_id) !== String(companyId)) {
    return "vendor_id must belong to the purchase order's company_id";
  }
  return null;
}

/**
 * Field parity with `models/order.js` for money headers (`lines_subtotal`, `total_amount`,
 * discount, shipment hooks), plus PO extras: `vendor_id`, `ref_no`, `image`, `stock_update`.
 * Document number: `purchase_order_no` (order uses `order_no`).
 */
const modelSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Vendor",
    },
    purchase_order_no: {
      type: String,
      field_name: "Purchase Order No",
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
    /** Sum of PO line subtotals (keep in sync with purchase_order_item; use syncHeaderTotalsFromLineItems). */
    lines_subtotal: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Lines subtotal",
    },
    /** lines_subtotal − discount + shipment (derived in pre-validate / update hooks). */
    total_amount: {
      type: Number,
      default: 0,
      min: 0,
      field_name: "Total amount",
    },
    amount_paid: {
      type: Number,
      field_name: "Amount Paid",
      default: 0,
    },

    payment_method_accounts_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Mode of payment",
    },

    order_status: {
      type: String,
      enum: [
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
      ],
      default: "placed",
    },
    transaction_number: {
      type: String,
      field_name: "Transaction Number",
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
    },

    // Purchase-order specific (not on sales order)
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
  { timestamps: true   },
);

modelSchema.pre("validate", function (next) {
  this.lines_subtotal = roundMoney2(
    Math.max(0, toMoneyNumber(this.lines_subtotal, 0)),
  );
  this.discount = roundMoney2(Math.max(0, toMoneyNumber(this.discount, 0)));
  this.shipment = roundMoney2(Math.max(0, toMoneyNumber(this.shipment, 0)));
  this.amount_paid = roundMoney2(
    Math.max(0, toMoneyNumber(this.amount_paid, 0)),
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
    const msg = await assertVendorUserMatchesPoCompany(
      this.vendor_id,
      this.company_id,
    );
    if (msg) {
      this.invalidate("vendor_id", msg);
      return next();
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

      const touchesVendor = Object.prototype.hasOwnProperty.call(
        plain,
        "vendor_id",
      );
      const touchesCompany = Object.prototype.hasOwnProperty.call(
        plain,
        "company_id",
      );
      const unsetVendor =
        raw.$unset &&
        typeof raw.$unset === "object" &&
        Object.prototype.hasOwnProperty.call(raw.$unset, "vendor_id");

      if (touchesVendor || touchesCompany || unsetVendor) {
        const existing = await this.model
          .findOne(filter)
          .select("vendor_id company_id")
          .lean();
        if (!existing) return next();

        let vendorAfter = existing.vendor_id;
        if (unsetVendor) vendorAfter = null;
        else if (touchesVendor) vendorAfter = plain.vendor_id;

        let companyAfter = existing.company_id;
        if (touchesCompany) companyAfter = plain.company_id;

        const msg = await assertVendorUserMatchesPoCompany(
          vendorAfter,
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
 * findByIdAndUpdate: recompute total_amount when any header monetary field is in the update.
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
        "amount_paid",
      ];
      if (
        !moneyKeys.some((k) => Object.prototype.hasOwnProperty.call(plain, k))
      ) {
        return next();
      }

      const existing = await this.model
        .findOne(filter)
        .select("lines_subtotal discount shipment amount_paid")
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
      const amount_paid = roundMoney2(
        Math.max(
          0,
          plain.amount_paid !== undefined ?
            toMoneyNumber(plain.amount_paid, 0)
          : toMoneyNumber(existing.amount_paid, 0),
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
            amount_paid,
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
            amount_paid,
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

/**
 * Recompute lines_subtotal from persisted PO lines and total_amount from discount/shipment.
 * Call after line inserts/replaces (optionally inside a Mongo session).
 */
modelSchema.statics.syncHeaderTotalsFromLineItems = async function (
  purchaseOrderId,
  options = {},
) {
  const session = options.session;
  const idStr = String(purchaseOrderId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(idStr)) return null;
  const oid = new mongoose.Types.ObjectId(idStr);

  const Item = mongoose.model("purchase_order_item");
  let agg = Item.aggregate([
    {
      $match: {
        purchase_order_id: oid,
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
  const po = await q.lean();
  if (!po) return null;

  const discount = roundMoney2(Math.max(0, toMoneyNumber(po.discount, 0)));
  const shipment = roundMoney2(Math.max(0, toMoneyNumber(po.shipment, 0)));
  const total_amount = computeTotalAmount(
    lines_subtotal,
    discount,
    shipment,
  );

  return this.findByIdAndUpdate(
    oid,
    { $set: { lines_subtotal, total_amount } },
    { new: true, session, runValidators: true },
  );
};

// Unique PO number per tenant among non-deleted rows only (soft-deleted reuse allowed).
modelSchema.index(
  { company_id: 1, purchase_order_no: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true },
    },
  },
);

modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  if (!this.purchase_order_no || this.purchase_order_no.trim() === "") {
    try {
      const PurchaseOrder = this.constructor;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await allocatePurchaseOrderNoForCompany(
          this.company_id,
        );
        const exists = await PurchaseOrder.exists({
          company_id: this.company_id,
          purchase_order_no: candidate,
          deletedAt: null,
        });
        if (!exists) {
          this.purchase_order_no = candidate;
          break;
        }
      }
      if (!this.purchase_order_no || !this.purchase_order_no.trim()) {
        return next(new Error("Could not allocate unique purchase_order_no"));
      }
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("purchase_order", modelSchema);

/**
 * Drop legacy global unique index on `purchase_order_no` only. Numbering is per-tenant via
 * `company_id_1_purchase_order_no_1` (partial).
 */
async function dropObsoletePurchaseOrderNoUniqueIndex() {
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    const coll = db.collection("purchase_orders");
    const indexes = await coll.indexes();
    for (const idx of indexes) {
      const k = idx.key || {};
      if (
        idx.unique &&
        Object.keys(k).length === 1 &&
        k.purchase_order_no === 1
      ) {
        await coll.dropIndex(idx.name);
        console.log(
          "[purchase_order] Dropped obsolete global purchase_order_no unique index:",
          idx.name,
        );
      }
    }
    const { dropped, created } = await MODEL.syncIndexes();
    if (dropped?.length || created?.length) {
      console.log("[purchase_order] syncIndexes:", { dropped, created });
    }
  } catch (err) {
    console.warn("[purchase_order] index migration:", err.message);
  }
}

if (mongoose.connection.readyState === 1) {
  void dropObsoletePurchaseOrderNoUniqueIndex();
} else {
  mongoose.connection.once(
    "connected",
    dropObsoletePurchaseOrderNoUniqueIndex,
  );
}

module.exports = MODEL;

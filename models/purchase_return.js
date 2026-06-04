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

/** Numeric suffix from standard tenant format `PR-####`. */
function parsePrNumericSuffix(purchaseReturnNo) {
  const m = String(purchaseReturnNo ?? "")
    .trim()
    .match(/^PR-(\d+)$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function getMaxPurchaseReturnSeqForCompany(companyId) {
  if (!companyId) return 0;
  const cid =
    companyId instanceof mongoose.Types.ObjectId ?
      companyId
    : new mongoose.Types.ObjectId(String(companyId));
  const PurchaseReturn = mongoose.model("purchase_return");
  const rows = await PurchaseReturn.find({
    company_id: cid,
    deletedAt: null,
    purchase_return_no: /^PR-\d+$/i,
  })
    .select("purchase_return_no")
    .lean();
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, parsePrNumericSuffix(row.purchase_return_no));
  }
  return max;
}

async function allocatePurchaseReturnNoForCompany(companyId) {
  const counterKey =
    companyId ?
      `purchase_return_no_${companyId.toString()}`
    : "purchase_return_no__no_company";
  const maxFromDb = await getMaxPurchaseReturnSeqForCompany(companyId);
  await Counter.findOneAndUpdate(
    { _id: counterKey },
    { $set: { seq: maxFromDb } },
    { upsert: true },
  );
  const seq = await getNextSequence(counterKey);
  return `PR-${String(seq).padStart(4, "0")}`;
}

async function assertVendorUserMatchesCompany(vendorId, companyId) {
  if (!vendorId || !companyId) return null;
  const User = mongoose.model("user");
  const user = await User.findById(vendorId).select("company_id").lean();
  if (!user) return "Referenced vendor user not found";
  if (user.company_id == null) {
    return "Vendor user must have a company_id for tenant purchase returns";
  }
  if (String(user.company_id) !== String(companyId)) {
    return "vendor_id must belong to the purchase return's company_id";
  }
  return null;
}

/** Source PO must exist, not be deleted, and match tenant `company_id`. */
async function assertPurchaseOrderRefMatchesCompany(
  purchaseOrderId,
  companyId,
) {
  if (!purchaseOrderId) {
    return "purchase_order_id is required";
  }
  if (!companyId) {
    return "company_id is required";
  }
  if (!mongoose.Types.ObjectId.isValid(String(purchaseOrderId))) {
    return "purchase_order_id must be a valid ObjectId";
  }
  const PurchaseOrder = mongoose.model("purchase_order");
  const po = await PurchaseOrder.findById(purchaseOrderId)
    .select("company_id deletedAt purchase_order_no")
    .lean();
  if (!po || po.deletedAt) {
    return "Referenced purchase order not found";
  }
  if (String(po.company_id) !== String(companyId)) {
    return "purchase_order_id must belong to the same company_id as the return";
  }
  return null;
}

const RETURN_STATUS_VALUES = ["drafted", "pending", "completed", "cancelled"];

/**
 * Purchase return header — mirrors PO money fields; links to source `purchase_order_id`.
 * Document number: `purchase_return_no` (`PR-####`). Line rows: `purchase_return_item`.
 */
const modelSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Vendor",
    },

    /** Denormalized from source PO for lists/reports (optional on create). */
    purchase_order_no: {
      type: String,
      field_name: "Source PO No.",
    },
    purchase_return_no: {
      type: String,
      field_name: "Purchase Return No",
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
    const vendorMsg = await assertVendorUserMatchesCompany(
      this.vendor_id,
      this.company_id,
    );
    if (vendorMsg) {
      this.invalidate("vendor_id", vendorMsg);
      return next();
    }

    const poMsg = await assertPurchaseOrderRefMatchesCompany(
      this.purchase_order_id,
      this.company_id,
    );
    if (poMsg) {
      this.invalidate("purchase_order_id", poMsg);
      return next();
    }

    if (
      (!this.purchase_order_no || !String(this.purchase_order_no).trim()) &&
      this.purchase_order_id
    ) {
      const PurchaseOrder = mongoose.model("purchase_order");
      const po = await PurchaseOrder.findById(this.purchase_order_id)
        .select("purchase_order_no")
        .lean();
      if (po?.purchase_order_no) {
        this.purchase_order_no = String(po.purchase_order_no).trim();
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

      const touchesVendor = Object.prototype.hasOwnProperty.call(
        plain,
        "vendor_id",
      );
      const touchesCompany = Object.prototype.hasOwnProperty.call(
        plain,
        "company_id",
      );
      const touchesPo = Object.prototype.hasOwnProperty.call(
        plain,
        "purchase_order_id",
      );
      const unsetVendor =
        raw.$unset &&
        typeof raw.$unset === "object" &&
        Object.prototype.hasOwnProperty.call(raw.$unset, "vendor_id");

      if (touchesVendor || touchesCompany || unsetVendor || touchesPo) {
        const existing = await this.model
          .findOne(filter)
          .select("vendor_id company_id purchase_order_id")
          .lean();
        if (!existing) return next();

        let vendorAfter = existing.vendor_id;
        if (unsetVendor) vendorAfter = null;
        else if (touchesVendor) vendorAfter = plain.vendor_id;

        let companyAfter = existing.company_id;
        if (touchesCompany) companyAfter = plain.company_id;

        let poAfter = existing.purchase_order_id;
        if (touchesPo) poAfter = plain.purchase_order_id;

        const vendorMsg = await assertVendorUserMatchesCompany(
          vendorAfter,
          companyAfter,
        );
        if (vendorMsg) return next(new Error(vendorMsg));

        const poMsg = await assertPurchaseOrderRefMatchesCompany(
          poAfter,
          companyAfter,
        );
        if (poMsg) return next(new Error(poMsg));
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

modelSchema.statics.syncHeaderTotalsFromLineItems = async function (
  purchaseReturnId,
  options = {},
) {
  const session = options.session;
  const idStr = String(purchaseReturnId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(idStr)) return null;
  const oid = new mongoose.Types.ObjectId(idStr);

  const Item = mongoose.model("purchase_return_item");
  let agg = Item.aggregate([
    {
      $match: {
        purchase_return_id: oid,
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
  { company_id: 1, purchase_return_no: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true },
    },
  },
);

modelSchema.index({ company_id: 1, purchase_order_id: 1 });

modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  if (!this.purchase_return_no || this.purchase_return_no.trim() === "") {
    try {
      const PurchaseReturn = this.constructor;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = await allocatePurchaseReturnNoForCompany(
          this.company_id,
        );
        const exists = await PurchaseReturn.exists({
          company_id: this.company_id,
          purchase_return_no: candidate,
          deletedAt: null,
        });
        if (!exists) {
          this.purchase_return_no = candidate;
          break;
        }
      }
      if (!this.purchase_return_no || !this.purchase_return_no.trim()) {
        return next(new Error("Could not allocate unique purchase_return_no"));
      }
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("purchase_return", modelSchema);

module.exports = MODEL;

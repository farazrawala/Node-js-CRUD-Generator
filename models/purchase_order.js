const mongoose = require("mongoose");

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

function getCompanyInitials(companyName) {
  const raw = String(companyName || "").toUpperCase();
  const letters = raw.replace(/[^A-Z]/g, "");
  if (!letters) return "GEN";
  return letters.slice(0, 3).padEnd(3, "X");
}

/**
 * Field parity with `models/order.js`, plus purchase-order extras:
 * `vendor_id` (supplier user; order uses `customer_id`), `ref_no`, `image`,
 * `stock_update`, `order_date`. Document number uses `purchase_order_no`
 * (order uses `order_no`).
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
    order_date: {
      type: String,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
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

modelSchema.index({ company_id: 1, purchase_order_no: 1 }, { unique: true });

modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  if (!this.purchase_order_no || this.purchase_order_no.trim() === "") {
    try {
      let initials = "GEN";
      if (this.company_id) {
        try {
          const CompanyModel =
            mongoose.models.company || mongoose.model("company");
          const company = await CompanyModel.findById(this.company_id)
            .select("company_name")
            .lean();
          initials = getCompanyInitials(company?.company_name);
        } catch (_) {
          initials = "GEN";
        }
      }
      const companyCounterKey = `purchase_order_no_${initials}`;
      const seq = await getNextSequence(companyCounterKey);
      this.purchase_order_no = `PO-${initials}-${String(seq).padStart(4, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("purchase_order", modelSchema);

module.exports = MODEL;

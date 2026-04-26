const mongoose = require("mongoose");

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

function getCompanyInitials(companyName) {
  const raw = String(companyName || "").toUpperCase();
  const letters = raw.replace(/[^A-Z]/g, "");
  if (!letters) return "GEN";
  return letters.slice(0, 3).padEnd(3, "X");
}

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    order_no: {
      type: String,
      field_name: "Order No",
    },
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company",
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
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
    },
    change_given: {
      type: Number,
      field_name: "Change Given",
      default: 0,
    },
    // total: {
    //   type: Number,
    //   required: true,
    // },
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
    // default fields
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
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

    // user_id: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "user",
    //   required: true,
    //   field_name: "Order User",
    // },

    // image: {
    //   type: [String],
    //   field_type: "image",
    // },
  },
  { timestamps: true },
);

// Ensure order number is unique per company.
modelSchema.index({ company_id: 1, order_no: 1 }, { unique: true });

// Pre-save hook to auto-generate order_no if not provided
modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next(); // Only generate for new documents
  }

  if (!this.order_no || this.order_no.trim() === "") {
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
      const companyCounterKey = `order_no_${initials}`;
      const seq = await getNextSequence(companyCounterKey);
      this.order_no = `ORD-${initials}-${String(seq).padStart(4, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("order", modelSchema);

module.exports = MODEL;

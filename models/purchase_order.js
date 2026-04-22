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

const modelSchema = new mongoose.Schema(
  {
    vendor_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Vendor Id",
    },
    purchase_order_no: {
      type: String,
      field_name: "Purchase Order No",
      unique: true,
    },
    ref_no: {
      type: String,
      //   required: true,
    },

    description: {
      type: String,
      //   required: true,
    },

    image: {
      type: String,
      field_name: "Image",
    },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
      field_name: "Company",
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
      // required: true,
    },

    // default fields
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

// Pre-save hook to auto-generate purchase_order_no if not provided
modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next(); // Only generate for new documents
  }

  if (!this.purchase_order_no || this.purchase_order_no.trim() === "") {
    try {
      const seq = await getNextSequence("purchase_order_no");
      this.purchase_order_no = `PO-${String(seq).padStart(6, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("purchase_order", modelSchema);

module.exports = MODEL;

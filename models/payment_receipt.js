const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "User",
    },
    amount: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
      field_name: "Amount",
    },
    date: {
      type: Date,
      // required: true,
      field_name: "Date",
    },
    payment_type: {
      type: String,
      required: true,
      field_name: "Payment Type",
      enum: ["Send", "Receive"],
      default: "Receive",
    },
    payment_mode: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Payment Mode",
    },
    transaction_number: {
      type: String,
      required: true,
      field_name: "Transaction Number",
    },
    description: {
      type: String,
    },

    // default fields
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
  { timestamps: true },
);

const MODEL = mongoose.model("payment_receipt", modelSchema);

module.exports = MODEL;

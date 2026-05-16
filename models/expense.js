const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Posted User",
    },
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Account",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      field_name: "Amount",
    },
    payment_method_accounts_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Payment Method Accounts",
    },
    note: {
      type: String,
      required: true,
    },
    image: {
      type: String,
      field_name: "Attachments",
      field_type: "image",
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

const MODEL = mongoose.model("expense", modelSchema);

module.exports = MODEL;

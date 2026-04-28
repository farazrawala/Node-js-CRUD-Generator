const mongoose = require("mongoose");

const referenceEmbedSchema = new mongoose.Schema(
  {
    module: { type: String },
    ref_id: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "module",
    },
    field: { type: String },
    amount: { type: Number },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema(
  {
    transaction_number: {
      type: String,
      required: true,
    },
    // Populated via GET ?populate=account_id or together with ?populate=ref_id (account_id is auto-added when ref_id is used)
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Debit Account",
    },
    type: {
      type: String,
      required: true,
      enum: ["debit", "credit"],
      field_name: "Type",
    },
    amount: {
      type: Number,
      //   required: true,
      field_name: "Amount",
    },
    reference_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      // required: true,
    },
    reference_id: {
      type: referenceEmbedSchema,
      required: false,
    },
    description: {
      type: String,
      //   required: true,
    },

    // default fields
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Posted User",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company",
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
      field_name: "Branch",
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

const MODEL = mongoose.model("transaction", modelSchema);

module.exports = MODEL;

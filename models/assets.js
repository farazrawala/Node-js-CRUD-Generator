const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      //   required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Posted User",
    },
    amount: {
      type: Number,
      default: 0,
      required: true,
      min: 0,
      field_name: "Amount",
    },
    asset_type: {
      type: String,
      required: true,
      enum: ["buy", "sell"],
      field_name: "Buy/Sell",
    },
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Account",
    },
    transaction_number: {
      type: String,
      //   required: true,
      field_name: "Transaction Number",
    },

    // image: {
    //   type: String,
    //   field_name: "Blog Image",
    //   field_type: "image",
    // },

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

const MODEL = mongoose.model("assets", modelSchema);

module.exports = MODEL;

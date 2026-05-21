const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    from_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "From Account",
    },
    to_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "To Account",
    },
    transaction_number: {
      type: String,
      // required: true,
      field_name: "Transaction Number",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      field_name: "Amount",
    },
    description: {
      type: String,
      // required: true,
      field_name: "Description",
    },

    // description: {
    //   type: String,
    //   required: true,
    // },
    // user_id: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "user",
    //   required: true,
    //   field_name: "Posted User",
    // },
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

const MODEL = mongoose.model("amount_transfer", modelSchema);

module.exports = MODEL;

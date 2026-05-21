const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      field_name: "Product",
    },

    transaction_number: {
      type: String,
      // required: true,
      field_name: "Transaction Number",
    },
    quantity: {
      type: Number,
      required: true,
      field_name: "Quantity",
    },
    type: {
      type: String,
      enum: ["add", "remove"],
      required: true,
      field_name: "Type",
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

const MODEL = mongoose.model("adjustment", modelSchema);

module.exports = MODEL;

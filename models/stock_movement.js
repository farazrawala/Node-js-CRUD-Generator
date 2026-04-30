const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      index: true,
    },

    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      index: true,
    },
    // type: "purchase" | "sale" | "return" | "adjustment",
    type: {
      type: String,
      enum: ["purchase", "sale", "return", "adjustment"],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
    },
    direction: {
      type: String,
      enum: ["in", "out"],
      required: true,
    },
    reference_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "purchase_order_item",
      // optional: manual movements; set when tied to a PO line
    },
    // default fields
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
  },
  { timestamps: true },
);

const MODEL = mongoose.model("stock_movement", modelSchema);

module.exports = MODEL;

const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      field_name: "Product",
    },
    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      field_name: "Warehouse",
    },
    type: {
      type: String,
      required: true,
      enum: ["purchase", "sale", "adjustment", "return"],
      field_name: "Type",
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      field_name: "Quantity",
    },
    action: {
      type: String,
      required: true,
      enum: ["add", "subtract"],
      field_name: "Action",
    },
    reference_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: false,
      field_name: "Reference ID",
    },
    note: {
      type: String,
      field_name: "Note",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: false,
      field_name: "Created By",
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

const MODEL = mongoose.model("stock_transaction", modelSchema);

module.exports = MODEL;

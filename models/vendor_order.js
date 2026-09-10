const mongoose = require("mongoose");

/**
 * Origin-company (vendor) list of me-too sales from a connected destination.
 * company_id = vendor / origin (A). buyer_company_id = destination (B).
 */
const itemSchema = new mongoose.Schema(
  {
    origin_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      field_name: "Origin Product",
    },
    origin_product_name: {
      type: String,
      field_name: "Origin Product Name",
    },
    buyer_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      field_name: "Buyer Product",
    },
    buyer_product_name: {
      type: String,
      field_name: "Buyer Product Name",
    },
    qty: {
      type: Number,
      required: true,
      min: 0,
      field_name: "Qty",
    },
    ordered_qty: {
      type: Number,
      field_name: "Ordered Qty",
    },
    local_qty: {
      type: Number,
      default: 0,
      field_name: "Buyer Local Qty",
    },
    price: {
      type: Number,
      min: 0,
      field_name: "Price",
    },
    source_order_item_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order_item",
      field_name: "Source Order Item",
    },
  },
  { _id: true },
);

const modelSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      index: true,
      field_name: "Vendor Company",
    },
    buyer_company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      index: true,
      field_name: "Buyer Company",
    },
    connection_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company_connection",
      field_name: "Connection",
    },
    source_order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      field_name: "Source Order",
    },
    source_order_no: {
      type: String,
      field_name: "Source Order No",
    },
    items: {
      type: [itemSchema],
      default: [],
      field_name: "Items",
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
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
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

modelSchema.index(
  { company_id: 1, source_order_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      source_order_id: { $exists: true, $ne: null },
      deletedAt: null,
    },
    name: "uniq_vendor_order_source",
  },
);

const MODEL = mongoose.model("vendor_order", modelSchema);

module.exports = MODEL;

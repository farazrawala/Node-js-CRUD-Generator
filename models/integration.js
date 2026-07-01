const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    store_type: {
      type: String,
      required: true,
      enum: ["shopify", "woocommerce", "daraz"],
      default: "shopify",
    },
    name: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    city: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      // required: true,
    },
    phone: {
      type: String,
      // required: true,
    },
    url: {
      type: String,
      required: true,
    },
    key: {
      type: String,
      required: true,
      field_name: "Key/client_id",
    },
    secret: {
      type: String,
      required: true,
      field_name: "Secret/client_secret",
    },
    token: {
      type: String,
      // required: true,
    },
    description: {
      type: String,
      required: true,
    },

    image: {
      type: String,
      field_name: "Store Image",
      field_type: "image",
    },

    sync_product_name: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product name",
      field_type: "select",
    },
    sync_product_slug: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product slug",
      field_type: "select",
    },
    sync_product_image: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product image",
      field_type: "select",
    },
    sync_product_price: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product price",
      field_type: "select",
    },
    sync_product_description: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product description",
      field_type: "select",
    },
    sync_product_status: {
      type: String,
      enum: ["yes", "no"],
      default: "yes",
      field_name: "Sync product status",
      field_type: "select",
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

const MODEL = mongoose.model("integration", modelSchema);

module.exports = MODEL;

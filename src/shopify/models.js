/**
 * Shopify sync collections. POS products, orders, and warehouse stock stay
 * in the existing models. These rows are the shop mapping and audit trail.
 * @module src/shopify/models
 */

const mongoose = require("mongoose");

const { Schema } = mongoose;

function register(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

function baseFields() {
  return {
    company_id: {
      type: Schema.Types.ObjectId,
      ref: "company",
      required: true,
      index: true,
    },
    shop_domain: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    shopify_id: {
      type: String,
      required: true,
      trim: true,
    },
  };
}

const timestamps = {
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const connectionSchema = new Schema(
  {
    ...baseFields(),
    shop_name: { type: String, default: "" },
    integration_id: { type: Schema.Types.ObjectId, ref: "integration" },
    status: {
      type: String,
      enum: ["connected", "disconnected", "uninstalled", "error"],
      default: "connected",
      index: true,
    },
    granted_scopes: { type: [String], default: [] },
    access_token_enc: { type: String, default: "", select: false },
    refresh_token_enc: { type: String, default: "", select: false },
    token_expires_at: { type: Date, default: null },
    installed_by: { type: Schema.Types.ObjectId, ref: "user" },
    installed_at: { type: Date, default: null },
    uninstalled_at: { type: Date, default: null },
    last_sync_at: { type: Date, default: null },
    last_product_sync_at: { type: Date, default: null },
    last_order_sync_at: { type: Date, default: null },
    last_inventory_sync_at: { type: Date, default: null },
    last_fulfillment_sync_at: { type: Date, default: null },
    product_count: { type: Number, default: 0 },
    order_count: { type: Number, default: 0 },
    inventory_sync_status: {
      type: String,
      enum: ["idle", "running", "ok", "error"],
      default: "idle",
    },
    fulfillment_status: {
      type: String,
      enum: ["idle", "running", "ok", "error"],
      default: "idle",
    },
    sync_settings: {
      product_sync_enabled: { type: Boolean, default: true },
      inventory_sync_direction: {
        type: String,
        enum: ["pos_to_shopify", "shopify_to_pos", "bidirectional"],
        default: "pos_to_shopify",
      },
      order_import_enabled: { type: Boolean, default: true },
      fulfillment_sync_enabled: { type: Boolean, default: true },
      auto_sync_interval_minutes: { type: Number, default: 30 },
    },
    sync_locks: {
      products: { type: Date, default: null },
      orders: { type: Date, default: null },
      inventory: { type: Date, default: null },
      fulfillments: { type: Date, default: null },
    },
    last_error: { type: String, default: "" },
  },
  { timestamps },
);

connectionSchema.index(
  { shop_domain: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "connected" },
    name: "uniq_connected_shop_domain",
  },
);
connectionSchema.index(
  { company_id: 1, shop_domain: 1 },
  { unique: true, name: "uniq_company_shop_domain" },
);

connectionSchema.set("toJSON", {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.access_token_enc;
    delete ret.refresh_token_enc;
    return ret;
  },
});

const productSchema = new Schema(
  {
    ...baseFields(),
    shopify_product_id: { type: String, required: true },
    shopify_variant_id: { type: String, default: "" },
    inventory_item_id: { type: String, default: "" },
    pos_product_id: { type: Schema.Types.ObjectId, ref: "product" },
    parent_pos_product_id: { type: Schema.Types.ObjectId, ref: "product" },
    sku: { type: String, default: "" },
    barcode: { type: String, default: "" },
    title: { type: String, default: "" },
    status: { type: String, default: "active" },
    tracked: { type: Boolean, default: false },
  },
  { timestamps },
);
productSchema.index(
  { company_id: 1, shop_domain: 1, shopify_id: 1 },
  { unique: true, name: "uniq_shopify_variant" },
);
productSchema.index({ company_id: 1, pos_product_id: 1 });

const orderSchema = new Schema(
  {
    ...baseFields(),
    pos_order_id: { type: Schema.Types.ObjectId, ref: "order" },
    name: { type: String, default: "" },
    financial_status: { type: String, default: "" },
    fulfillment_status: { type: String, default: "" },
    currency: { type: String, default: "" },
    total_price: { type: String, default: "" },
    total_discounts: { type: String, default: "" },
    total_tax: { type: String, default: "" },
    total_shipping: { type: String, default: "" },
    payment_gateways: { type: [String], default: [] },
    channel: { type: String, default: "" },
    cancelled_at: { type: Date, default: null },
  },
  { timestamps },
);
orderSchema.index(
  { company_id: 1, shop_domain: 1, shopify_id: 1 },
  { unique: true, name: "uniq_shopify_order" },
);

const inventorySchema = new Schema(
  {
    ...baseFields(),
    inventory_item_id: { type: String, required: true },
    location_id: { type: String, required: true },
    pos_product_id: { type: Schema.Types.ObjectId, ref: "product" },
    warehouse_id: { type: Schema.Types.ObjectId, ref: "warehouse" },
    available: { type: Number, default: 0 },
    last_pushed_qty: { type: Number, default: null },
    last_pushed_at: { type: Date, default: null },
    last_remote_qty: { type: Number, default: null },
    last_remote_at: { type: Date, default: null },
  },
  { timestamps },
);
inventorySchema.index(
  { company_id: 1, shop_domain: 1, inventory_item_id: 1, location_id: 1 },
  { unique: true, name: "uniq_shopify_inventory_level" },
);

const locationSchema = new Schema(
  {
    ...baseFields(),
    name: { type: String, default: "" },
    active: { type: Boolean, default: true },
    warehouse_id: { type: Schema.Types.ObjectId, ref: "warehouse" },
  },
  { timestamps },
);
locationSchema.index(
  { company_id: 1, shop_domain: 1, shopify_id: 1 },
  { unique: true, name: "uniq_shopify_location" },
);

const fulfillmentSchema = new Schema(
  {
    ...baseFields(),
    order_shopify_id: { type: String, default: "" },
    pos_order_id: { type: Schema.Types.ObjectId, ref: "order" },
    status: { type: String, default: "" },
    tracking_number: { type: String, default: "" },
    tracking_company: { type: String, default: "" },
    tracking_url: { type: String, default: "" },
    shipment_status: { type: String, default: "" },
  },
  { timestamps },
);
fulfillmentSchema.index(
  { company_id: 1, shop_domain: 1, shopify_id: 1 },
  { unique: true, name: "uniq_shopify_fulfillment" },
);

const syncLogSchema = new Schema(
  {
    ...baseFields(),
    action: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
      index: true,
    },
    message: { type: String, default: "" },
    idempotency_key: { type: String, default: "" },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps },
);
syncLogSchema.index(
  { idempotency_key: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotency_key: { $type: "string", $gt: "" } },
    name: "uniq_shopify_sync_idempotency",
  },
);
syncLogSchema.index({ company_id: 1, shop_domain: 1, created_at: -1 });

const webhookSchema = new Schema(
  {
    ...baseFields(),
    topic: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "processed", "failed", "ignored"],
      default: "pending",
    },
    error: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps },
);
webhookSchema.index(
  { company_id: 1, shopify_id: 1 },
  { unique: true, name: "uniq_shopify_webhook_id" },
);

const oauthStateSchema = new Schema(
  {
    ...baseFields(),
    state: { type: String, required: true, unique: true },
    user_id: { type: Schema.Types.ObjectId, ref: "user" },
    expires_at: { type: Date, required: true },
  },
  { timestamps },
);
oauthStateSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = {
  ShopifyConnection: register("shopify_connection", connectionSchema),
  ShopifyProduct: register("shopify_product", productSchema),
  ShopifyOrder: register("shopify_order", orderSchema),
  ShopifyInventory: register("shopify_inventory", inventorySchema),
  ShopifyLocation: register("shopify_location", locationSchema),
  ShopifyFulfillment: register("shopify_fulfillment", fulfillmentSchema),
  ShopifySyncLog: register("shopify_sync_log", syncLogSchema),
  ShopifyWebhookEvent: register("shopify_webhook_event", webhookSchema),
  ShopifyOauthState: register("shopify_oauth_state", oauthStateSchema),
};

/**
 * Courier shipment booking record (one per successful/attempted booking).
 * Stores full api_request / api_response for debugging.
 * @module src/models/courier_shipment.model
 */

const mongoose = require("mongoose");
const {
  UNIFIED_STATUSES,
  PROVIDERS,
  normalizeProviderKey,
} = require("../couriers/constants");

const STATUS_ENUM = Object.values(UNIFIED_STATUSES);
const PROVIDER_ENUM = Object.values(PROVIDERS);

const courierShipmentSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      index: true,
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
      index: true,
    },
    courier: {
      type: String,
      required: true,
      enum: PROVIDER_ENUM,
      set: (v) => normalizeProviderKey(v) || v,
    },
    tracking_number: {
      type: String,
      default: null,
    },
    booking_reference: {
      type: String,
      default: null,
    },
    shipment_status: {
      type: String,
      enum: STATUS_ENUM,
      default: UNIFIED_STATUSES.BOOKED,
      index: true,
    },
    status_code: {
      type: String,
      default: null,
    },
    label_url: {
      type: String,
      default: null,
    },
    cod_amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    weight: {
      type: Number,
      default: 0.5,
      min: 0,
    },
    pieces: {
      type: Number,
      default: 1,
      min: 1,
    },
    api_request: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    api_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    last_tracking_sync: {
      type: Date,
      default: null,
    },
    error_message: {
      type: String,
      default: null,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } },
);

courierShipmentSchema.index({ company_id: 1, order_id: 1, created_at: -1 });
courierShipmentSchema.index({
  shipment_status: 1,
  last_tracking_sync: 1,
  deletedAt: 1,
});
courierShipmentSchema.index(
  { tracking_number: 1 },
  {
    sparse: true,
    partialFilterExpression: {
      tracking_number: { $type: "string" },
      deletedAt: null,
    },
  },
);

const CourierShipment =
  mongoose.models.courier_shipment ||
  mongoose.model("courier_shipment", courierShipmentSchema);

module.exports = CourierShipment;

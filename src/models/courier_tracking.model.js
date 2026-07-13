/**
 * Append-only tracking history for a shipment.
 * Never overwrite — each sync/API poll inserts new events when novel.
 * @module src/models/courier_tracking.model
 */

const mongoose = require("mongoose");
const { UNIFIED_STATUSES } = require("../couriers/constants");

const courierTrackingSchema = new mongoose.Schema(
  {
    shipment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "courier_shipment",
      required: true,
      index: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      index: true,
    },
    tracking_number: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: Object.values(UNIFIED_STATUSES),
      required: true,
    },
    description: {
      type: String,
      default: null,
    },
    location: {
      type: String,
      default: null,
    },
    event_time: {
      type: Date,
      default: null,
    },
    raw_response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } },
);

courierTrackingSchema.index({
  shipment_id: 1,
  status: 1,
  event_time: 1,
  description: 1,
});

const CourierTracking =
  mongoose.models.courier_tracking ||
  mongoose.model("courier_tracking", courierTrackingSchema);

module.exports = CourierTracking;

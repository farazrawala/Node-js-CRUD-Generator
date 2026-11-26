/**
 * Statuses seen for a courier. One row per courier + status.
 * A scan inserts the status only when that pair is not already stored.
 * @module src/models/courier_status.model
 */

const mongoose = require("mongoose");
const { normalizeProviderKey } = require("../couriers/constants");

const courierStatusSchema = new mongoose.Schema(
  {
    courier: {
      type: String,
      required: true,
      trim: true,
      set: (value) => normalizeProviderKey(value) || String(value || "").trim(),
    },
    status: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } },
);

courierStatusSchema.index({ courier: 1, status: 1 }, { unique: true });

const CourierStatus =
  mongoose.models.courier_status ||
  mongoose.model("courier_status", courierStatusSchema);

module.exports = CourierStatus;

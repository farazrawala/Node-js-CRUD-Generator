const mongoose = require("mongoose");

/**
 * History of Big Commerce company connection actions.
 */
const modelSchema = new mongoose.Schema(
  {
    connection_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company_connection",
      required: true,
      index: true,
      field_name: "Connection",
    },
    action: {
      type: String,
      required: true,
      enum: ["requested", "approved", "rejected", "cancelled", "disconnected"],
      field_name: "Action",
    },
    performed_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Performed By",
    },
    remarks: {
      type: String,
      field_name: "Remarks",
    },
    timestamp: {
      type: Date,
      default: Date.now,
      field_name: "Timestamp",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company",
    },
  },
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

const MODEL = mongoose.model("company_connection_log", modelSchema);

module.exports = MODEL;

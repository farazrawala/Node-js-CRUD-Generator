const mongoose = require("mongoose");

/**
 * B2B company-to-company connection (Big Commerce module).
 * company_id = sender (requester); target_company_id = receiver.
 */
const modelSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Sender Company",
      index: true,
    },
    target_company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Receiver Company",
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    requested_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Requested By",
    },
    approved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Approved By",
    },
    approved_at: {
      type: Date,
      default: null,
      field_name: "Approved At",
    },
    rejected_at: {
      type: Date,
      default: null,
      field_name: "Rejected At",
    },
    remarks: {
      type: String,
      field_name: "Remarks",
    },
  },
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

// One active (pending/approved) pair in a given direction
modelSchema.index(
  { company_id: 1, target_company_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "approved"] },
    },
    name: "uniq_active_company_connection",
  },
);

const MODEL = mongoose.model("company_connection", modelSchema);

module.exports = MODEL;

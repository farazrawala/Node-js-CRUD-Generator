const mongoose = require("mongoose");

/**
 * Normalize to Pakistan international digits, e.g. 03132178663 → 923132178663
 */
function normalizeWhatsAppNumber(value) {
  if (value == null || value === "") return value;
  let digits = String(value).trim().replace(/\D/g, "");
  if (!digits) return value;

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("0")) {
    digits = `92${digits.slice(1)}`;
  }
  return digits;
}

const modelSchema = new mongoose.Schema(
  {
    number: {
      type: String,
      required: true,
      field_name: "WhatsApp Number",
      index: true,
      set: normalizeWhatsAppNumber,
    },
    message: {
      type: String,
      required: true,
      field_name: "Message",
    },
    status: {
      type: String,
      required: true,
      enum: ["not_started", "inprocess", "done"],
      default: "not_started",
      field_name: "Status",
      index: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
      index: true,
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

const MODEL = mongoose.model("whatsapp_message", modelSchema);

module.exports = MODEL;

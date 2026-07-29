const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    ticket_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "support_ticket",
      index: true,
    },
    message_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "support_message",
    },
    name: {
      type: String,
      required: true,
    },
    filename: {
      type: String,
      required: true,
    },
    url: {
      type: String,
    },
    path: {
      type: String,
      required: true,
    },
    mime_type: {
      type: String,
    },
    size: {
      type: Number,
    },
    uploaded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

attachmentSchema.index({ ticket_id: 1, uploaded_by: 1 });

const SupportAttachment = mongoose.model(
  "support_attachment",
  attachmentSchema,
);

module.exports = SupportAttachment;

const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    ticket_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "support_ticket",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      required: true,
    },
    message: {
      type: String,
      default: "",
    },
    is_internal: {
      type: Boolean,
      default: false,
    },
    attachments: [
      {
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
        name: String,
        filename: String,
        url: String,
        path: String,
        mime_type: String,
        size: Number,
      },
    ],
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

messageSchema.index({ ticket_id: 1, createdAt: 1 });
messageSchema.index({ ticket_id: 1, is_internal: 1 });

const SupportMessage = mongoose.model("support_message", messageSchema);

module.exports = SupportMessage;

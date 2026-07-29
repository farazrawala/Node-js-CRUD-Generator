const mongoose = require("mongoose");

const readSchema = new mongoose.Schema(
  {
    ticket_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "support_ticket",
      required: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    last_read_at: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

readSchema.index({ ticket_id: 1, user_id: 1 }, { unique: true });

const SupportTicketRead = mongoose.model("support_ticket_read", readSchema);

module.exports = SupportTicketRead;

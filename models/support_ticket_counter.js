const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema({
  company_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "company",
    required: true,
    unique: true,
  },
  seq: {
    type: Number,
    default: 0,
  },
});

const SupportTicketCounter = mongoose.model(
  "support_ticket_counter",
  counterSchema,
);

module.exports = SupportTicketCounter;

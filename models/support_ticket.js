const mongoose = require("mongoose");

const CATEGORY_VALUES = [
  "General",
  "Billing",
  "Technical",
  "Sales",
  "Feature Request",
  "Bug Report",
  "Other",
];

const PRIORITY_VALUES = ["low", "medium", "high", "urgent"];

const STATUS_VALUES = [
  "open",
  "pending",
  "waiting_for_user",
  "waiting_for_admin",
  "resolved",
  "closed",
];

const ticketSchema = new mongoose.Schema(
  {
    ticket_number: {
      type: String,
      required: true,
      field_name: "Ticket Number",
    },
    subject: {
      type: String,
      required: true,
      field_name: "Subject",
    },
    description: {
      type: String,
      field_name: "Description",
    },
    category: {
      type: String,
      required: true,
      enum: CATEGORY_VALUES,
      field_name: "Category",
    },
    priority: {
      type: String,
      required: true,
      enum: PRIORITY_VALUES,
      default: "medium",
      field_name: "Priority",
    },
    status: {
      type: String,
      required: true,
      enum: STATUS_VALUES,
      default: "open",
      field_name: "Status",
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "User",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    assigned_to: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      default: null,
      field_name: "Assigned To",
    },
    last_reply_at: {
      type: Date,
      default: null,
      field_name: "Last Reply At",
    },
    last_reply_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      default: null,
      field_name: "Last Reply By",
    },
    closed_at: {
      type: Date,
      default: null,
      field_name: "Closed At",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
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
  { timestamps: true },
);

ticketSchema.index({ company_id: 1, status: 1 });
ticketSchema.index({ company_id: 1, created_by: 1 });
ticketSchema.index({ company_id: 1, assigned_to: 1 });
ticketSchema.index(
  { company_id: 1, ticket_number: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
ticketSchema.index({ updatedAt: -1 });
ticketSchema.index({ last_reply_at: -1 });

const SupportTicket = mongoose.model("support_ticket", ticketSchema);

module.exports = SupportTicket;
module.exports.CATEGORY_VALUES = CATEGORY_VALUES;
module.exports.PRIORITY_VALUES = PRIORITY_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;

const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    message_id: {
      type: String,
      // required: true,
    },
    from_user_id: {
      type: String,
      required: true,
    },
    to_user_id: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    whatsapp_time: {
      type: String,
      field_name: "Whatsapp Time",
    },
    is_ai_resond:{
      type: Boolean,
      field_name: "Ai Responded",
      default: false,
    },
    chat_history:{
      type: String,
      field_name: "Chat History",
    },

    whatsapp_message_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "whatsapp_message",
      field_name: "Whatsapp Message ID",
    },
    /** WhatsApp's own id for a received message (from the extension), to tell repeats apart. */
    wa_message_key: {
      type: String,
    },

    /** "automation" = queued by a WhatsApp automation flow (sent first, oldest first). */
    source: {
      type: String,
      enum: ["automation"],
      field_name: "Source",
    },
    automation_session_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "wa_automation_session",
      field_name: "Automation Session",
    },
    /** Not handed to the extension before this time (flow "Delay" steps). */
    send_after: {
      type: Date,
      default: null,
      field_name: "Send After",
    },

    type: {
      type: String,
      enum: ["sent", "received"],
      default: "sent",
    },

    sending_status: {
      type: String,
      // required: true,
      enum: [
        "not_started",
        "inprocess",
        "sent",
        "not_available",
        "exceeded_limit",
      ],
      default: "not_started",
      field_name: "Status",
      index: true,
    },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
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
    status: {
      type: String,
      required: true,
      enum: [
        "not_started",
        "inprocess",
        "sent",
        "not_available",
        "active",
        "inactive",
      ],
      default: "not_started",
      field_name: "Status",
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

modelSchema.index(
  { company_id: 1, message_id: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deletedAt: null,
      type: "received",
      message_id: { $exists: true },
    },
  },
);

// fetch-random: oldest due automation reply first
modelSchema.index({ company_id: 1, source: 1, status: 1, createdAt: 1 });

const MODEL = mongoose.model("chat", modelSchema);

module.exports = MODEL;

const mongoose = require("mongoose");

/**
 * One automated WhatsApp conversation: which flow a customer is in, the step it
 * waits on, collected variables and a short transcript (shown in Automation Logs).
 *
 * status:  active (bot waits for the customer) | agent (handed to the team; bot
 *          stays quiet) | ended
 * outcome: in_progress | completed | handed_over | dropped | error
 */
const STATUS_VALUES = ["active", "agent", "ended"];
const OUTCOME_VALUES = ["in_progress", "completed", "handed_over", "dropped", "error"];
const TRANSCRIPT_LIMIT = 300;

const transcriptSchema = new mongoose.Schema(
  {
    from: { type: String, enum: ["customer", "bot", "system"], required: true },
    text: { type: String, default: "" },
    kind: { type: String, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, field_name: "Customer Phone" },
    customer_name: { type: String, default: "", field_name: "Customer Name" },
    flow_id: { type: mongoose.Schema.Types.ObjectId, ref: "wa_automation_flow", field_name: "Flow" },
    flow_name: { type: String, default: "", field_name: "Flow Name" },
    status: { type: String, enum: STATUS_VALUES, default: "active", field_name: "Status" },
    outcome: { type: String, enum: OUTCOME_VALUES, default: "in_progress", field_name: "Outcome" },

    node_id: { type: String, default: null },
    waiting: { type: mongoose.Schema.Types.Mixed, default: null },
    vars: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    products: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    invalid_count: { type: Number, default: 0 },
    handed_over: { type: Boolean, default: false },
    last_step: { type: String, default: "", field_name: "Last Step" },

    started_at: { type: Date, default: Date.now, field_name: "Started At" },
    last_activity_at: { type: Date, default: Date.now, field_name: "Last Activity" },
    ended_at: { type: Date, default: null, field_name: "Ended At" },
    messages_count: { type: Number, default: 0, field_name: "Messages" },
    transcript: { type: [transcriptSchema], default: [] },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    deletedAt: { type: Date, default: null, field_name: "Deleted At" },
  },
  { timestamps: true, minimize: false },
);

modelSchema.index({ company_id: 1, phone: 1, status: 1, last_activity_at: -1 });
modelSchema.index({ company_id: 1, started_at: -1 });
modelSchema.index({ company_id: 1, flow_id: 1, outcome: 1 });

const MODEL = mongoose.model("wa_automation_session", modelSchema);

module.exports = MODEL;
module.exports.STATUS_VALUES = STATUS_VALUES;
module.exports.OUTCOME_VALUES = OUTCOME_VALUES;
module.exports.TRANSCRIPT_LIMIT = TRANSCRIPT_LIMIT;

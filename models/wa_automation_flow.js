const mongoose = require("mongoose");

/**
 * WhatsApp automation flow (built in the ai-pos Flow Builder).
 * `nodes` is the editor's working copy; `live_nodes` is what customers get.
 * "Save as draft" only changes `nodes`; publishing / activating copies it to `live_nodes`.
 */
const TRIGGER_VALUES = ["keyword", "new_conversation", "order_placed", "order_delivered", "cart_abandoned"];
/** Triggers that can run today: both start from a customer's WhatsApp message. */
const AVAILABLE_TRIGGERS = ["keyword", "new_conversation"];
const STATUS_VALUES = ["draft", "active", "paused"];

const modelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, field_name: "Name" },
    description: { type: String, trim: true, maxlength: 500, default: "", field_name: "Description" },
    trigger: { type: String, enum: TRIGGER_VALUES, default: "keyword", field_name: "Trigger" },
    status: { type: String, enum: STATUS_VALUES, default: "draft", index: true, field_name: "Status" },
    nodes: { type: mongoose.Schema.Types.Mixed, default: () => [], field_name: "Steps" },
    live_nodes: { type: mongoose.Schema.Types.Mixed, default: null, field_name: "Published steps" },
    published_at: { type: Date, default: null, field_name: "Published At" },
    unpublished_changes: { type: Boolean, default: false, field_name: "Unpublished Changes" },
    created_by_name: { type: String, default: "", field_name: "Created By Name" },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: "user", field_name: "Created By" },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: "user", field_name: "Updated By" },
    deletedAt: { type: Date, default: null, field_name: "Deleted At" },
  },
  { timestamps: true, minimize: false },
);

modelSchema.index({ company_id: 1, deletedAt: 1, status: 1 });

const MODEL = mongoose.model("wa_automation_flow", modelSchema);

module.exports = MODEL;
module.exports.TRIGGER_VALUES = TRIGGER_VALUES;
module.exports.AVAILABLE_TRIGGERS = AVAILABLE_TRIGGERS;
module.exports.STATUS_VALUES = STATUS_VALUES;

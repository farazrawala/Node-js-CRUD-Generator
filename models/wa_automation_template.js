const mongoose = require("mongoose");

/** Reusable WhatsApp automation message (sent as plain text by the extension). */
const modelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, field_name: "Name" },
    category: { type: String, trim: true, maxlength: 40, default: "Utility", field_name: "Category" },
    language: { type: String, trim: true, maxlength: 40, default: "English", field_name: "Language" },
    content: { type: String, required: true, maxlength: 4096, field_name: "Content" },

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
  { timestamps: true },
);

modelSchema.index({ company_id: 1, deletedAt: 1 });

const MODEL = mongoose.model("wa_automation_template", modelSchema);

module.exports = MODEL;

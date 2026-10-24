const mongoose = require("mongoose");

// Quick note shortcuts per company (e.g. CNA → "Call not attended") shown in the OMS notes popup.
const modelSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },
    text: {
      type: String,
      trim: true,
      default: "",
    },
    sort_order: {
      type: Number,
      default: 0,
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
      enum: ["active", "inactive"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

const MODEL = mongoose.model("order_note_shortcuts", modelSchema);

module.exports = MODEL;

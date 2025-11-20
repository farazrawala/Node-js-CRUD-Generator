const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    tags: {
      type: [String],
    },
    description: {
      type: String,
    },

    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
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
  { timestamps: true }
);

const MODEL = mongoose.model("logs", modelSchema);

module.exports = MODEL;

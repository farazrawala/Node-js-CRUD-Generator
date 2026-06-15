const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    category_id: {
      field_name: "Category ID",
      type: mongoose.Schema.Types.ObjectId,
      ref: "category",
      required: true,
    },
    integration_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "integration",
      field_name: "Integration ID",
      required: true,
    },
    refference_id: {
      type: String,
      field_name: "Refference ID",
    },    // default fields
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

modelSchema.index(
  { company_id: 1, integration_id: 1, category_id: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
modelSchema.index({ company_id: 1, integration_id: 1, refference_id: 1 });

const SyncCategory = mongoose.model("sync_category", modelSchema);

module.exports = SyncCategory;
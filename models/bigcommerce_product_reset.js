const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: String,
      required: true,
    },
    reset_status: {
      type: String,
      required: true,
      enum: ["not_started", "inprogress", "failed"],
      default: "not_started",
    },
    reset_message: {
      type: String,
      default: "",
    },

    // default fields
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Posted User",
    },
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

const MODEL = mongoose.model("bigcommerce_product_reset", modelSchema);

module.exports = MODEL;

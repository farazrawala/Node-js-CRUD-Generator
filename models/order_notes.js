const mongoose = require("mongoose");

// One row per agent note on an order (OMS notes popup). `createdAt` + `created_by` give the feed its time and author.
const modelSchema = new mongoose.Schema(
  {
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
    },
    // `type` is a field name here, so it needs the nested { type: String } form.
    type: {
      type: String,
      default: "notes",
      trim: true,
    },
    note: {
      type: String,
      required: true,
      trim: true,
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

modelSchema.index({ company_id: 1, order_id: 1, createdAt: -1 });

const MODEL = mongoose.model("order_notes", modelSchema);

module.exports = MODEL;

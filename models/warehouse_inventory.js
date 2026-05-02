const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      index: true,
    },

    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      index: true,
    },

    // Current stock in this warehouse
    quantity: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },

    // image: {
    //   type: String,
    //   field_name: "Blog Image",
    //   field_type: "image",
    // },

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

// One live stock row per company + product + warehouse (avoids split quantities).
// Partial index: only rows with company_id and not soft-deleted participate.
modelSchema.index(
  { company_id: 1, product_id: 1, warehouse_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      company_id: { $exists: true, $ne: null },
      deletedAt: null,
    },
  },
);

modelSchema.index({ company_id: 1, warehouse_id: 1 });

const MODEL = mongoose.model("warehouse_inventory", modelSchema);

module.exports = MODEL;

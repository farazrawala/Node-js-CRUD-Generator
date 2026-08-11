const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    integration_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "integration",
      field_name: "Integration",
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      field_name: "Product",
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "category",
      field_name: "Category",
    },
    brand_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "brands",
      field_name: "Brand",
    },
    action: {
      type: String,
      required: true,
      enum: [
        "fetch_products",
        "fetch_product",
        "sync_product",
        "delete_product",

        "fetch_category",
        "sync_category",
        "delete_category",

        "fetch_brand",
        "sync_brand",
        "delete_brand",

        "fetch_order",
        "fetch_latest_order",
        "sync_order",
        "delete_order",

        "queue_bigcommerce_product_reset",
        "apply_bigcommerce_product_reset",
      ],
      field_name: "Action",
    },
    count: {
      type: Number,
      field_name: "Count",
      default: 0,
    },
    page: {
      type: Number,
      field_name: "Price",
      default: 1,
    },
    offset: {
      type: Number,
      default: 0,
      field_name: "Offset",
    },
    limit: {
      type: Number,
      field_name: "Limit",
      default: 1,
    },
    priority: {
      type: Number,
      field_name: "Priority",
      default: 100,
    },
    remarks: {
      type: String,
      field_name: "Remarks",
    },
    hits: {
      type: Number,
      field_name: "Hits",
      default: 0,
    },
    progress: {
      type: String,
      required: true,
      enum: ["not_started", "started", "completed", "failed","added_new"],
      default: "not_started",
      field_name: "Progress",
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
      enum: ["active", "inactive", "completed", "failed", "pending"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

/**
 * On insert: if the same product_id + action already has progress not_started,
 * mark those rows as added_new (superseded) then allow the new insert.
 */
modelSchema.pre("save", async function markSupersededNotStarted() {
  if (!this.isNew || !this.product_id) {
    return;
  }

  const filter = {
    product_id: this.product_id,
    action: this.action,
    progress: "not_started",
    deletedAt: null,
  };
  if (this.company_id) {
    filter.company_id = this.company_id;
  }
  if (this._id) {
    filter._id = { $ne: this._id };
  }

  const existing = await this.constructor
    .find(filter)
    .select("_id company_id")
    .lean();

  if (!existing.length) {
    return;
  }

  await this.constructor.updateMany(
    { _id: { $in: existing.map((row) => row._id) } },
    { $set: { progress: "added_new" } },
  );

  try {
    const { releaseProcessFromQueue } = require("../utils/processQueue");
    await Promise.all(
      existing.map((row) => releaseProcessFromQueue(row).catch(() => false)),
    );
  } catch (err) {
    console.warn(
      "[process] release superseded not_started:",
      err?.message || err,
    );
  }
});

modelSchema.post("save", function onProcessSaved(doc) {
  const { syncProcessQueueOnSave } = require("../utils/processQueue");
  syncProcessQueueOnSave(doc).catch((err) => {
    console.warn("[process-queue] sync on save:", err?.message || err);
  });
});

const MODEL = mongoose.model("process", modelSchema);

module.exports = MODEL;

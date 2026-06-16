const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
      field_name: "Product ID",
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
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

modelSchema.index(
  { company_id: 1, integration_id: 1, product_id: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
modelSchema.index({ company_id: 1, integration_id: 1, refference_id: 1 });

const SyncProduct = mongoose.model("sync_product", modelSchema);

async function dropObsoleteSyncProductCategoryIndex() {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return;
    }
    const coll = db.collection("sync_products");
    const indexes = await coll.indexes();
    for (const idx of indexes) {
      const key = idx.key || {};
      if (key.category_id != null) {
        await coll.dropIndex(idx.name);
        console.log(
          "[sync_product] Dropped obsolete category_id index:",
          idx.name,
        );
      }
    }
    const { dropped, created } = await SyncProduct.syncIndexes();
    if (dropped?.length || created?.length) {
      console.log("[sync_product] syncIndexes:", { dropped, created });
    }
  } catch (err) {
    console.warn("[sync_product] index migration:", err.message);
  }
}

if (mongoose.connection.readyState === 1) {
  void dropObsoleteSyncProductCategoryIndex();
} else {
  mongoose.connection.once("connected", dropObsoleteSyncProductCategoryIndex);
}

module.exports = SyncProduct;

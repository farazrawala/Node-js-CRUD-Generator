const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    brand_id: {
      field_name: "Brand ID",
      type: mongoose.Schema.Types.ObjectId,
      ref: "brands",
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
    }, // default fields
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
  { company_id: 1, integration_id: 1, brand_id: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
modelSchema.index({ company_id: 1, integration_id: 1, refference_id: 1 });

const SyncBrand = mongoose.model("sync_brand", modelSchema);

/**
 * Drop legacy unique index copied from sync_category (`category_id` on sync_brands).
 * That index only allows one row per company+integration when category_id is null,
 * which breaks sync_brand inserts and aborts fetch_brand parent linking.
 */
async function dropObsoleteSyncBrandCategoryIndex() {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      return;
    }
    const coll = db.collection("sync_brands");
    const indexes = await coll.indexes();
    for (const idx of indexes) {
      const key = idx.key || {};
      if (key.category_id != null) {
        await coll.dropIndex(idx.name);
        console.log(
          "[sync_brand] Dropped obsolete category_id index:",
          idx.name,
        );
      }
    }
    const { dropped, created } = await SyncBrand.syncIndexes();
    if (dropped?.length || created?.length) {
      console.log("[sync_brand] syncIndexes:", { dropped, created });
    }
  } catch (err) {
    console.warn("[sync_brand] index migration:", err.message);
  }
}

if (mongoose.connection.readyState === 1) {
  void dropObsoleteSyncBrandCategoryIndex();
} else {
  mongoose.connection.once("connected", dropObsoleteSyncBrandCategoryIndex);
}

module.exports = SyncBrand;

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
    movement_type: {
      type: String,
      enum: ["in", "out"],
      required: true,
    },
    unit_cost: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    total_cost: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },

    // Logical source of the movement (table / module name), not an ObjectId.
    reference_type: {
      type: String,
      trim: true,
      required: true,
      field_name: "Reference Table Name",
    },
    reference_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      field_name: "Reference Table ID", // : purchase_order_item_id, order_item_id, adjustment_id, manual_id
    },
    reference_name: {
      type: String, //reference name : purchase order, order, adjustment, manual
      required: true,
      field_name: "Reference Name",
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
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

// Many movement rows per product/warehouse (ledger). Do not use a unique
// (company_id, product_id, warehouse_id) index — that belongs on warehouse_inventory.
modelSchema.index(
  { company_id: 1, product_id: 1, warehouse_id: 1, createdAt: -1 },
  {
    partialFilterExpression: {
      company_id: { $exists: true, $ne: null },
      deletedAt: null,
    },
  },
);

modelSchema.index({ company_id: 1, warehouse_id: 1 });

/** PO/PR/update soft-delete: `updateMany` by tenant + reference (not full ledger scan). */
modelSchema.index(
  { company_id: 1, reference_type: 1, reference_id: 1 },
  {
    name: "inv_mov_company_ref",
    partialFilterExpression: {
      status: "active",
      deletedAt: null,
      company_id: { $exists: true, $ne: null },
    },
  },
);

/**
 * Soft-delete active movement rows for one document reference (e.g. purchase_order id).
 * Include `companyId` so Mongo can use `inv_mov_company_ref` index.
 */
modelSchema.statics.softDeleteActiveByReference = async function ({
  referenceType,
  referenceId,
  companyId = null,
  session = null,
  userId = null,
} = {}) {
  const refType = String(referenceType ?? "").trim();
  const refIdStr = String(referenceId ?? "").trim();
  if (!refType || !mongoose.Types.ObjectId.isValid(refIdStr)) {
    return { acknowledged: true, modifiedCount: 0, matchedCount: 0 };
  }

  const refOid =
    referenceId instanceof mongoose.Types.ObjectId ?
      referenceId
    : new mongoose.Types.ObjectId(refIdStr);

  const filter = {
    reference_type: refType,
    reference_id: refOid,
    status: "active",
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  const companyIdStr = String(companyId ?? "").trim();
  if (companyId != null && mongoose.Types.ObjectId.isValid(companyIdStr)) {
    filter.company_id =
      companyId instanceof mongoose.Types.ObjectId ?
        companyId
      : new mongoose.Types.ObjectId(companyIdStr);
  }

  const $set = {
    deletedAt: new Date(),
    status: "inactive",
  };
  const userIdStr = String(userId ?? "").trim();
  if (userId != null && mongoose.Types.ObjectId.isValid(userIdStr)) {
    $set.updated_by =
      userId instanceof mongoose.Types.ObjectId ?
        userId
      : new mongoose.Types.ObjectId(userIdStr);
  }

  const opts = session ? { session } : {};
  return this.updateMany(filter, { $set }, opts);
};

const MODEL = mongoose.model("inventory_movements", modelSchema);

async function dropObsoleteInventoryMovementUniqueIndex() {
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    const coll = db.collection("inventory_movements");
    const indexes = await coll.indexes();
    for (const idx of indexes) {
      const k = idx.key || {};
      if (
        idx.unique &&
        Object.keys(k).length === 3 &&
        k.company_id === 1 &&
        k.product_id === 1 &&
        k.warehouse_id === 1
      ) {
        await coll.dropIndex(idx.name);
        console.log(
          "[inventory_movements] Dropped obsolete unique index (allows multiple movements):",
          idx.name,
        );
      }
    }
  } catch (err) {
    console.warn("[inventory_movements] index migration:", err.message);
  }
}

if (mongoose.connection.readyState === 1) {
  void dropObsoleteInventoryMovementUniqueIndex();
} else {
  mongoose.connection.once(
    "connected",
    dropObsoleteInventoryMovementUniqueIndex,
  );
}

module.exports = MODEL;

const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const modelSchema = new mongoose.Schema(
  {
    parent_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      field_name: "Parent Product",
    },
    product_name: {
      type: String,
      required: true,
      field_name: "Product Name",
    },
    product_code: {
      type: String,
      field_name: "Product code",
    },
    alert_qty: {
      type: Number,
      field_name: "Alert Qty",
      default: 0,
    },
    brand_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "brands",
      field_name: "Brand Name",
    },
    unit: {
      type: String,
      required: true,
      field_type: "select",
      enum: [
        "Piece",
        "Ltr",
        "Box",
        "Meter",
        "Feet",
        "Yard",
        "Inch",
        "Centimeter",
        "Millimeter",
        "Others",
      ],
      default: "Piece",
    },
    weight: {
      type: Number,
      field_name: "Weight",
    },
    length: {
      type: Number,
      field_name: "Length",
    },
    width: {
      type: Number,
      field_name: "Width",
    },
    height: {
      type: Number,
      field_name: "Height",
    },
    dimension: {
      type: String,
      field_name: "Dimension",
    },
    tax_rate: {
      type: Number,
      field_name: "Tax Rate",
    },
    barcode: {
      type: String,
      field_name: "Product Barcode",
    },
    sku: {
      type: String,
      field_name: "SKU",
    },
    product_type: {
      type: String,
      required: true,
      enum: ["Single", "Variable"],
      default: "Single",
    },
    category_id: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "category",
      default: [],
      // required: true,
      field_name: "Category",
      field_type: "multiselect",
    },
    product_relations: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "product_relations",
      default: [],
      field_name: "Product Relations",
    },

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
      field_name: "Company",
    },
    product_slug: {
      type: String,
      field_name: "Product Slug",
      default: null,
      set: function (value) {
        // If value provided, slugify it to ensure it's URL-friendly
        if (
          value &&
          value !== "" &&
          value !== "null" &&
          value !== null &&
          value !== undefined
        ) {
          return generateSlug(value);
        }
        // Return null for empty values - will be handled in pre-save hook
        return null;
      },
    },
    warehouse_inventory: {
      type: [
        {
          warehouse_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "warehouse",
            required: true,
            field_name: "Warehouse",
          },
          quantity: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
            field_name: "Quantity",
          },
          quantity_action: {
            type: String,
            enum: ["add", "subtract"],
            default: "add",
            field_type: "select",
            field_name: "Quantity Action",
          },
          // default_warehouse: {
          //   type: Boolean,
          //   default: false,
          //   field_name: "Default",
          // },
          last_updated: {
            type: Date,
            default: Date.now,
            field_name: "Last Updated",
          },
        },
      ],
      default: [],
      field_name: "Warehouse Inventory",
    },
    wholesale_price: {
      type: Number,
      field_name: "Wholesale Price",
    },
    product_price: {
      type: String,
      required: true,
      field_name: "Product Price",
    },
    product_description: {
      type: String,
      field_name: "Product Description",
    },
    product_image: {
      type: String,
      field_type: "image",
      field_name: "Featured Image",
    },
    multi_images: {
      type: [String],
      field_type: "image",
      field_name: "Multiple Images",
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

// Pre-validate hook to handle slug generation before validation (runs first)
modelSchema.pre("validate", function (next) {
  console.log("🔧 Pre-validate hook - product_name:", this.product_name);
  console.log("🔧 Pre-validate hook - product_slug before:", this.product_slug);
  if (
    !this.product_type ||
    this.product_type === "" ||
    this.product_type === null
  ) {
    this.product_type = "Single";
  }

  // If slug is empty, null, or undefined, generate it from product_name
  if (
    (!this.product_slug ||
      this.product_slug === "" ||
      this.product_slug === null) &&
    this.product_name
  ) {
    const newSlug = generateSlug(this.product_name);
    console.log("✅ Generated new slug in validate:", newSlug);
    this.product_slug = newSlug;
  }
  next();
});

// Pre-save hook to ensure slug is always generated from product_name if empty (backup)
// Also normalize parent_product_id to null when missing
modelSchema.pre("save", function (next) {
  console.log("🔧 Pre-save hook - product_name:", this.product_name);
  console.log("🔧 Pre-save hook - product_slug before:", this.product_slug);
  console.log(
    "🔧 Pre-save hook - parent_product_id before:",
    this.parent_product_id,
  );
  console.log("🔧 Pre-save hook - product_type:", this.product_type);
  if (
    !this.product_type ||
    this.product_type === "" ||
    this.product_type === null
  ) {
    this.product_type = "Single";
  }

  // If slug is still empty, null, or undefined, generate it from product_name
  if (
    (!this.product_slug ||
      this.product_slug === "" ||
      this.product_slug === null) &&
    this.product_name
  ) {
    const newSlug = generateSlug(this.product_name);
    console.log("✅ Generated new slug in save:", newSlug);
    this.product_slug = newSlug;
  }

  // Keep parent_product_id null when value is missing/empty
  if (
    !this.parent_product_id ||
    this.parent_product_id === "" ||
    this.parent_product_id === null
  ) {
    this.parent_product_id = null;
    console.log("✅ Normalized parent_product_id to null");
  }

  console.log("🔧 Pre-save hook - product_slug after:", this.product_slug);
  console.log(
    "🔧 Pre-save hook - parent_product_id after:",
    this.parent_product_id,
  );
  next();
});

// Instance method to add or update warehouse inventory
modelSchema.methods.setWarehouseQuantity = function (warehouseId, quantity) {
  const existingIndex = this.warehouse_inventory.findIndex(
    (item) => item.warehouse_id.toString() === warehouseId.toString(),
  );

  if (existingIndex >= 0) {
    // Update existing warehouse quantity
    this.warehouse_inventory[existingIndex].quantity = quantity;
    this.warehouse_inventory[existingIndex].quantity_action = "add";
    this.warehouse_inventory[existingIndex].last_updated = new Date();
  } else {
    // Add new warehouse inventory entry
    this.warehouse_inventory.push({
      warehouse_id: warehouseId,
      quantity: quantity,
      quantity_action: "add",
      last_updated: new Date(),
    });
  }
  return this;
};

// Instance method to get quantity for a specific warehouse
modelSchema.methods.getWarehouseQuantity = function (warehouseId) {
  const inventory = this.warehouse_inventory.find(
    (item) => item.warehouse_id.toString() === warehouseId.toString(),
  );
  return inventory ? inventory.quantity : 0;
};

// Instance method to get total quantity across all warehouses
modelSchema.methods.getTotalQuantity = function () {
  return this.warehouse_inventory.reduce(
    (total, item) => total + item.quantity,
    0,
  );
};

// Instance method to check if product is in stock at a specific warehouse
modelSchema.methods.isInStock = function (warehouseId, requiredQuantity = 1) {
  const availableQuantity = this.getWarehouseQuantity(warehouseId);
  return availableQuantity >= requiredQuantity;
};

// Instance method to decrease quantity (for orders)
modelSchema.methods.decreaseWarehouseQuantity = function (
  warehouseId,
  quantity,
) {
  const existingIndex = this.warehouse_inventory.findIndex(
    (item) => item.warehouse_id.toString() === warehouseId.toString(),
  );

  if (existingIndex >= 0) {
    const currentQty = this.warehouse_inventory[existingIndex].quantity;
    if (currentQty >= quantity) {
      this.warehouse_inventory[existingIndex].quantity -= quantity;
      this.warehouse_inventory[existingIndex].quantity_action = "subtract";
      this.warehouse_inventory[existingIndex].last_updated = new Date();
      return true;
    }
    throw new Error(
      `Insufficient quantity. Available: ${currentQty}, Requested: ${quantity}`,
    );
  }
  throw new Error("Warehouse not found in inventory");
};

// Instance method to increase quantity (for restocking)
modelSchema.methods.increaseWarehouseQuantity = function (
  warehouseId,
  quantity,
) {
  const existingIndex = this.warehouse_inventory.findIndex(
    (item) => item.warehouse_id.toString() === warehouseId.toString(),
  );

  if (existingIndex >= 0) {
    this.warehouse_inventory[existingIndex].quantity += quantity;
    this.warehouse_inventory[existingIndex].quantity_action = "add";
    this.warehouse_inventory[existingIndex].last_updated = new Date();
  } else {
    this.warehouse_inventory.push({
      warehouse_id: warehouseId,
      quantity: quantity,
      quantity_action: "add",
      last_updated: new Date(),
    });
  }
  return this;
};

const MODEL = mongoose.model("product", modelSchema);

module.exports = MODEL;

const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const modelSchema = new mongoose.Schema(
  {
    parent_product_id: {
      type: String,
      // required: true,
      field_name: "Parent Product",
    },
    product_name: {
      type: String,
      required: true,
      field_name: "Product Name",
    },
    product_slug: {
      type: String,
      field_name: "Product Slug",
      default: null,
      set: function(value) {
        // If value provided, slugify it to ensure it's URL-friendly
        if (value && value !== '' && value !== 'null' && value !== null && value !== undefined) {
          return generateSlug(value);
        }
        // Return null for empty values - will be handled in pre-save hook
        return null;
      }
    },
    warehouse_inventory: {
      type: [
        {
          warehouse_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "warehouse",
            required: true,
            field_name: "Warehouse"
          },
          quantity: {
            type: Number,
            required: true,
            default: 0,
            min: 0,
            field_name: "Quantity"
          },
          last_updated: {
            type: Date,
            default: Date.now,
            field_name: "Last Updated"
          }
        }
      ],
      default: [],
      field_name: "Warehouse Inventory"
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
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true }
);

// Pre-validate hook to handle slug generation before validation (runs first)
modelSchema.pre('validate', function(next) {
  console.log('🔧 Pre-validate hook - product_name:', this.product_name);
  console.log('🔧 Pre-validate hook - product_slug before:', this.product_slug);
  
  // If slug is empty, null, or undefined, generate it from product_name
  if ((!this.product_slug || this.product_slug === '' || this.product_slug === null) && this.product_name) {
    const newSlug = generateSlug(this.product_name);
    console.log('✅ Generated new slug in validate:', newSlug);
    this.product_slug = newSlug;
  }
  next();
});

// Pre-save hook to ensure slug is always generated from product_name if empty (backup)
modelSchema.pre('save', function(next) {
  console.log('🔧 Pre-save hook - product_name:', this.product_name);
  console.log('🔧 Pre-save hook - product_slug before:', this.product_slug);
  
  // If slug is still empty, null, or undefined, generate it from product_name
  if ((!this.product_slug || this.product_slug === '' || this.product_slug === null) && this.product_name) {
    const newSlug = generateSlug(this.product_name);
    console.log('✅ Generated new slug in save:', newSlug);
    this.product_slug = newSlug;
  }
  
  console.log('🔧 Pre-save hook - product_slug after:', this.product_slug);
  next();
});

// Instance method to add or update warehouse inventory
modelSchema.methods.setWarehouseQuantity = function(warehouseId, quantity) {
  const existingIndex = this.warehouse_inventory.findIndex(
    item => item.warehouse_id.toString() === warehouseId.toString()
  );

  if (existingIndex >= 0) {
    // Update existing warehouse quantity
    this.warehouse_inventory[existingIndex].quantity = quantity;
    this.warehouse_inventory[existingIndex].last_updated = new Date();
  } else {
    // Add new warehouse inventory entry
    this.warehouse_inventory.push({
      warehouse_id: warehouseId,
      quantity: quantity,
      last_updated: new Date()
    });
  }
  return this;
};

// Instance method to get quantity for a specific warehouse
modelSchema.methods.getWarehouseQuantity = function(warehouseId) {
  const inventory = this.warehouse_inventory.find(
    item => item.warehouse_id.toString() === warehouseId.toString()
  );
  return inventory ? inventory.quantity : 0;
};

// Instance method to get total quantity across all warehouses
modelSchema.methods.getTotalQuantity = function() {
  return this.warehouse_inventory.reduce((total, item) => total + item.quantity, 0);
};

// Instance method to check if product is in stock at a specific warehouse
modelSchema.methods.isInStock = function(warehouseId, requiredQuantity = 1) {
  const availableQuantity = this.getWarehouseQuantity(warehouseId);
  return availableQuantity >= requiredQuantity;
};

// Instance method to decrease quantity (for orders)
modelSchema.methods.decreaseWarehouseQuantity = function(warehouseId, quantity) {
  const existingIndex = this.warehouse_inventory.findIndex(
    item => item.warehouse_id.toString() === warehouseId.toString()
  );

  if (existingIndex >= 0) {
    const currentQty = this.warehouse_inventory[existingIndex].quantity;
    if (currentQty >= quantity) {
      this.warehouse_inventory[existingIndex].quantity -= quantity;
      this.warehouse_inventory[existingIndex].last_updated = new Date();
      return true;
    }
    throw new Error(`Insufficient quantity. Available: ${currentQty}, Requested: ${quantity}`);
  }
  throw new Error('Warehouse not found in inventory');
};

// Instance method to increase quantity (for restocking)
modelSchema.methods.increaseWarehouseQuantity = function(warehouseId, quantity) {
  const existingIndex = this.warehouse_inventory.findIndex(
    item => item.warehouse_id.toString() === warehouseId.toString()
  );

  if (existingIndex >= 0) {
    this.warehouse_inventory[existingIndex].quantity += quantity;
    this.warehouse_inventory[existingIndex].last_updated = new Date();
  } else {
    this.warehouse_inventory.push({
      warehouse_id: warehouseId,
      quantity: quantity,
      last_updated: new Date()
    });
  }
  return this;
};

const MODEL = mongoose.model("product", modelSchema);

module.exports = MODEL;

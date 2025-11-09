const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
} = require("../utils/modelHelper");
const Product = require("../models/product");
const { generateProductBarcode } = require("../utils/barcodeGenerator");

async function productCreateVariation(req, res) {
  try {
    // console.log("🔧 Product create variation - req.body keys:", Object.keys(req.body));
  // cconsole.log("🔧 Product create variation - req.user.company_id:", req.user.company_id);
      const company = await handleGenericFindOne(req, "company", {
        searchCriteria: { 
          _id: req.user.company_id,
          deletedAt: null 
        },
        excludeFields: []
      });

      if (!company.success || !company.data) {
        return res.status(404).json({
          success: false,
          message: "Company not found"
        });
      }
  
      // Initialize warehouse_inventory array if it doesn't exist
      if (!req.body.warehouse_inventory) {
        req.body.warehouse_inventory = [];
      }
      
      // Ensure it's an array
      if (!Array.isArray(req.body.warehouse_inventory)) {
        req.body.warehouse_inventory = [req.body.warehouse_inventory];
      }
      
      // Initialize first element if it doesn't exist
      if (!req.body.warehouse_inventory[0]) {
        req.body.warehouse_inventory[0] = {};
      }
      
      // Set warehouse_id and quantity
      req.body.warehouse_inventory[0].warehouse_id = company.data.warehouse_id;
      req.body.warehouse_inventory[0].quantity = req.body.quantity || 0;
      req.body.warehouse_inventory[0].last_updated = new Date();
      
      // Set company_id if not already set
      if (!req.body.company_id && company.data._id) {
        req.body.company_id = company.data._id.toString();
      }

      console.log("🔧 Product create variation - req.body:", req.body);
      const variations = [];

      for (const key in req.body) {
        const match = key.match(/^variations\[(\d+)\]\[(.+)\]$/);
        if (match) {
          const index = parseInt(match[1]);
          const field = match[2];

          // ensure object exists at that index
          if (!variations[index]) variations[index] = {};

          variations[index][field] = req.body[key];
        }
      }



    const parentProductResponse = await handleGenericCreate(req, "product", {
      afterCreate: async (record, req) => {
        console.log("✅ Parent product created successfully:", record);
      },
    });

    // Check if parent product was created successfully
    if (!parentProductResponse.success || !parentProductResponse.data || !parentProductResponse.data._id) {
      console.error("❌ Failed to create parent product:", parentProductResponse);
      return res.status(parentProductResponse.status || 500).json({
        success: false,
        message: "Failed to create parent product",
        error: parentProductResponse.error || parentProductResponse
      });
    }

    console.log("✅ Parent product created with ID:", parentProductResponse.data._id);

    if (variations.length > 0) {
      for (const variation of variations) {
        const variant = {};
        variant.body = { ...variation }; 
        variant.body.company_id = company.data._id.toString();
        variant.body.warehouse_inventory = [
          {
            warehouse_id: company.data.warehouse_id,
            quantity: variation.quantity || 0,
            last_updated: new Date()
          }
        ];
        variant.body.product_name = variation.product_name;
        variant.body.parent_product_id = parentProductResponse.data._id.toString();
        variant.body.product_price = variation.product_price;
        variant.body.product_description = variation.product_description;
        const variationResponse = await handleGenericCreate(variant, "product", {
          afterCreate: async (record, req) => {
            console.log("✅ Product variation created successfully:", record);
          },
        });
        console.log("🔧 Product create variation - response:", variationResponse);
        // return res.status(variationResponse.status).json(variationResponse);
      }
    }
    return res.status(parentProductResponse.status || 200).json(parentProductResponse);

  } catch (error) {
    console.error("❌ Product create variation error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function productCreate(req, res) {
  console.log("🔧 Product create - req.body:", req.body);
  console.log("🔧 Product create - req.body keys:", Object.keys(req.body));
  
  // Generate unique EAN13 barcode if barcode is empty
  if (!req.body.barcode || req.body.barcode.trim() === "") {
    req.body.barcode = generateProductBarcode();
    console.log("🏷️ Generated new EAN13 barcode:", req.body.barcode);
  }
  
  // Ensure parent_product_id is set for single products
  // If product_type is Single and parent_product_id is not provided, it will be set in the model hook
  // For variant products, parent_product_id should be explicitly provided
  
  const response = await handleGenericCreate(req, "product", {
    afterCreate: async (record, req) => {
      console.log("✅ Product created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function productUpdate(req, res) {
  const response = await handleGenericUpdate(req, "product", {
    beforeUpdate: async (updateData, req, existingRecord) => {
      console.log('🔧 Product update - beforeUpdate hook called');
      console.log('🔧 Original updateData.warehouse_inventory:', updateData.warehouse_inventory);
      
      // Process warehouse inventory if present
      if (req.body.warehouse_inventory) {
        const warehouseInventory = [];
        const inventoryData = req.body.warehouse_inventory;
        
        // Handle object format from form (e.g., warehouse_inventory[0][warehouse_id])
        if (typeof inventoryData === 'object' && !Array.isArray(inventoryData)) {
          // Convert object format to array
          Object.keys(inventoryData).forEach(key => {
            const item = inventoryData[key];
            if (item.warehouse_id && item.quantity !== undefined) {
              warehouseInventory.push({
                warehouse_id: item.warehouse_id,
                quantity: parseInt(item.quantity) || 0,
                last_updated: new Date()
              });
            }
          });
        } else if (Array.isArray(inventoryData)) {
          inventoryData.forEach(item => {
            if (item.warehouse_id && item.quantity !== undefined) {
              warehouseInventory.push({
                warehouse_id: item.warehouse_id,
                quantity: parseInt(item.quantity) || 0,
                last_updated: new Date()
              });
            }
          });
        }
        
        // Update the updateData with processed inventory
        updateData.warehouse_inventory = warehouseInventory;
        console.log('✅ Processed warehouse inventory in controller:', warehouseInventory);
      } else {
        // Check for warehouse_inventory fields with different patterns
        const warehouseFields = Object.keys(req.body).filter(key => key.includes('warehouse_inventory'));
        
        if (warehouseFields.length > 0) {
          console.log('🔧 Found warehouse fields in controller:', warehouseFields);
          const warehouseInventory = [];
          
          // Try to parse the warehouse_inventory data from the field names
          const inventoryData = {};
          warehouseFields.forEach(field => {
            const match = field.match(/warehouse_inventory\[(\d+)\]\[(\w+)\]/);
            if (match) {
              const [, index, property] = match;
              if (!inventoryData[index]) {
                inventoryData[index] = {};
              }
              inventoryData[index][property] = req.body[field];
            }
          });
          
          // Convert to array format
          Object.keys(inventoryData).forEach(key => {
            const item = inventoryData[key];
            if (item.warehouse_id && item.quantity !== undefined) {
              warehouseInventory.push({
                warehouse_id: item.warehouse_id,
                quantity: parseInt(item.quantity) || 0,
                last_updated: new Date()
              });
            }
          });
          
          updateData.warehouse_inventory = warehouseInventory;
          console.log('✅ Processed warehouse inventory from field names in controller:', warehouseInventory);
        }
      }
    },
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function productById(req, res) {
  const response = await handleGenericGetById(req, "product", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllProducts(req, res) {
  const response = await handleGenericGetAll(req, "product", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
      {
        path: "warehouse_inventory.warehouse_id",
        select: "warehouse_name",
      },
      {
        path: "category_id",
        select: "name",
      },
    ],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
    filter: {
      $or: [
        { parent_product_id: { $exists: false } },
        { parent_product_id: null }
      ]
    },
  });
  return res.status(response.status).json(response);
}

/**
 * Update warehouse quantity for a product
 * Body: { warehouse_id, quantity, operation: "set" | "increase" | "decrease" }
 */
async function updateWarehouseQuantity(req, res) {
  try {
    const { id: productId } = req.params;
    const { warehouse_id, quantity, operation = "set" } = req.body;

    console.log("🏪 Updating warehouse quantity:", {
      productId,
      warehouse_id,
      quantity,
      operation
    });

    // Validation
    if (!warehouse_id || quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "warehouse_id and quantity are required"
      });
    }

    if (quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot be negative"
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    // Perform the operation
    switch (operation) {
      case "set":
        product.setWarehouseQuantity(warehouse_id, quantity);
        break;
      case "increase":
        product.increaseWarehouseQuantity(warehouse_id, quantity);
        break;
      case "decrease":
        product.decreaseWarehouseQuantity(warehouse_id, quantity);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: "Invalid operation. Use 'set', 'increase', or 'decrease'"
        });
    }

    await product.save();

    console.log("✅ Warehouse quantity updated successfully");

    return res.status(200).json({
      success: true,
      message: "Warehouse quantity updated successfully",
      data: product
    });
  } catch (error) {
    console.error("❌ Update warehouse quantity error:", error);
    
    // Handle specific errors
    if (error.message.includes("Insufficient quantity")) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes("Warehouse not found")) {
      return res.status(404).json({
        success: false,
        message: error.message
      });
    }
    
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

/**
 * Get warehouse inventory for a product
 */
async function getProductWarehouseInventory(req, res) {
  try {
    const { id: productId } = req.params;

    const product = await Product.findById(productId)
      .populate("warehouse_inventory.warehouse_id", "warehouse_name warehouse_address status");

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const totalQuantity = product.getTotalQuantity();

    return res.status(200).json({
      success: true,
      data: {
        product_id: product._id,
        product_name: product.product_name,
        warehouse_inventory: product.warehouse_inventory,
        total_quantity: totalQuantity
      }
    });
  } catch (error) {
    console.error("❌ Get warehouse inventory error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

/**
 * Check product availability at a specific warehouse
 */
async function checkWarehouseStock(req, res) {
  try {
    const { id: productId } = req.params;
    const { warehouse_id, quantity = 1 } = req.query;

    if (!warehouse_id) {
      return res.status(400).json({
        success: false,
        message: "warehouse_id is required"
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    const availableQuantity = product.getWarehouseQuantity(warehouse_id);
    const isAvailable = product.isInStock(warehouse_id, parseInt(quantity));

    return res.status(200).json({
      success: true,
      data: {
        product_id: product._id,
        product_name: product.product_name,
        warehouse_id,
        available_quantity: availableQuantity,
        requested_quantity: parseInt(quantity),
        is_available: isAvailable
      }
    });
  } catch (error) {
    console.error("❌ Check warehouse stock error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

/**
 * Get products by warehouse
 */
async function getProductsByWarehouse(req, res) {
  try {
    const { warehouseId } = req.params;

    const products = await Product.find({
      "warehouse_inventory.warehouse_id": warehouseId,
      "warehouse_inventory.quantity": { $gt: 0 }
    }).populate("warehouse_inventory.warehouse_id", "warehouse_name warehouse_address");

    return res.status(200).json({
      success: true,
      count: products.length,
      data: products.map(product => ({
        _id: product._id,
        product_name: product.product_name,
        product_price: product.product_price,
        warehouse_quantity: product.getWarehouseQuantity(warehouseId),
        total_quantity: product.getTotalQuantity()
      }))
    });
  } catch (error) {
    console.error("❌ Get products by warehouse error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error"
    });
  }
}

module.exports = {
  productCreate,
  productUpdate,
  productById,
  getAllProducts,
  updateWarehouseQuantity,
  getProductWarehouseInventory,
  checkWarehouseStock,
  getProductsByWarehouse,
  productCreateVariation
};

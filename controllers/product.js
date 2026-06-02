const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  parseSearchFieldsFromQuery,
  coalesceObjectId,
} = require("../utils/modelHelper");
const Product = require("../models/product");
const WarehouseInventory = require("../models/warehouse_inventory");
const Logs = require("../models/logs");
const Warehouse = require("../models/warehouse");
const { generateProductBarcode } = require("../utils/barcodeGenerator");

function normalizeWarehouseInventoryInput(reqBody) {
  if (reqBody.warehouse_inventory) {
    const inventoryData = reqBody.warehouse_inventory;
    const normalized = [];

    if (typeof inventoryData === "object" && !Array.isArray(inventoryData)) {
      Object.keys(inventoryData).forEach((key) => {
        const item = inventoryData[key];
        if (item && item.warehouse_id && item.quantity !== undefined) {
          normalized.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            quantity_action: item.quantity_action || "add",
          });
        }
      });
    } else if (Array.isArray(inventoryData)) {
      inventoryData.forEach((item) => {
        if (item && item.warehouse_id && item.quantity !== undefined) {
          normalized.push({
            warehouse_id: item.warehouse_id,
            quantity: parseInt(item.quantity) || 0,
            quantity_action: item.quantity_action || "add",
          });
        }
      });
    }

    return normalized;
  }

  const warehouseFields = Object.keys(reqBody).filter((key) =>
    key.includes("warehouse_inventory"),
  );

  if (warehouseFields.length === 0) {
    return null;
  }

  const inventoryData = {};
  warehouseFields.forEach((field) => {
    const match = field.match(/warehouse_inventory\[(\d+)\]\[(\w+)\]/);
    if (match) {
      const [, index, property] = match;
      if (!inventoryData[index]) {
        inventoryData[index] = {};
      }
      inventoryData[index][property] = reqBody[field];
    }
  });

  const normalized = [];
  Object.keys(inventoryData).forEach((key) => {
    const item = inventoryData[key];
    if (item && item.warehouse_id && item.quantity !== undefined) {
      normalized.push({
        warehouse_id: item.warehouse_id,
        quantity: parseInt(item.quantity) || 0,
        quantity_action: item.quantity_action || "add",
      });
    }
  });

  return normalized;
}

function mergeWarehouseInventory(
  existingInventory = [],
  incomingInventory = [],
) {
  const inventoryMap = new Map();
  const changes = [];

  existingInventory.forEach((item) => {
    const warehouseId = item?.warehouse_id?.toString();
    if (!warehouseId) return;
    inventoryMap.set(warehouseId, {
      warehouse_id: item.warehouse_id,
      quantity: parseInt(item.quantity) || 0,
      quantity_action: item.quantity_action || "add",
      last_updated: item.last_updated || new Date(),
    });
  });

  incomingInventory.forEach((item) => {
    const warehouseId = item?.warehouse_id?.toString();
    if (!warehouseId) return;

    const current = inventoryMap.get(warehouseId) || {
      warehouse_id: item.warehouse_id,
      quantity: 0,
      quantity_action: "add",
      last_updated: new Date(),
    };

    const changeQty = parseInt(item.quantity) || 0;
    const action = item.quantity_action === "subtract" ? "subtract" : "add";

    const previousQuantity = parseInt(current.quantity) || 0;
    current.quantity =
      action === "subtract" ?
        Math.max(0, current.quantity - changeQty)
      : current.quantity + changeQty;
    current.quantity_action = action;
    current.last_updated = new Date();

    if (previousQuantity !== current.quantity) {
      changes.push({
        warehouse_id: warehouseId,
        action,
        from_qty: previousQuantity,
        to_qty: current.quantity,
      });
    }

    inventoryMap.set(warehouseId, current);
  });

  return {
    mergedInventory: Array.from(inventoryMap.values()),
    changes,
  };
}

function getIncomingInventoryForMerge(updateData, reqBody) {
  // Prefer updateData because handleGenericUpdate may normalize nested
  // array fields and remove raw form-data keys from req.body before hooks run.
  const fromUpdateData = normalizeWarehouseInventoryInput({
    warehouse_inventory: updateData?.warehouse_inventory,
  });
  if (fromUpdateData && fromUpdateData.length > 0) {
    return fromUpdateData;
  }

  return normalizeWarehouseInventoryInput(reqBody);
}

async function createWarehouseStockLogs(changes, req, productName) {
  if (!Array.isArray(changes) || changes.length === 0) return;

  const warehouseIds = [
    ...new Set(changes.map((change) => change.warehouse_id).filter(Boolean)),
  ];
  let warehouseNameMap = new Map();

  if (warehouseIds.length > 0) {
    try {
      const warehouses = await Warehouse.find({ _id: { $in: warehouseIds } })
        .select("_id warehouse_name name")
        .lean();
      warehouseNameMap = new Map(
        warehouses.map((warehouse) => [
          warehouse._id.toString(),
          warehouse.warehouse_name || warehouse.name || "Unknown Warehouse",
        ]),
      );
    } catch (error) {
      console.error("❌ Failed to fetch warehouse names for logs:", error);
    }
  }

  const logsToCreate = changes.map((change) => ({
    action: "product_stock_update",
    url: req.originalUrl || req.url || "/api/product/update",
    tags: ["product", "warehouse", "stock", change.action],
    description: `${productName} :: warehouse ${warehouseNameMap.get(change.warehouse_id) || "Unknown Warehouse"} (${change.warehouse_id}) is updating from ${change.from_qty} to ${change.to_qty}.`,
    company_id: req.user?.company_id || null,
    created_by: req.user?._id || null,
    updated_by: req.user?._id || null,
    status: "active",
  }));

  try {
    await Logs.insertMany(
      logsToCreate.map((row) => Logs.sanitizeLogPlainObject(row)),
    );
  } catch (error) {
    console.error("❌ Failed to create warehouse stock logs:", error);
  }
}

async function updateWarehouseDefault(req, res) {
  try {
    const productId = req.params.id || req.body.product_id;
    const warehouseId = req.body.warehouse_id || req.params.warehouse_id;

    if (!productId || !warehouseId) {
      return res.status(400).json({
        success: false,
        message: "product_id and warehouse_id are required",
      });
    }

    const filter = { _id: productId, deletedAt: null };
    if (req.user?.company_id) {
      filter.company_id = req.user.company_id;
    }

    const product = await Product.findOne(filter);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    if (
      !Array.isArray(product.warehouse_inventory) ||
      product.warehouse_inventory.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Product has no warehouse inventory",
      });
    }

    const targetIndex = product.warehouse_inventory.findIndex(
      (item) => item?.warehouse_id?.toString() === warehouseId.toString(),
    );

    if (targetIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Warehouse not found in product inventory",
      });
    }

    if (targetIndex > 0) {
      const [targetWarehouse] = product.warehouse_inventory.splice(
        targetIndex,
        1,
      );
      product.warehouse_inventory.unshift(targetWarehouse);
      product.markModified("warehouse_inventory");
      await product.save();
    }

    return res.status(200).json({
      success: true,
      message: "Warehouse moved to default position",
      data: product,
    });
  } catch (error) {
    console.error("❌ Update warehouse default error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}
async function productCreateVariation(req, res) {
  try {
    // console.log("🔧 Product create variation - req.body keys:", Object.keys(req.body));
    // cconsole.log("🔧 Product create variation - req.user.company_id:", req.user.company_id);
    const company = await handleGenericFindOne(req, "company", {
      searchCriteria: {
        _id: req.user.company_id,
        deletedAt: null,
      },
      excludeFields: [],
    });

    if (!company.success || !company.data) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    // Backward compatibility: if no warehouse inventory is provided,
    // seed one default company warehouse entry.
    if (!normalizeWarehouseInventoryInput(req.body)) {
      req.body.warehouse_inventory = [
        {
          warehouse_id: company.data.warehouse_id,
          quantity: req.body.quantity || 0,
          quantity_action: "add",
          last_updated: new Date(),
        },
      ];
    }

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
    if (
      !parentProductResponse.success ||
      !parentProductResponse.data ||
      !parentProductResponse.data._id
    ) {
      console.error(
        "❌ Failed to create parent product:",
        parentProductResponse,
      );
      return res.status(parentProductResponse.status || 500).json({
        success: false,
        message: "Failed to create parent product",
        error: parentProductResponse.error,
        details: parentProductResponse.details,
        missing: parentProductResponse.missing,
        type: parentProductResponse.type,
      });
    }

    console.log(
      "✅ Parent product created with ID:",
      parentProductResponse.data._id,
    );

    if (variations.length > 0) {
      for (const variation of variations) {
        const variant = {};
        variant.body = { ...variation };
        variant.body.company_id = company.data._id.toString();
        variant.body.warehouse_inventory = [
          {
            warehouse_id: company.data.warehouse_id,
            quantity: variation.quantity || 0,
            quantity_action: variation.quantity_action || "add",
            last_updated: new Date(),
          },
        ];
        variant.body.product_name = variation.product_name;
        variant.body.parent_product_id =
          parentProductResponse.data._id.toString();
        variant.body.product_price = variation.product_price;
        variant.body.product_description = variation.product_description;
        const variationResponse = await handleGenericCreate(
          variant,
          "product",
          {
            afterCreate: async (record, req) => {
              console.log("✅ Product variation created successfully:", record);
            },
          },
        );
        console.log(
          "🔧 Product create variation - response:",
          variationResponse,
        );
        // return res.status(variationResponse.status).json(variationResponse);
      }
    }
    return res
      .status(parentProductResponse.status || 200)
      .json(parentProductResponse);
  } catch (error) {
    console.error("❌ Product create variation error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function getProductVariationById(req, res) {
  const { id } = req.params;
  const response = await handleGenericGetById(req, "product", {
    excludeFields: [],
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
    ],
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });

  const childproducts = await handleGenericGetAll(req, "product", {
    excludeFields: [],
    filter: { parent_product_id: id },
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
      {
        path: "category_id",
        select: "name",
      },
    ],
  });
  response.data.childproducts = childproducts.data;
  return res.status(200).json({
    success: true,
    message: "Product variation fetched successfully",
    data: response.data,
  });
}

/**
 * Update product variation
 *
 * This function handles updating a parent product and its variations.
 * It supports two operations:
 * 1. Update existing variations (if variation has an 'id' field)
 * 2. Create new variations (if variation doesn't have an 'id' field)
 *
 * @param {Object} req - Express request object
 * @param {Object} req.params.id - Parent product ID from URL
 * @param {Object} req.body - Request body containing product data and variations
 * @param {Object} req.body.variations - Array of variations (can be form-encoded or direct array)
 * @param {Object} res - Express response object
 * @returns {Promise<Object>} JSON response with parent product and variations update results
 */
async function productUpdateVariation(req, res) {
  try {
    // Extract parent product ID from URL parameters
    const { id } = req.params;

    console.log("🔧 Product update variation - req.body:", req.body);
    console.log("🔧 Product update variation - product ID:", id);

    /**
     * Step 1: Get company information
     * Company data is needed to set company_id and warehouse_id for variations
     */
    const company = await handleGenericFindOne(req, "company", {
      searchCriteria: {
        _id: req.user.company_id,
        deletedAt: null,
      },
      excludeFields: [],
    });

    // Validate company exists
    if (!company.success || !company.data) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    /**
     * Step 2: Parse variations from req.body
     *
     * Supports two input formats:
     * 1. Direct array format (JSON): req.body.variations = [{...}, {...}]
     * 2. Form-encoded format: variations[0][field_name] = value
     *    Example: variations[0][product_name] = "Variant 1"
     */
    let variations = [];

    if (Array.isArray(req.body.variations)) {
      // Direct array format (JSON) - use as is
      variations = req.body.variations;
    } else {
      // Form-encoded format: variations[0][field_name]
      // Parse each key matching the pattern variations[index][field]
      for (const key in req.body) {
        const match = key.match(/^variations\[(\d+)\]\[(.+)\]$/);
        if (match) {
          const index = parseInt(match[1]); // Extract array index
          const field = match[2]; // Extract field name

          // Initialize variation object at this index if it doesn't exist
          if (!variations[index]) variations[index] = {};

          // Set the field value
          variations[index][field] = req.body[key];
        }
      }
    }

    /**
     * Step 3: Process warehouse inventory for parent product
     *
     * Initialize and set up warehouse_inventory array structure
     * This ensures the parent product has proper inventory tracking
     */
    // Backward compatibility: only seed default warehouse if no
    // warehouse inventory payload is provided in request.
    if (!normalizeWarehouseInventoryInput(req.body)) {
      req.body.warehouse_inventory = [
        {
          warehouse_id: company.data.warehouse_id,
          quantity: req.body.quantity || 0,
          quantity_action: "add",
          last_updated: new Date(),
        },
      ];
    }

    // Set company_id if not already set in request body
    if (!req.body.company_id && company.data._id) {
      req.body.company_id = company.data._id.toString();
    }

    /**
     * Step 4: Update the parent product first
     *
     * The parent product must be updated successfully before processing variations
     * because variations need the parent_product_id reference
     */
    const parentProductResponse = await handleGenericUpdate(req, "product", {
      /**
       * beforeUpdate hook: Process warehouse inventory data
       *
       * This hook processes warehouse_inventory data before saving.
       * It handles both object and array formats and ensures proper structure.
       */
      beforeUpdate: async (updateData, req, existingRecord) => {
        console.log("🔧 Product update variation - beforeUpdate hook called");
        console.log(
          "🔧 Original updateData.warehouse_inventory:",
          updateData.warehouse_inventory,
        );

        const incomingInventory = getIncomingInventoryForMerge(
          updateData,
          req.body,
        );
        if (incomingInventory !== null) {
          const { mergedInventory, changes } = mergeWarehouseInventory(
            existingRecord?.warehouse_inventory || [],
            incomingInventory,
          );
          updateData.warehouse_inventory = mergedInventory;
          req._warehouseStockChanges = changes;
          console.log(
            "✅ Merged warehouse inventory in controller:",
            mergedInventory,
          );
        }
      },
      /**
       * afterUpdate hook: Log successful update
       */
      afterUpdate: async (record, req, existingRecord) => {
        console.log("✅ Parent product updated successfully:", record);
        await createWarehouseStockLogs(
          req._warehouseStockChanges || [],
          req,
          record.product_name || "Product",
        );
      },
    });

    /**
     * Step 5: Validate parent product update was successful
     *
     * If parent product update fails, we cannot proceed with variations
     * because they need the parent_product_id reference
     */
    if (
      !parentProductResponse.success ||
      !parentProductResponse.data ||
      !parentProductResponse.data._id
    ) {
      console.error(
        "❌ Failed to update parent product:",
        parentProductResponse,
      );
      return res.status(parentProductResponse.status || 500).json({
        success: false,
        message: "Failed to update parent product",
        error: parentProductResponse.error || parentProductResponse,
      });
    }

    // Extract parent product ID for use in variations
    const parentProductId = parentProductResponse.data._id.toString();
    console.log("✅ Parent product updated with ID:", parentProductId);

    /**
     * Step 6: Process variations
     *
     * For each variation in the array:
     * - If variation has an 'id': Update existing variation
     * - If variation doesn't have an 'id': Create new variation with parent_product_id
     */
    const variationResults = [];

    if (variations.length > 0) {
      // Process each variation sequentially
      for (const variation of variations) {
        if (variation.id) {
          /**
           * Update existing variation
           *
           * Variation has an ID, so we update the existing record
           */
          console.log("🔄 Updating variation with ID:", variation.id);

          /**
           * Create a mock request object for updating the variation
           *
           * handleGenericUpdate expects req.params.id to contain the record ID
           * and req.body to contain the update data
           *
           * Create object that inherits from req to preserve Express methods (like req.get)
           */
          const variationReq = Object.create(Object.getPrototypeOf(req));
          Object.assign(variationReq, req, {
            params: { ...req.params, id: variation.id }, // Set variation ID in params
            body: { ...variation }, // Use variation data as body
          });

          // Remove id from body since it's now in params
          delete variationReq.body.id;

          /**
           * Set required fields for the variation:
           * - company_id: Link to company
           * - warehouse_inventory: Set up inventory tracking
           * - parent_product_id: Link to parent product
           */
          variationReq.body.company_id = company.data._id.toString();
          variationReq.body.warehouse_inventory = [
            {
              warehouse_id: company.data.warehouse_id,
              quantity: variation.quantity || 0,
              quantity_action: variation.quantity_action || "add",
              last_updated: new Date(),
            },
          ];
          variationReq.body.parent_product_id = parentProductId;

          // Update the variation using handleGenericUpdate
          const variationResponse = await handleGenericUpdate(
            variationReq,
            "product",
            {
              beforeUpdate: async (updateData, req, existingRecord) => {
                console.log(
                  "🔧 Variation update - beforeUpdate hook called for:",
                  variation.id,
                );
              },
              afterUpdate: async (record, req, existingRecord) => {
                console.log(
                  "✅ Product variation updated successfully:",
                  record._id,
                );
              },
            },
          );

          // Store result for response
          variationResults.push({
            id: variation.id,
            action: "updated",
            response: variationResponse,
          });
        } else {
          /**
           * Create new variation
           *
           * Variation doesn't have an ID, so we create a new record
           * and link it to the parent product via parent_product_id
           */
          console.log("➕ Creating new variation");

          /**
           * Create a mock request object for creating the variation
           *
           * handleGenericCreate expects req.body to contain the data
           *
           * Create object that inherits from req to preserve Express methods (like req.get)
           */
          const variantReq = Object.create(Object.getPrototypeOf(req));
          Object.assign(variantReq, req, {
            body: { ...variation }, // Use variation data as body
          });

          /**
           * Set required fields for the new variation:
           * - company_id: Link to company
           * - warehouse_inventory: Set up inventory tracking
           * - parent_product_id: Link to parent product (required for variations)
           */
          variantReq.body.company_id = company.data._id.toString();
          variantReq.body.warehouse_inventory = [
            {
              warehouse_id: company.data.warehouse_id,
              quantity: variation.quantity || 0,
              quantity_action: variation.quantity_action || "add",
              last_updated: new Date(),
            },
          ];
          variantReq.body.parent_product_id = parentProductId;

          // Create the variation using handleGenericCreate
          const variationResponse = await handleGenericCreate(
            variantReq,
            "product",
            {
              afterCreate: async (record, req) => {
                console.log(
                  "✅ Product variation created successfully:",
                  record._id,
                );
              },
            },
          );

          // Store result for response
          variationResults.push({
            action: "created",
            response: variationResponse,
          });
        }
      }
    }

    /**
     * Step 7: Return success response
     *
     * Response includes:
     * - parent_product: Updated parent product data
     * - variations: Array of variation update/create results
     */
    return res.status(parentProductResponse.status || 200).json({
      success: true,
      message: "Product variation updated successfully",
      data: {
        parent_product: parentProductResponse.data,
        variations: variationResults,
      },
    });
  } catch (error) {
    /**
     * Error handling
     *
     * Catch any unexpected errors and return appropriate error response
     */
    console.error("❌ Product update variation error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
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
      console.log("🔧 Product update - beforeUpdate hook called");
      console.log(
        "🔧 Original updateData.warehouse_inventory:",
        updateData.warehouse_inventory,
      );

      const incomingInventory = getIncomingInventoryForMerge(
        updateData,
        req.body,
      );
      if (incomingInventory !== null) {
        const { mergedInventory, changes } = mergeWarehouseInventory(
          existingRecord?.warehouse_inventory || [],
          incomingInventory,
        );
        updateData.warehouse_inventory = mergedInventory;
        req._warehouseStockChanges = changes;
        console.log(
          "✅ Merged warehouse inventory in controller:",
          mergedInventory,
        );
      }
    },
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
      await createWarehouseStockLogs(
        req._warehouseStockChanges || [],
        req,
        record.product_name || "Product",
      );
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
        { parent_product_id: null },
      ],
    },
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });
  return res.status(response.status).json(response);
}

async function getAllActiveProducts(req, res) {
  const response = await handleGenericGetAll(req, "product", {
    excludeFields: [], // Don't exclude any fields
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
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
      status: "active",
      deletedAt: null,
      $or: [
        { parent_product_id: { $exists: false } },
        { parent_product_id: null },
      ],
    },
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });
  return res.status(response.status).json(response);
}

/**
 * GET /api/warehouse/:warehouseId/products — products with stock in this warehouse
 * (reads `warehouse_inventory` collection, not embedded product arrays).
 */
async function getProductsByWarehouse(req, res) {
  try {
    const { warehouseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(warehouseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid warehouse id",
      });
    }

    const filter = {
      warehouse_id: warehouseId,
      quantity: { $gt: 0 },
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
    if (req.user && req.user.company_id) {
      filter.company_id = req.user.company_id;
    }

    const rows = await WarehouseInventory.find(filter)
      .populate("product_id", "product_name product_code product_price status")
      .lean();

    const productIds = rows
      .map((inventoryRow) => inventoryRow.product_id && inventoryRow.product_id._id)
      .filter(Boolean);

    let totalsByProduct = new Map();
    if (productIds.length > 0) {
      const aggFilter = {
        product_id: { $in: productIds },
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      };
      if (req.user && req.user.company_id) {
        aggFilter.company_id = req.user.company_id;
      }
      const agg = await WarehouseInventory.aggregate([
        { $match: aggFilter },
        { $group: { _id: "$product_id", total: { $sum: "$quantity" } } },
      ]);
      totalsByProduct = new Map(
        agg.map((groupRow) => [String(groupRow._id), groupRow.total]),
      );
    }

    const data = rows
      .filter((inventoryRow) => inventoryRow.product_id)
      .map((inventoryRow) => {
        const pid = String(inventoryRow.product_id._id);
        return {
          _id: inventoryRow.product_id._id,
          product_name: inventoryRow.product_id.product_name,
          product_code: inventoryRow.product_id.product_code,
          product_price: inventoryRow.product_id.product_price,
          warehouse_quantity: inventoryRow.quantity,
          total_quantity: totalsByProduct.get(pid) ?? inventoryRow.quantity,
        };
      });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("❌ Get products by warehouse error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function productDelete(req, res) {
  console.log(`🔐 Product delete attempt:`, {
    id: req.params.id,
    time: new Date().toISOString(),
  });

  const filter = {};

  // Always filter by company_id if user has one
  if (req.user && req.user.company_id) {
    filter.company_id = req.user.company_id;
    console.log(
      `🔍 Filtering product delete by company_id:`,
      req.user.company_id,
    );
  }

  // Manually set the request body with deletedAt data
  req.body = { deletedAt: new Date().toISOString() };
  const response = await handleGenericUpdate(req, "product", {
    filter: filter,
    afterUpdate: async (record, req, existingRecord) => {
      console.log(`✅ Product soft deleted successfully.`);
    },
  });
  return res.status(response.status).json(response);
}

/**
 * Inventory value at wholesale (COGS basis on hand): sum over warehouses of
 * `quantity * wholesale_price` per active product. Optional `GET …/:id` for one product.
 */
async function cost_of_goods_available(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const { id } = req.params;
    const productIdFilter =
      id && mongoose.Types.ObjectId.isValid(String(id).trim()) ?
        new mongoose.Types.ObjectId(String(id).trim())
      : null;

    if (id && !productIdFilter) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const invMatch = {
      company_id: companyId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      quantity: { $gt: 0 },
    };
    if (productIdFilter) {
      invMatch.product_id = productIdFilter;
    }

    const rows = await WarehouseInventory.aggregate([
      { $match: invMatch },
      {
        $group: {
          _id: "$product_id",
          total_qty: { $sum: "$quantity" },
        },
      },
      { $sort: { total_qty: -1 } },
    ]);

    if (productIdFilter) {
      const exists = await Product.exists({
        _id: productIdFilter,
        company_id: companyId,
        deletedAt: null,
      });
      if (!exists) {
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }
      if (rows.length === 0) {
        const productDoc = await Product.findById(productIdFilter)
          .select("product_name sku wholesale_price product_code")
          .lean();
        const wholesaleUnit = Number(productDoc?.wholesale_price);
        const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
        return res.status(200).json({
          success: true,
          count: 1,
          grand_total_cost_of_goods: 0,
          data: [
            {
              product_id: productIdFilter,
              product_name: productDoc?.product_name,
              product_code: productDoc?.product_code,
              sku: productDoc?.sku,
              total_qty: 0,
              wholesale_price,
              cost_of_goods_available: 0,
            },
          ],
        });
      }
    }

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        grand_total_cost_of_goods: 0,
        data: [],
      });
    }

    const productIds = rows.map((qtyRow) => qtyRow._id);
    const products = await Product.find({
      _id: { $in: productIds },
      company_id: companyId,
      status: "active",
      deletedAt: null,
    })
      .select("product_name sku wholesale_price product_code")
      .lean();

    const productById = new Map(products.map((doc) => [String(doc._id), doc]));

    const data = [];
    for (const row of rows) {
      const productDoc = productById.get(String(row._id));
      if (!productDoc) continue;
      const qty = Math.max(0, Number(row.total_qty) || 0);
      const wholesaleUnit = Number(productDoc.wholesale_price);
      const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
      const cost_of_goods_available =
        Math.round(qty * wholesale_price * 100) / 100;
      data.push({
        product_id: row._id,
        product_name: productDoc.product_name,
        product_code: productDoc.product_code,
        sku: productDoc.sku,
        total_qty: qty,
        wholesale_price,
        cost_of_goods_available,
      });
    }

    if (productIdFilter && data.length === 0 && rows.length > 0) {
      const row = rows[0];
      const qty = Math.max(0, Number(row.total_qty) || 0);
      return res.status(200).json({
        success: true,
        count: 1,
        grand_total_cost_of_goods: 0,
        data: [
          {
            product_id: row._id,
            product_name: null,
            product_code: null,
            sku: null,
            total_qty: qty,
            wholesale_price: 0,
            cost_of_goods_available: 0,
            note: "Inventory exists but product is missing or inactive for this company",
          },
        ],
      });
    }

    const grand_total_cost_of_goods =
      Math.round(
        data.reduce(
          (runningTotal, line) => runningTotal + line.cost_of_goods_available,
          0,
        ) * 100,
      ) / 100;

    return res.status(200).json({
      success: true,
      count: data.length,
      grand_total_cost_of_goods,
      data,
    });
  } catch (error) {
    console.error("❌ cost_of_goods_available:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/** Warehouse qty × `wholesale_price` for COGS-style response; optional blend `?qty=&total=` returns `wholesale_blend` only (does not persist `wholesale_price`). Default: `total` = full line amount for that `qty`; use `total_mode=per_unit` if `total` is unit cost. PATCH …/update-cost/:id */
async function productCostUpdate(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id).trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required",
      });
    }

    const productId = new mongoose.Types.ObjectId(String(id).trim());

    const invMatch = {
      product_id: productId,
      company_id: companyId,
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };

    const agg = await WarehouseInventory.aggregate([
      { $match: invMatch },
      {
        $group: {
          _id: null,
          total_warehouse_qty: { $sum: "$quantity" },
        },
      },
    ]);

    const totalWarehouseQty = Math.max(
      0,
      Number(agg[0]?.total_warehouse_qty) || 0,
    );

    const product = await Product.findOne({
      _id: productId,
      company_id: companyId,
      deletedAt: null,
    })
      .select("product_name product_code sku wholesale_price status")
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const rawAddQty = req.query?.qty;
    const rawAddTotal = req.query?.total;
    const hasAddQty = rawAddQty !== undefined && String(rawAddQty).trim() !== "";
    const hasAddTotal =
      rawAddTotal !== undefined && String(rawAddTotal).trim() !== "";

    if (hasAddQty !== hasAddTotal) {
      return res.status(400).json({
        success: false,
        message:
          "Provide both `qty` and `total` for a weighted blend, or omit both. Default: `total` = full line amount for that qty; use `total_mode=per_unit` if `total` is per-unit cost.",
      });
    }

    let wholesaleBlend = null;
    if (hasAddQty && hasAddTotal) {
      const addedQty = Number(String(rawAddQty).trim());
      const addedTotalRaw = Number(String(rawAddTotal).trim());
      if (!Number.isFinite(addedQty) || addedQty <= 0) {
        return res.status(400).json({
          success: false,
          message: "Query `qty` must be a positive number",
        });
      }
      if (!Number.isFinite(addedTotalRaw) || addedTotalRaw < 0) {
        return res.status(400).json({
          success: false,
          message: "Query `total` must be a finite number ≥ 0",
        });
      }

      const totalModeRaw = String(req.query?.total_mode ?? "")
        .trim()
        .toLowerCase();
      const usePerUnitTotal =
        totalModeRaw === "per_unit" ||
        totalModeRaw === "unit" ||
        totalModeRaw === "each";

      let addedUnitCost;
      let newLotExtendedCost;
      let blendTotalModeLabel;
      if (usePerUnitTotal) {
        addedUnitCost = addedTotalRaw;
        newLotExtendedCost = addedQty * addedTotalRaw;
        blendTotalModeLabel = "per_unit";
      } else {
        addedUnitCost = addedTotalRaw / addedQty;
        if (!Number.isFinite(addedUnitCost) || addedUnitCost < 0) {
          return res.status(400).json({
            success: false,
            message:
              "`total` must divide by `qty` to a valid implied per-unit cost ≥ 0 (send full line amount for `qty`, or use total_mode=per_unit)",
          });
        }
        newLotExtendedCost = addedTotalRaw;
        blendTotalModeLabel = "line_total";
      }

      const wholesaleBefore = Number.isFinite(Number(product.wholesale_price)) ?
        Number(product.wholesale_price)
      : 0;
      const totalCostAvailable = totalWarehouseQty * wholesaleBefore;
      const combinedExtendedCost = totalCostAvailable + newLotExtendedCost;
      const denominatorQty = totalWarehouseQty + addedQty;
      const newWholesaleRounded =
        Math.round((combinedExtendedCost / denominatorQty) * 100) / 100;

      wholesaleBlend = {
        warehouse_qty: totalWarehouseQty,
        wholesale_price_before: wholesaleBefore,
        total_cost_available: Math.round(totalCostAvailable * 100) / 100,
        added_qty: addedQty,
        added_unit_cost: Math.round(addedUnitCost * 100) / 100,
        total_mode: blendTotalModeLabel,
        new_lot_extended_cost: Math.round(newLotExtendedCost * 100) / 100,
        combined_extended_cost: Math.round(combinedExtendedCost * 100) / 100,
        denominator_qty: denominatorQty,
        new_wholesale: newWholesaleRounded,
      };
    }

    const wholesaleUnit = Number(product.wholesale_price);
    const wholesale_price = Number.isFinite(wholesaleUnit) ? wholesaleUnit : 0;
    const cost_at_wholesale =
      Math.round(totalWarehouseQty * wholesale_price * 100) / 100;

    return res.status(200).json({
      success: true,
      data: {
        product_id: productId,
        product_name: product.product_name,
        product_code: product.product_code,
        sku: product.sku,
        total_warehouse_qty: totalWarehouseQty,
        wholesale_price,
        cost_of_goods_available: cost_at_wholesale,
      },
      ...(wholesaleBlend != null ? { wholesale_blend: wholesaleBlend } : {}),
    });
  } catch (error) {
    console.error("❌ productCostUpdate:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

async function getAllActiveProductsPOS(req, res) {
  const tenantCo = coalesceObjectId(req.user?.company_id);
  const filter = {
    status: "active",
    deletedAt: null,
    product_parent_id: null,
    ...(tenantCo ? { company_id: tenantCo } : {}),
  };

  const rawCategory = req.query.category_id ?? req.query.categoryId;
  if (rawCategory != null && String(rawCategory).trim() !== "") {
    const categoryOid = coalesceObjectId(rawCategory);
    if (
      !categoryOid ||
      !mongoose.Types.ObjectId.isValid(String(categoryOid))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "Invalid category_id",
        message: "category_id must be a valid 24-character ObjectId",
      });
    }
    // `category_id` on product is an array; equality matches docs that include this id.
    filter.category_id = categoryOid;
  }

  const response = await handleGenericGetAll(req, "product", {
    filter,
    excludeFields: [],
    sort: { createdAt: -1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
    populate: [
      {
        path: "parent_product_id",
        select: "product_name",
      },
    ],
  });
  return res.status(response.status).json(response);
}

async function updateStockByWarehouse(req, res) {
  try {
    const { warehouse_id, quantity } = req.body;
  } catch (error) {
    console.error("❌ Update stock by warehouse error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

module.exports = {
  productCreate,
  productUpdate,
  productById,
  getAllProducts,
  getAllActiveProducts,
  getProductsByWarehouse,
  productCreateVariation,
  productUpdateVariation,
  getProductVariationById,
  productDelete,
  productCostUpdate,
  cost_of_goods_available,
  getAllActiveProductsPOS,
  updateWarehouseDefault,
};

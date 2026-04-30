const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  parseSearchFieldsFromQuery,
} = require("../utils/modelHelper");
const Product = require("../models/product");
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
    await Logs.insertMany(logsToCreate);
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
        error: parentProductResponse.error || parentProductResponse,
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
        path: "warehouse_inventory.warehouse_id",
        select: "warehouse_name",
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
      operation,
    });

    // Validation
    if (!warehouse_id || quantity === undefined) {
      return res.status(400).json({
        success: false,
        message: "warehouse_id and quantity are required",
      });
    }

    if (quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot be negative",
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
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
          message: "Invalid operation. Use 'set', 'increase', or 'decrease'",
        });
    }

    await product.save();

    console.log("✅ Warehouse quantity updated successfully");

    return res.status(200).json({
      success: true,
      message: "Warehouse quantity updated successfully",
      data: product,
    });
  } catch (error) {
    console.error("❌ Update warehouse quantity error:", error);

    // Handle specific errors
    if (error.message.includes("Insufficient quantity")) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    } else if (error.message.includes("Warehouse not found")) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
    });
  }
}

/**
 * Get warehouse inventory for a product
 */
async function getProductWarehouseInventory(req, res) {
  try {
    const { id: productId } = req.params;

    const product = await Product.findById(productId).populate(
      "warehouse_inventory.warehouse_id",
      "warehouse_name warehouse_address status",
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const totalQuantity = product.getTotalQuantity();

    return res.status(200).json({
      success: true,
      data: {
        product_id: product._id,
        product_name: product.product_name,
        warehouse_inventory: product.warehouse_inventory,
        total_quantity: totalQuantity,
      },
    });
  } catch (error) {
    console.error("❌ Get warehouse inventory error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
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
        message: "warehouse_id is required",
      });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
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
        is_available: isAvailable,
      },
    });
  } catch (error) {
    console.error("❌ Check warehouse stock error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error",
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
      "warehouse_inventory.quantity": { $gt: 0 },
    }).populate(
      "warehouse_inventory.warehouse_id",
      "warehouse_name warehouse_address",
    );

    return res.status(200).json({
      success: true,
      count: products.length,
      data: products.map((product) => ({
        _id: product._id,
        product_name: product.product_name,
        product_price: product.product_price,
        warehouse_quantity: product.getWarehouseQuantity(warehouseId),
        total_quantity: product.getTotalQuantity(),
      })),
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

async function getAllActiveProductsPOS(req, res) {
  const filter = { status: "active", deletedAt: null, product_parent_id: null };
  const response = await handleGenericGetAll(req, "product", {
    filter,
    excludeFields: [], // Don't exclude any fields
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
  updateWarehouseQuantity,
  getProductWarehouseInventory,
  checkWarehouseStock,
  getProductsByWarehouse,
  productCreateVariation,
  productUpdateVariation,
  getProductVariationById,
  productDelete,
  getAllActiveProductsPOS,
  updateWarehouseDefault,
};

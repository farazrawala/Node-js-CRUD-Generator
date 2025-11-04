const path = require('path');
const fs = require('fs');
const { getUserToken } = require('../service/auth');
/**
 * Generate URL-friendly slug from text
 * @param {string} text - The text to convert to slug
 * @returns {string} The generated slug
 * 
 * Usage examples:
 * - generateSlug("Product Name") => "product-name"
 * - generateSlug("iPhone 15 Pro Max!!!") => "iphone-15-pro-max"
 * - generateSlug("Gaming Laptop 2024") => "gaming-laptop-2024"
 */
const generateSlug = (text) => {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Replace spaces with -
    .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
    .replace(/\-\-+/g, '-')         // Replace multiple - with single -
    .replace(/^-+/, '')             // Trim - from start of text
    .replace(/-+$/, '');            // Trim - from end of text
};

/**
 * Get the controller name from the calling file
 * @returns {string} The controller name
 */
const getControllerName = () => {
  // Get the calling file name from stack trace
  const stack = new Error().stack;
  const lines = stack.split('\n');
  
  console.log('🔍 Stack trace for controller detection:');
  lines.forEach((line, index) => {
    console.log(`  ${index}: ${line.trim()}`);
  });
  
  // Look for the controller file in the stack trace
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    console.log(`🔍 Checking line ${i}: ${line.trim()}`);
    
    // Look for lines that contain controller files (not modelHelper.js)
    if (line.includes('controllers/') && !line.includes('modelHelper.js')) {
      console.log(`🔍 Found controller line: ${line}`);
      
      // Try different regex patterns for file path extraction
      let filePath = null;
      
      // Pattern 1: (file:///path/to/file)
      let match = line.match(/\(file:\/\/\/(.+)\)/);
      if (match) {
        filePath = match[1];
      }
      
      // Pattern 2: (path/to/file)
      if (!filePath) {
        match = line.match(/\((.+)\)/);
        if (match) {
          filePath = match[1];
        }
      }
      
      // Pattern 3: at Function (path/to/file)
      if (!filePath) {
        match = line.match(/at\s+\w+\s+\((.+)\)/);
        if (match) {
          filePath = match[1];
        }
      }
      
      if (filePath) {
        const fileName = path.basename(filePath, '.js');
        console.log(`🔍 Auto-detected controller name: ${fileName} from ${filePath}`);
        return fileName;
      }
    }
  }
  
  // Fallback: try to get from the immediate caller (line 2)
  if (lines.length > 2) {
    const callerLine = lines[2];
    console.log(`🔍 Trying fallback with line 2: ${callerLine.trim()}`);
    
    let filePath = null;
    let match = callerLine.match(/\((.+)\)/);
    if (match) {
      filePath = match[1];
    }
    
    if (filePath) {
      const fileName = path.basename(filePath, '.js');
      console.log(`🔍 Fallback controller name: ${fileName} from ${filePath}`);
      return fileName;
    }
  }
  
  console.log('⚠️ Could not detect controller name, using default: user');
  return 'user'; // Default fallback
};

/**
 * Dynamically get model based on controller name
 * @param {string} controllerName - The name of the controller/model
 * @param {string} customPath - Optional custom path to models directory
 * @returns {Object} Mongoose model
 */
const getModelFromController = (controllerName, customPath = null) => {
  if (!controllerName) {
    throw new Error('Controller name is required');
  }
  
  // Determine models directory path
  const modelsPath = customPath || path.join(__dirname, '..', 'models');
  
  // Dynamic require based on model name
  try {
    const Model = require(path.join(modelsPath, controllerName));
    return Model;
  } catch (error) {
    throw new Error(`Model '${controllerName}' not found in ${modelsPath}`);
  }
};

/**
 * Handle image upload for fields with field_type: "image"
 * Supports multiple files if the client sends multiple files under the same field name.
 * @param {Object} req - Express request object
 * @param {string} fieldName - The field name
 * @param {string} modelName - The model name
 * @param {string} recordId - The record ID
 * @returns {Promise<string|string[]|null>} The uploaded image path(s) or null if no image
 */
const handleImageUpload = async (req, fieldName, modelName, recordId) => {
  try {
    // Check if there's a file in the request
    if (!req.files || !req.files[fieldName]) {
      return null;
    }

    const uploaded = req.files[fieldName];
    const filesArray = Array.isArray(uploaded) ? uploaded : [uploaded];

    // Validate file types
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

    // Ensure directory exists: uploads/{modelName}/{recordId}/
    const uploadDir = path.join(__dirname, '..', 'uploads', modelName, recordId);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const moveOne = (file, index) => new Promise((resolve, reject) => {
      if (!allowedTypes.includes(file.mimetype)) {
        return reject(new Error(`Invalid file type. Allowed types: ${allowedTypes.join(', ')}`));
      }
      const timestamp = Date.now();
      const fileExtension = path.extname(file.name);
      const fileName = `${fieldName}_${timestamp}_${index}${fileExtension}`;
      const filePath = path.join(uploadDir, fileName);
      file.mv(filePath, (err) => {
        if (err) {
          console.error('Error moving file:', err);
          return reject(new Error('Failed to save image file'));
        }
        const relativePath = path.join('uploads', modelName, recordId, fileName).replace(/\\/g, '/');
        console.log(`✅ Image uploaded successfully: ${relativePath}`);
        resolve(relativePath);
      });
    });

    const paths = await Promise.all(filesArray.map((f, idx) => moveOne(f, idx)));
    return Array.isArray(uploaded) ? paths : paths[0];
  } catch (error) {
    console.error('❌ Image upload error:', error);
    throw error;
  }
};

/**
 * Generic create function that works with any model
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} controllerName - The name of the controller/model (optional, auto-detected if not provided)
 * @param {Object} options - Additional options
 * @returns {Promise} Express response
 */
const handleGenericCreate = async (req, controllerName = null, options = {}) => {
  // Auto-detect controller name if not provided or empty
  const modelName = (controllerName && controllerName.trim() !== '') ? controllerName : getControllerName();
  
  const {
    excludeFields = [], // Fields to exclude from response
    customValidation = null, // Custom validation function
    beforeCreate = null, // Function to run before creating
    afterCreate = null, // Function to run after creating
    errorHandlers = {} // Custom error handlers
  } = options;

  if (!req.body || Object.keys(req.body).length === 0) {
    return {
      success: false,
      status: 400,
      error: "Request body is empty",
      message: "Please send form data with required fields",
      contentType: req.get("Content-Type"),
    };
  }

  try {
    // Dynamically get the model
    const Model = getModelFromController(modelName);
    const modelSchema = Model.schema.obj;
    
    // Debug: Log the incoming request data
    console.log("🔍 handleGenericCreate - Raw req.body:", req.body);
    console.log("🔍 handleGenericCreate - req.body keys:", Object.keys(req.body));
    console.log("🔍 handleGenericCreate - modelSchema keys:", Object.keys(modelSchema));
    
    const requiredFields = Object.keys(modelSchema).filter((field) => {
      const fieldConfig = modelSchema[field];
      return fieldConfig.required === true && !fieldConfig.default;
    });

    // Validate required fields dynamically
    const missingFields = requiredFields.filter(
      (field) => !req.body[field] || req.body[field].trim().length === 0
    );

    if (missingFields.length > 0) {
      return {
        success: false,
        status: 400,
        error: "Missing required fields",
        required: requiredFields,
        missing: missingFields,
        received: Object.keys(req.body),
      };
    }

    // Run custom validation if provided
    if (customValidation) {
      const validationResult = await customValidation(req.body, modelSchema);
      if (validationResult.error) {
        return {
          success: false,
          status: 400,
          ...validationResult
        };
      }
    }

    // Prepare data for creation (only include fields that exist in schema)
    const modelData = {};
    
    // Process regular fields
    Object.keys(req.body).forEach((key) => {
      if (modelSchema[key]) {
        const fieldConfig = modelSchema[key];
        let value = req.body[key];
        
        // Handle ObjectID fields - convert empty strings to null
        if (fieldConfig.type && fieldConfig.type.name === 'ObjectId') {
          if (value === '' || value === 'null' || value === undefined) {
            modelData[key] = null;
          } else {
            modelData[key] = value;
          }
        } else {
          // For non-ObjectID fields, trim as usual
          // Only trim if value exists and has a trim method (strings)
          if (value && typeof value === 'string') {
            modelData[key] = value.trim();
          } else if (value !== undefined && value !== null) {
            // For non-string values (numbers, booleans, objects, arrays), keep as is
            modelData[key] = value;
          }
        }
      }
    });

    console.log("🔧 About to start nested array processing...");
    
    // Process nested array fields (e.g., warehouse_inventory[warehouse_id], warehouse_inventory[quantity], warehouse_inventory[0][warehouse_id])
    console.log("🚀 Starting nested array processing...");
    console.log("🚀 req.body keys:", Object.keys(req.body));
    console.log("🚀 modelData before nested processing:", JSON.stringify(modelData, null, 2));
    
    Object.keys(req.body).forEach((key) => {
      console.log(`🔍 Checking key: ${key}`);
      
      // Handle both indexed and non-indexed arrays
      // Pattern 2: field[index][subfield] (e.g., warehouse_inventory[0][warehouse_id]) - Check this FIRST
      // Pattern 1: field[subfield] (e.g., warehouse_inventory[warehouse_id])
      let arrayMatch = key.match(/^(.+)\[(\d+)\]\[(\w+)\]$/);
      let arrayFieldName, arrayItemField, index;
      
      if (arrayMatch) {
        // Pattern 2: field[index][subfield]
        arrayFieldName = arrayMatch[1];
        index = parseInt(arrayMatch[2]);
        arrayItemField = arrayMatch[3];
        console.log(`🔍 Pattern 2 match: ${key} -> ${arrayFieldName}[${index}].${arrayItemField}`);
      } else {
        // Pattern 1: field[subfield]
        arrayMatch = key.match(/^(.+)\[(\w+)\]$/);
        if (arrayMatch) {
          arrayFieldName = arrayMatch[1];
          arrayItemField = arrayMatch[2];
          index = 0; // Default to index 0
          console.log(`🔍 Pattern 1 match: ${key} -> ${arrayFieldName}[${index}].${arrayItemField}`);
        }
      }
      
      if (arrayMatch) {
        // Check if this is a valid array field in the schema
        console.log(`🔍 Checking schema for ${arrayFieldName}:`, modelSchema[arrayFieldName]);
        console.log(`🔍 Is array:`, Array.isArray(modelSchema[arrayFieldName]));
        console.log(`🔍 Is type array:`, Array.isArray(modelSchema[arrayFieldName]?.type));
        
        if (modelSchema[arrayFieldName] && Array.isArray(modelSchema[arrayFieldName].type)) {
          console.log(`🔍 Processing array field: ${arrayFieldName}`);
          if (!modelData[arrayFieldName]) {
            modelData[arrayFieldName] = [];
          }
          
          const value = req.body[key];
          
          // Ensure we have an object at this index
          if (!modelData[arrayFieldName][index]) {
            modelData[arrayFieldName][index] = {};
          }
          
          // Set the field value
          modelData[arrayFieldName][index][arrayItemField] = value;
          console.log(`🏭 Processed nested array field: ${key} -> ${arrayFieldName}[${index}].${arrayItemField} = ${value}`);
        } else {
          console.log(`🔍 Schema field not found or not array: ${arrayFieldName}`);
        }
      } else {
        console.log(`🔍 No array match for key: ${key}`);
      }
    });

    // Debug: Log the final processed data
    console.log("🔍 handleGenericCreate - Final modelData:", JSON.stringify(modelData, null, 2));
    console.log("🔍 handleGenericCreate - modelData keys:", Object.keys(modelData));

    // Automatically set created_by if field exists and user is authenticated
    if (req.user && req.user._id && modelSchema.created_by) {
      modelData.created_by = req.user._id;
    }

    // Automatically set company_id if field exists and user has company_id
    console.log(`🔍 Checking company_id assignment:`, {
      hasUser: !!req.user,
      hasCompanyId: !!(req.user && req.user.company_id),
      hasSchemaField: !!modelSchema.company_id,
      userCompanyId: req.user?.company_id,
      modelName: controllerName
    });
    
    if (req.user && req.user.company_id && modelSchema.company_id) {
      modelData.company_id = req.user.company_id;
      console.log(`✅ Automatically set company_id to:`, req.user.company_id);
      
    }
    

    // Automatically generate EAN13 barcode if barcode field is empty and exists in schema
    if (modelSchema.barcode && (!modelData.barcode || modelData.barcode.trim() === "")) {
      const { generateProductBarcode } = require('./barcodeGenerator');
      modelData.barcode = generateProductBarcode();
      console.log("🏷️ Generated new EAN13 barcode for API:", modelData.barcode);
    }

    console.log(`📝 Preparing data for ${modelName} creation:`, {
      receivedFields: Object.keys(req.body),
      schemaFields: Object.keys(modelSchema),
      modelDataFields: Object.keys(modelData),
    });

    // Add default values for fields with defaults
    Object.keys(modelSchema).forEach((field) => {
      const fieldConfig = modelSchema[field];
      if (fieldConfig.default && !modelData[field]) {
        modelData[field] = fieldConfig.default;
      }
    });

    // Handle image uploads for fields with field_type: "image"
    const imageFields = Object.keys(modelSchema).filter((field) => {
      const fieldConfig = modelSchema[field];
      return fieldConfig.field_type === "image";
    });

    // Run beforeCreate hook if provided
    if (beforeCreate) {
      await beforeCreate(modelData, req);
    }

    console.log(`✅ Creating ${modelName} with data:`, {
      ...modelData,
      password: modelData.password ? "[HIDDEN]" : undefined,
    });

    const result = await Model.create(modelData);

    // Now handle image uploads with the record ID
    for (const imageField of imageFields) {
      try {
        const uploaded = await handleImageUpload(req, imageField, modelName, result._id.toString());
        if (uploaded) {
          // If schema expects array (type: [String]) store as array; else store single string
          const expectsArray = Array.isArray(Model.schema.obj[imageField]?.type) || Model.schema.paths[imageField]?.instance === 'Array';
          result[imageField] = expectsArray ? (Array.isArray(uploaded) ? uploaded : [uploaded]) : (Array.isArray(uploaded) ? uploaded[0] : uploaded);
          await result.save();
        }
      } catch (error) {
        console.error(`❌ Error uploading image for field ${imageField}:`, error);
        // Continue with other fields even if one image upload fails
      }
    }

    // Run afterCreate hook if provided
    if (afterCreate) {
      await afterCreate(result, req);
    }

    // Prepare response data (exclude specified fields)
    const responseData = { ...result.toObject() };
    excludeFields.forEach(field => {
      delete responseData[field];
    });

    return {
      success: true,
      status: 201,
      data: responseData,
    };

  } catch (error) {
    console.error("❌ Creation error:", error);

    // Handle custom error handlers first
    if (errorHandlers[error.code]) {
      return errorHandlers[error.code](error);
    }

    // Handle specific error types
    switch (error.name) {
      case "ValidationError":
        const validationErrors = Object.values(error.errors).map(
          (err) => err.message
        );
        return {
          success: false,
          status: 400,
          error: "Validation failed",
          details: validationErrors,
          type: "validation"
        };

      case "CastError":
        return {
          success: false,
          status: 400,
          error: "Invalid data type",
          details: `${error.path} should be ${error.kind}`,
          type: "cast"
        };

      case "MongoError":
      case "MongoServerError":
        // Handle MongoDB specific errors
        switch (error.code) {
          case 11000:
            const duplicateField = Object.keys(error.keyPattern)[0];
            return {
              success: false,
              status: 409,
              error: "Duplicate entry",
              details: `${duplicateField} already exists`,
              type: "duplicate"
            };
          case 121:
            return {
              success: false,
              status: 400,
              error: "Document validation failed",
              details: error.errmsg,
              type: "document_validation"
            };
          default:
            return {
              success: false,
              status: 500,
              error: "Database error",
              details: error.message,
              type: "database"
            };
        }

      case "TypeError":
        return {
          success: false,
          status: 400,
          error: "Type error",
          details: error.message,
          type: "type"
        };

      case "ReferenceError":
        return {
          success: false,
          status: 500,
          error: "Reference error",
          details: error.message,
          type: "reference"
        };

      case "SyntaxError":
        return {
          success: false,
          status: 400,
          error: "Syntax error",
          details: error.message,
          type: "syntax"
        };

      case "RangeError":
        return {
          success: false,
          status: 400,
          error: "Range error",
          details: error.message,
          type: "range"
        };

      case "URIError":
        return {
          success: false,
          status: 400,
          error: "URI error",
          details: error.message,
          type: "uri"
        };

      case "EvalError":
        return {
          success: false,
          status: 500,
          error: "Evaluation error",
          details: error.message,
          type: "eval"
        };

      default:
        // Handle unknown errors
        if (error.code) {
          // Handle HTTP status codes
          const statusCode = error.code >= 400 && error.code < 600 ? error.code : 500;
          return {
            success: false,
            status: statusCode,
            error: error.message || "Unknown error",
            details: error.stack,
            type: "unknown",
            code: error.code
          };
        }

        // Handle network/connection errors
        if (error.message && error.message.includes('ECONNREFUSED')) {
          return {
            success: false,
            status: 503,
            error: "Database connection failed",
            details: "Unable to connect to database",
            type: "connection"
          };
        }

        if (error.message && error.message.includes('timeout')) {
          return {
            success: false,
            status: 408,
            error: "Request timeout",
            details: "Operation timed out",
            type: "timeout"
          };
        }

        // Handle memory errors
        if (error.message && error.message.includes('ENOMEM')) {
          return {
            success: false,
            status: 507,
            error: "Insufficient storage",
            details: "Server is out of memory",
            type: "memory"
          };
        }

        // Handle file system errors
        if (error.code && error.code.startsWith('ENOENT')) {
          return {
            success: false,
            status: 500,
            error: "File not found",
            details: "Required file or directory not found",
            type: "file_system"
          };
        }

        // Generic error handler
        return {
          success: false,
          status: 500,
          error: "Internal server error",
          details: process.env.NODE_ENV === 'development' ? error.stack : "Something went wrong",
          type: "internal",
          timestamp: new Date().toISOString()
        };
    }
  }
};

/**
 * Generic update function that works with any model
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} controllerName - The name of the controller/model (required)
 * @param {Object} options - Additional options
 * @returns {Promise} Express response
 */
const handleGenericUpdate = async (req, controllerName, options = {}) => {
  // Auto-detect controller name if not provided or empty
  const modelName = (controllerName && controllerName.trim() !== '') ? controllerName : getControllerName();
  
  if (!modelName) {
    return {
      success: false,
      status: 500,
      error: "Controller name is required",
      details: "Please provide the controller name as the third parameter",
      type: "configuration",
    };
  }

  const {
    idParam = "id", // URL parameter name for ID (default: 'id')
    excludeFields = [], // Fields to exclude from response
    customValidation = null, // Custom validation function
    beforeUpdate = null, // Function to run before updating
    afterUpdate = null, // Function to run after updating
    errorHandlers = {}, // Custom error handlers
    allowedFields = [], // Fields that can be updated (empty = all fields)
    filter = {}, // Additional filters (e.g., { company_id: req.user.company_id })
  } = options;

  // Get ID from URL parameters
  const recordId = req.params[idParam];
  if (!recordId) {
    return {
      success: false,
      status: 400,
      error: "Record ID is required",
      details: `Please provide ${idParam} in the URL parameters`,
      type: "missing_id",
    };
  }

  if (!req.body || Object.keys(req.body).length === 0) {
    return {
      success: false,
      status: 400,
      error: "Request body is empty",
      message: "Please send form data with fields to update",
      contentType: req.get("Content-Type"),
    };
  }

  try {
    // Dynamically get the model
    const Model = getModelFromController(modelName);
    const modelSchema = Model.schema.obj;

    // Find the existing record
    const existingRecord = await Model.findOne({ _id: recordId, ...filter });
    if (!existingRecord) {
      return {
        success: false,
        status: 404,
        error: "Record not found",
        details: `${modelName} with ID ${recordId} not found`,
        type: "not_found",
      };
    }

    // Prepare update data (only include fields that exist in schema)
    const updateData = {};
    
    // If allowedFields is specified, only allow those fields
    if (allowedFields.length > 0) {
      Object.keys(req.body).forEach((key) => {
        if (modelSchema[key] && allowedFields.includes(key)) {
          const fieldConfig = modelSchema[key];
          let value = req.body[key];
          
          // Handle ObjectID fields - convert empty strings to null
          if (fieldConfig.type && fieldConfig.type.name === 'ObjectId') {
            if (value === '' || value === 'null' || value === undefined) {
              updateData[key] = null;
            } else {
              updateData[key] = value;
            }
          } else {
            // Handle multiselect fields - ensure they are arrays
            if (fieldConfig.field_type === "multiselect") {
              if (Array.isArray(value)) {
                updateData[key] = value;
              } else if (value !== undefined && value !== null) {
                // Convert single value to array
                updateData[key] = [value];
              }
            } else {
              // For non-ObjectID fields, trim as usual
              // Only trim if value exists and has a trim method (strings)
              if (value && typeof value === 'string') {
                updateData[key] = value.trim();
              } else if (value !== undefined && value !== null) {
                // For non-string values (numbers, booleans, objects, arrays), keep as is
                updateData[key] = value;
              }
            }
          }
        }
      });
    } else {
      // If no allowedFields specified, allow all fields except password for security
      Object.keys(req.body).forEach((key) => {
        if (modelSchema[key] && key !== 'password') {
          const fieldConfig = modelSchema[key];
          let value = req.body[key];
          
          // Handle ObjectID fields - convert empty strings to null
          if (fieldConfig.type && fieldConfig.type.name === 'ObjectId') {
            if (value === '' || value === 'null' || value === undefined) {
              updateData[key] = null;
            } else {
              updateData[key] = value;
            }
          } else {
            // Handle multiselect fields - ensure they are arrays
            if (fieldConfig.field_type === "multiselect") {
              if (Array.isArray(value)) {
                updateData[key] = value;
              } else if (value !== undefined && value !== null) {
                // Convert single value to array
                updateData[key] = [value];
              }
            } else {
              // For non-ObjectID fields, trim as usual
              // Only trim if value exists and has a trim method (strings)
              if (value && typeof value === 'string') {
                updateData[key] = value.trim();
              } else if (value !== undefined && value !== null) {
                // For non-string values (numbers, booleans, objects, arrays), keep as is
                updateData[key] = value;
              }
            }
          }
        }
      });
    }

    // Handle multiselect fields (fields with field_type: "multiselect" that come as fieldName[] from forms)
    Object.keys(modelSchema).forEach((fieldName) => {
      const fieldConfig = modelSchema[fieldName];
      // Check if field has field_type: "multiselect" and if request has fieldName[] format
      if (fieldConfig && fieldConfig.field_type === "multiselect" && req.body[`${fieldName}[]`] !== undefined) {
        console.log(`🔍 Processing multiselect field (UPDATE): ${fieldName}[]`);
        console.log(`🔍 Raw form data:`, req.body[`${fieldName}[]`]);
        
        // Convert array field to proper format
        const multiselectValue = req.body[`${fieldName}[]`];
        updateData[fieldName] = Array.isArray(multiselectValue) 
          ? multiselectValue 
          : [multiselectValue];
        
        console.log(`🔍 Processed data:`, updateData[fieldName]);
        
        // Remove the original array field key if it exists in updateData
        delete updateData[`${fieldName}[]`];
      }
    });

    // Process nested array fields for updates (e.g., warehouse_inventory[warehouse_id], warehouse_inventory[quantity])
    Object.keys(req.body).forEach((key) => {
      // Skip multiselect fields that are already handled (format: fieldName[])
      if (key.endsWith('[]') && modelSchema[key.slice(0, -2)] && modelSchema[key.slice(0, -2)].field_type === "multiselect") {
        return;
      }
      
      const arrayMatch = key.match(/^(.+)\[(\w+)\]$/);
      if (arrayMatch) {
        const arrayFieldName = arrayMatch[1]; // e.g., "warehouse_inventory"
        const arrayItemField = arrayMatch[2]; // e.g., "warehouse_id" or "quantity"
        
        // Check if this is a valid array field in the schema
        if (modelSchema[arrayFieldName] && Array.isArray(modelSchema[arrayFieldName])) {
          if (!updateData[arrayFieldName]) {
            updateData[arrayFieldName] = [];
          }
          
          const value = req.body[key];
          const index = parseInt(key.match(/\[(\d+)\]/)?.[1]) || 0; // Default to index 0
          
          // Ensure we have an object at this index
          if (!updateData[arrayFieldName][index]) {
            updateData[arrayFieldName][index] = {};
          }
          
          // Set the field value
          updateData[arrayFieldName][index][arrayItemField] = value;
        }
      }
    });

    // Automatically set updated_by if field exists and user is authenticated
    if (req.user && req.user._id && modelSchema.updated_by) {
      updateData.updated_by = req.user._id;
    }

    // Automatically set company_id if field exists and user has company_id
    if (req.user && req.user.company_id && modelSchema.company_id) {
      updateData.company_id = req.user.company_id;
    }

    console.log(`📝 Preparing data for ${modelName} update:`, {
      receivedFields: Object.keys(req.body),
      schemaFields: Object.keys(modelSchema),
      allowedFields: allowedFields.length > 0 ? allowedFields : 'ALL (except password)',
      updateDataFields: Object.keys(updateData),
    });

    // Run custom validation if provided
    if (customValidation) {
      const validationResult = await customValidation(updateData, modelSchema, existingRecord);
      if (validationResult.error) {
        return {
          success: false,
          status: 400,
          ...validationResult
        };
      }
    }

    // Handle image uploads for fields with field_type: "image"
    const imageFields = Object.keys(modelSchema).filter((field) => {
      const fieldConfig = modelSchema[field];
      return fieldConfig.field_type === "image";
    });

    // Run beforeUpdate hook if provided
    if (beforeUpdate) {
      await beforeUpdate(updateData, req, existingRecord);
    }

    console.log(`✅ Updating ${modelName} with ID ${recordId}:`, {
      ...updateData,
      password: updateData.password ? "[HIDDEN]" : undefined,
    });

    // Update the record
    const updatedRecord = await Model.findByIdAndUpdate(
      recordId,
      updateData,
      { new: true, runValidators: true }
    );

    // Handle image uploads for update
    for (const imageField of imageFields) {
      try {
        const uploaded = await handleImageUpload(req, imageField, modelName, recordId);
        if (uploaded) {
          const expectsArray = Array.isArray(Model.schema.obj[imageField]?.type) || Model.schema.paths[imageField]?.instance === 'Array';
          updatedRecord[imageField] = expectsArray ? (Array.isArray(uploaded) ? uploaded : [uploaded]) : (Array.isArray(uploaded) ? uploaded[0] : uploaded);
          await updatedRecord.save();
        }
      } catch (error) {
        console.error(`❌ Error uploading image for field ${imageField}:`, error);
        // Continue with other fields even if one image upload fails
      }
    }

    // Run afterUpdate hook if provided
    if (afterUpdate) {
      await afterUpdate(updatedRecord, req, existingRecord);
    }

    // Prepare response data (exclude specified fields)
    const responseData = { ...updatedRecord.toObject() };
    excludeFields.forEach((field) => {
      delete responseData[field];
    });

    return {
      success: true,
      status: 200,
      message: `${modelName} updated successfully`,
      data: responseData,
    };

  } catch (error) {
    console.error("❌ Update error:", error);

    // Handle custom error handlers first
    if (errorHandlers[error.code]) {
      return errorHandlers[error.code](error);
    }

    // Handle specific error types
    switch (error.name) {
      case "ValidationError":
        const validationErrors = Object.values(error.errors).map(
          (err) => err.message
        );
        return {
          success: false,
          status: 400,
          error: "Validation failed",
          details: validationErrors,
          type: "validation",
        };

      case "CastError":
        if (error.path === "_id") {
          return {
            success: false,
            status: 400,
            error: "Invalid ID format",
            details: "The provided ID is not in the correct format",
            type: "invalid_id",
          };
        }
        return {
          success: false,
          status: 400,
          error: "Invalid data type",
          details: `${error.path} should be ${error.kind}`,
          type: "cast",
        };

      case "MongoError":
      case "MongoServerError":
        // Handle MongoDB specific errors
        switch (error.code) {
          case 11000:
            const duplicateField = Object.keys(error.keyPattern)[0];
            return {
              success: false,
              status: 409,
              error: "Duplicate entry",
              details: `${duplicateField} already exists`,
              type: "duplicate",
            };
          case 121:
            return {
              success: false,
              status: 400,
              error: "Document validation failed",
              details: error.errmsg,
              type: "document_validation",
            };
          default:
            return {
              success: false,
              status: 500,
              error: "Database error",
              details: error.message,
              type: "database",
            };
        }

      case "TypeError":
        return {
          success: false,
          status: 400,
          error: "Type error",
          details: error.message,
          type: "type",
        };

      case "ReferenceError":
        return {
          success: false,
          status: 500,
          error: "Reference error",
          details: error.message,
          type: "reference",
        };

      case "SyntaxError":
        return {
          success: false,
          status: 400,
          error: "Syntax error",
          details: error.message,
          type: "syntax",
        };

      case "RangeError":
        return {
          success: false,
          status: 400,
          error: "Range error",
          details: error.message,
          type: "range",
        };

      case "URIError":
        return {
          success: false,
          status: 400,
          error: "URI error",
          details: error.message,
          type: "uri",
        };

      case "EvalError":
        return {
          success: false,
          status: 500,
          error: "Evaluation error",
          details: error.message,
          type: "eval",
        };

      default:
        // Handle unknown errors
        if (error.code) {
          // Handle HTTP status codes
          const statusCode =
            error.code >= 400 && error.code < 600 ? error.code : 500;
          return {
            success: false,
            status: statusCode,
            error: error.message || "Unknown error",
            details: error.stack,
            type: "unknown",
            code: error.code,
          };
        }

        // Handle network/connection errors
        if (error.message && error.message.includes("ECONNREFUSED")) {
          return {
            success: false,
            status: 503,
            error: "Database connection failed",
            details: "Unable to connect to database",
            type: "connection",
          };
        }

        if (error.message && error.message.includes("timeout")) {
          return {
            success: false,
            status: 408,
            error: "Request timeout",
            details: "Operation timed out",
            type: "timeout",
          };
        }

        // Handle memory errors
        if (error.message && error.message.includes("ENOMEM")) {
          return {
            success: false,
            status: 507,
            error: "Insufficient storage",
            details: "Server is out of memory",
            type: "memory",
          };
        }

        // Handle file system errors
        if (error.code && error.code.startsWith("ENOENT")) {
          return {
            success: false,
            status: 500,
            error: "File not found",
            details: "Required file or directory not found",
            type: "file_system",
          };
        }

        // Generic error handler
        return {
          success: false,
          status: 500,
          error: "Internal server error",
          details:
            process.env.NODE_ENV === "development"
              ? error.stack
              : "Something went wrong",
          type: "internal",
          timestamp: new Date().toISOString(),
        };
    }
  }
};

/**
 * Generic get all records function that works with any model
 * @param {Object} req - Express request object
 * @param {string} controllerName - The name of the controller/model (optional, auto-detected if not provided)
 * @param {Object} options - Additional options
 * @returns {Promise} Express response
 */
const handleGenericGetAll = async (req, controllerName = null, options = {}) => {
  // Auto-detect controller name if not provided or empty
  const modelName = (controllerName && controllerName.trim() !== '') ? controllerName : getControllerName();
  
  if (!modelName) {
    return {
      success: false,
      status: 500,
      error: "Controller name is required",
      details: "Please provide the controller name as the third parameter",
      type: "configuration",
    };
  }

  const {
    excludeFields = [], // Fields to exclude from response
    populate = [], // Fields to populate (array of field names)
    sort = { createdAt: -1 }, // Sort options
    limit = null, // Limit number of records
    skip = 0, // Skip number of records (for pagination)
    filter = {}, // Filter conditions
    errorHandlers = {}, // Custom error handlers
  } = options;

  try {
    // Dynamically get the model
    const Model = getModelFromController(modelName);

    console.log(`🔍 Fetching all ${modelName} records with filter:`, filter);

    // Build query
    let query = Model.find(filter);

    // Add population if specified
    if (populate && populate.length > 0) {
      populate.forEach(field => {
        query = query.populate(field);
      });
    }

    // Add sorting
    if (sort) {
      query = query.sort(sort);
    }

    // Add pagination
    if (skip > 0) {
      query = query.skip(skip);
    }

    if (limit) {
      query = query.limit(limit);
    }

    // Execute query
    const records = await query;

    // Get total count for pagination info
    const totalCount = await Model.countDocuments(filter);

    // Prepare response data (exclude specified fields)
    const responseData = records.map(record => {
      const data = { ...record.toObject() };
      excludeFields.forEach((field) => {
        delete data[field];
      });
      return data;
    });

    console.log(`✅ Successfully fetched ${responseData.length} ${modelName} records`);

    return {
      success: true,
      status: 200,
      data: responseData,
      pagination: {
        total: totalCount,
        count: responseData.length,
        skip: skip,
        limit: limit,
      },
    };

  } catch (error) {
    console.error("❌ Get all error:", error);

    // Handle custom error handlers first
    if (errorHandlers[error.code]) {
      return errorHandlers[error.code](error);
    }

    // Handle specific error types
    switch (error.name) {
      case "CastError":
        return {
          success: false,
          status: 400,
          error: "Invalid data type",
          details: `${error.path} should be ${error.kind}`,
          type: "cast",
        };

      case "MongoError":
      case "MongoServerError":
        return {
          success: false,
          status: 500,
          error: "Database error",
          details: error.message,
          type: "database",
        };

      case "TypeError":
        return {
          success: false,
          status: 400,
          error: "Type error",
          details: error.message,
          type: "type",
        };

      case "ReferenceError":
        return {
          success: false,
          status: 500,
          error: "Reference error",
          details: error.message,
          type: "reference",
        };

      default:
        // Handle unknown errors
        if (error.code) {
          // Handle HTTP status codes
          const statusCode = error.code >= 400 && error.code < 600 ? error.code : 500;
          return {
            success: false,
            status: statusCode,
            error: error.message || "Unknown error",
            details: error.stack,
            type: "unknown",
            code: error.code,
          };
        }

        // Handle network/connection errors
        if (error.message && error.message.includes("ECONNREFUSED")) {
          return {
            success: false,
            status: 503,
            error: "Database connection failed",
            details: "Unable to connect to database",
            type: "connection",
          };
        }

        // Generic error handler
        return {
          success: false,
          status: 500,
          error: "Internal server error",
          details: process.env.NODE_ENV === "development" ? error.stack : "Something went wrong",
          type: "internal",
          timestamp: new Date().toISOString(),
        };
    }
  }
};

/**
 * Generic get by ID function that works with any model
 * @param {Object} req - Express request object
 * @param {string} controllerName - The name of the controller/model (optional, auto-detected if not provided)
 * @param {Object} options - Additional options
 * @returns {Promise} Express response
 */
const handleGenericGetById = async (req, controllerName = null, options = {}) => {
  // Auto-detect controller name if not provided or empty
  const modelName = (controllerName && controllerName.trim() !== '') ? controllerName : getControllerName();
  
  if (!modelName) {
    return {
      success: false,
      status: 500,
      error: "Controller name is required",
      details: "Please provide the controller name as the third parameter",
      type: "configuration",
    };
  }

  const {
    idParam = "id", // URL parameter name for ID (default: 'id')
    excludeFields = [], // Fields to exclude from response
    populate = [], // Fields to populate (array of field names)
    filter = {}, // Additional filters (e.g., { company_id: req.user.company_id })
    errorHandlers = {}, // Custom error handlers
  } = options;

  // Get ID from URL parameters
  const recordId = req.params[idParam];
  if (!recordId) {
    return {
      success: false,
      status: 400,
      error: "Record ID is required",
      details: `Please provide ${idParam} in the URL parameters`,
      type: "missing_id",
    };
  }

  try {
    // Dynamically get the model
    const Model = getModelFromController(modelName);

    console.log(`🔍 Fetching ${modelName} with ID: ${recordId}`);

    // Build query
    let query = Model.findOne({ _id: recordId, ...filter });

    // Add population if specified
    if (populate && populate.length > 0) {
      populate.forEach(field => {
        query = query.populate(field);
      });
    }

    // Execute query
    const record = await query;

    if (!record) {
      return {
        success: false,
        status: 404,
        error: "Record not found",
        details: `${modelName} with ID ${recordId} not found`,
        type: "not_found",
      };
    }

    // Prepare response data (exclude specified fields)
    const responseData = { ...record.toObject() };
    excludeFields.forEach((field) => {
      delete responseData[field];
    });

    console.log(`✅ Successfully fetched ${modelName} with ID: ${recordId}`);

    return {
      success: true,
      status: 200,
      data: responseData,
    };

  } catch (error) {
    console.error("❌ Get by ID error:", error);

    // Handle custom error handlers first
    if (errorHandlers[error.code]) {
      return errorHandlers[error.code](error);
    }

    // Handle specific error types
    switch (error.name) {
      case "CastError":
        if (error.path === "_id") {
          return {
            success: false,
            status: 400,
            error: "Invalid ID format",
            details: "The provided ID is not in the correct format",
            type: "invalid_id",
          };
        }
        return {
          success: false,
          status: 400,
          error: "Invalid data type",
          details: `${error.path} should be ${error.kind}`,
          type: "cast",
        };

      case "MongoError":
      case "MongoServerError":
        return {
          success: false,
          status: 500,
          error: "Database error",
          details: error.message,
          type: "database",
        };

      case "TypeError":
        return {
          success: false,
          status: 400,
          error: "Type error",
          details: error.message,
          type: "type",
        };

      case "ReferenceError":
        return {
          success: false,
          status: 500,
          error: "Reference error",
          details: error.message,
          type: "reference",
        };

      default:
        // Handle unknown errors
        if (error.code) {
          // Handle HTTP status codes
          const statusCode = error.code >= 400 && error.code < 600 ? error.code : 500;
          return {
            success: false,
            status: statusCode,
            error: error.message || "Unknown error",
            details: error.stack,
            type: "unknown",
            code: error.code,
          };
        }

        // Handle network/connection errors
        if (error.message && error.message.includes("ECONNREFUSED")) {
          return {
            success: false,
            status: 503,
            error: "Database connection failed",
            details: "Unable to connect to database",
            type: "connection",
          };
        }

        // Generic error handler
        return {
          success: false,
          status: 500,
          error: "Internal server error",
          details: process.env.NODE_ENV === "development" ? error.stack : "Something went wrong",
          type: "internal",
          timestamp: new Date().toISOString(),
        };
    }
  }
};

/**
 * Generic function to find one record based on custom parameters
 * @param {Object} req - Express request object
 * @param {string} controllerName - Name of the controller/model (optional, auto-detected if not provided)
 * @param {Object} options - Configuration options
 * @returns {Object} Response object with success status and data
 * 
 * Usage examples:
 * - Find by email: handleGenericFindOne(req, "user", { searchCriteria: { email: req.body.email } })
 * - Find by slug: handleGenericFindOne(req, "blog", { searchCriteria: { slug: req.params.slug } })
 * - Find with custom criteria: handleGenericFindOne(req, "product", { 
 *     searchCriteria: { category: "electronics", active: true },
 *     populate: ["category", "reviews"],
 *     excludeFields: ["internal_notes"]
 *   })
 */
const handleGenericFindOne = async (req, controllerName = null, options = {}) => {
  // Auto-detect controller name if not provided or empty
  const modelName = (controllerName && controllerName.trim() !== '') ? controllerName : getControllerName();
  
  if (!modelName) {
    return {
      success: false,
      status: 500,
      error: "Controller name is required",
      details: "Please provide the controller name as the second parameter",
      type: "configuration",
    };
  }

  const {
    searchCriteria = {}, // Object with search criteria (e.g., { email: "user@example.com" })
    excludeFields = [], // Fields to exclude from response
    includeFields = [], // Fields to include (if specified, only these will be returned)
    populate = [], // Fields to populate (array of field names or objects)
    sort = {}, // Sort criteria (e.g., { createdAt: -1 })
    errorHandlers = {}, // Custom error handlers
    beforeFind = null, // Function to execute before finding (async function(searchCriteria, req))
    afterFind = null, // Function to execute after finding (async function(record, req))
  } = options;

  // Validate search criteria
  if (!searchCriteria || Object.keys(searchCriteria).length === 0) {
    return {
      success: false,
      status: 400,
      error: "Search criteria required",
      details: "Please provide searchCriteria in options to find a record",
      type: "missing_criteria",
    };
  }

  try {
    // Dynamically get the model
    const Model = getModelFromController(modelName);

    console.log(`🔍 Finding one ${modelName} with criteria:`, searchCriteria);

    // Execute beforeFind hook if provided
    let finalCriteria = { ...searchCriteria };
    if (beforeFind && typeof beforeFind === 'function') {
      try {
        const beforeResult = await beforeFind(finalCriteria, req);
        if (beforeResult) {
          finalCriteria = beforeResult;
        }
      } catch (hookError) {
        console.warn("⚠️ beforeFind hook error:", hookError);
      }
    }

    // Build query
    let query = Model.findOne(finalCriteria);

    // Add field selection if specified
    if (includeFields && includeFields.length > 0) {
      const fieldSelection = includeFields.join(' ');
      query = query.select(fieldSelection);
    } else if (excludeFields && excludeFields.length > 0) {
      const fieldExclusion = excludeFields.map(field => `-${field}`).join(' ');
      query = query.select(fieldExclusion);
    }

    // Add population if specified
    if (populate && populate.length > 0) {
      populate.forEach(field => {
        if (typeof field === 'string') {
          query = query.populate(field);
        } else if (typeof field === 'object') {
          // Support for complex population like { path: 'author', select: 'name email' }
          query = query.populate(field);
        }
      });
    }

    // Add sorting if specified
    if (sort && Object.keys(sort).length > 0) {
      query = query.sort(sort);
    }

    // Execute query
    const record = await query;

    if (!record) {
      return {
        success: false,
        status: 404,
        error: "Record not found",
        details: `${modelName} with criteria ${JSON.stringify(finalCriteria)} not found`,
        type: "not_found",
      };
    }

    // Execute afterFind hook if provided
    if (afterFind && typeof afterFind === 'function') {
      try {
        await afterFind(record, req);
      } catch (hookError) {
        console.warn("⚠️ afterFind hook error:", hookError);
      }
    }

    // Prepare response data
    let responseData;
    if (record.toObject) {
      responseData = record.toObject();
    } else {
      responseData = { ...record };
    }

    // Additional field exclusion (in case select didn't work or for computed fields)
    if (!includeFields || includeFields.length === 0) {
      excludeFields.forEach((field) => {
        delete responseData[field];
      });
    }

    console.log(`✅ Successfully found ${modelName} with criteria:`, finalCriteria);

    return {
      success: true,
      status: 200,
      data: responseData,
    };

  } catch (error) {
    console.error("❌ Find one error:", error);

    // Handle custom error handlers first
    if (errorHandlers[error.code]) {
      return errorHandlers[error.code](error);
    }

    // Handle specific error types
    switch (error.name) {
      case "CastError":
        return {
          success: false,
          status: 400,
          error: "Invalid data format",
          details: `Invalid format for field: ${error.path}`,
          type: "invalid_format",
        };

      case "ValidationError":
        const validationErrors = Object.values(error.errors).map(err => ({
          field: err.path,
          message: err.message
        }));
        
        return {
          success: false,
          status: 400,
          error: "Validation failed",
          details: validationErrors,
          type: "validation",
        };

      default:
        return {
          success: false,
          status: 500,
          error: "Database error",
          details: error.message,
          type: "database",
        };
    }
  }
};

module.exports = {
  generateSlug,
  getControllerName,
  getModelFromController,
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  handleImageUpload,
};

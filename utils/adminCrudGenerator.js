const mongoose = require('mongoose');
const path = require('path');
const routeRegistry = require('./routeRegistry');
const Company = require('../models/company');

/**
 * Generic Admin CRUD Generator
 * Automatically generates listing, insert, update, and delete functionality with forms
 * 
 * @param {Object} Model - Mongoose model
 * @param {string} modelName - Name for routes (e.g., 'users', 'products')
 * @param {Array} fields - Array of field names to include in forms
 * @param {Object} options - Customization options
 * @returns {Object} - Generated CRUD controller, routes, and views
 */
function adminCrudGenerator(Model, modelName, fields = [], options = {}) {
  const {
    // Custom validation rules
    validation = {},
    // Custom middleware
    middleware = {},
    // Custom hooks
    hooks = {},
    // Custom field processing
    fieldProcessing = {},
    // Custom response formatting
    responseFormatting = {},
    // Custom error handling
    errorHandling = {},
    // Excluded fields from responses
    excludedFields = ['__v'],
    // Included fields in responses
    includedFields = [],
    // Soft delete support
    softDelete = false,
    // Custom form field types
    fieldTypes = {},
    // Custom form field labels
    fieldLabels = {},
    // Custom form field validation
    fieldValidation = {},
    // Custom form field options (for selects, etc.)
    fieldOptions = {},
    // Custom searchable fields
    searchableFields = [],
    // Custom filterable fields
    filterableFields = [],
    // Custom sortable fields
    sortableFields = [],
    // Custom pagination
    pagination = { defaultLimit: 20, maxLimit: 100 },
    // Custom view templates
    viewTemplates = {},
    // Custom CSS classes
    cssClasses = {},
    // Custom JavaScript functions
    customJS = {},
    // Base URL for assets and links
    baseUrl = process.env.BASE_URL || 'http://localhost:8000'
  } = options;

  // Convert modelName to singular and title case
  const singularName = modelName.slice(-1) === 's' ? modelName.slice(0, -1) : modelName;
  const titleCase = singularName.charAt(0).toUpperCase() + singularName.slice(1);

  // Auto-detect fields from model schema if not provided
  if (fields.length === 0) {
    fields = Object.keys(Model.schema.paths).filter(field => 
      !['_id', '__v', 'createdAt', 'updatedAt', 'created_by', 'updated_by', 'company_id'].includes(field)
    );
  }

  // Generate field configuration
  const fieldConfig = generateFieldConfig(Model, fields, fieldTypes, fieldLabels, fieldValidation, fieldOptions);

  /**
   * LIST - Display all records with pagination, search, and filters
   */
  async function list(req, res) {
    try {
      const { 
        page = 1, 
        limit = pagination.defaultLimit, 
        sortBy = 'createdAt', 
        sortOrder = 'desc',
        search = '',
        ...filters 
      } = req.query;

      // Build query
      let query = {};
      
      // Apply search
      if (search && searchableFields.length > 0) {
        const searchQuery = searchableFields.map(field => ({
          [field]: { $regex: search, $options: 'i' }
        }));
        query.$or = searchQuery;
      }

      // Apply filters
      // If filterableFields is empty, use all fields that are displayed (excluding system fields)
      const fieldsToFilter = filterableFields.length > 0 ? filterableFields : fields.filter(field => 
        !['_id', '__v', 'createdAt', 'updatedAt', 'deletedAt', 'created_by', 'updated_by', 'company_id'].includes(field)
      );
      
      fieldsToFilter.forEach(field => {
        if (filters[field] !== undefined && filters[field] !== '') {
          if (typeof filters[field] === 'string' && filters[field].includes(',')) {
            query[field] = { $in: filters[field].split(',') };
          } else if (filters[field] === 'true' || filters[field] === 'false') {
            query[field] = filters[field] === 'true';
          } else if (!isNaN(filters[field])) {
            query[field] = Number(filters[field]);
          } else {
            query[field] = filters[field];
          }
        }
      });

      // Apply soft delete filter based on query parameter
      if (softDelete) {
        const showDeleted = req.query.deleted === 'true';
        if (showDeleted) {
          // Show only deleted records
          query.deletedAt = { $exists: true, $ne: null };
        } else {
          // Show only active records (default) - check for null or non-existent
          // Merge with existing $or query if search is active
          if (query.$or) {
            // If there's already a $or query (from search), combine them using $and
            const deletedAtCondition = {
              $or: [
                { deletedAt: { $exists: false } },
                { deletedAt: null }
              ]
            };
            query = { $and: [query, deletedAtCondition] };
          } else {
            // No existing $or, just set the deletedAt condition
            query.$or = [
              { deletedAt: { $exists: false } },
              { deletedAt: null }
            ];
          }
        }
      }

      // Apply custom filters
      if (middleware.applyFilters) {
        query = await middleware.applyFilters(query, req);
      }

      // Handle company_id from URL query parameter (for filtering by company)
      if (req.query.company_id && mongoose.Types.ObjectId.isValid(req.query.company_id)) {
        query.company_id = new mongoose.Types.ObjectId(req.query.company_id);
        console.log(`🔍 list - Filtering by company_id from URL: ${req.query.company_id}`);
      }

      // Build sort object
      const sort = {};
      if (sortableFields.includes(sortBy)) {
        sort[sortBy] = sortOrder === 'desc' ? -1 : 1;
      } else {
        sort.createdAt = -1; // Default sort
      }

      // Calculate pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const actualLimit = Math.min(parseInt(limit), pagination.maxLimit);
      const total = await Model.countDocuments(query);

      // Execute query
      let records = await Model.find(query)
        .sort(sort)
        .skip(skip)
        .limit(actualLimit)
        .select(includedFields.length > 0 ? includedFields.join(' ') : `-${excludedFields.join(' -')}`);

      // Apply custom middleware
      if (middleware.afterQuery) {
        records = await middleware.afterQuery(records, req);
        // Update fieldConfig with any changes made by middleware
        if (req.fieldConfig) {
          Object.assign(fieldConfig, req.fieldConfig);
        }
      }

      // Debug logging for fieldConfig options
      console.log('🔍 FieldConfig debug:');
      Object.keys(fieldConfig).forEach(fieldName => {
        if (fieldConfig[fieldName].type === 'select') {
          console.log(`🔍 Field: ${fieldName}`);
          console.log(`🔍 Type: ${fieldConfig[fieldName].type}`);
          console.log(`🔍 Options:`, fieldConfig[fieldName].options);
          console.log(`🔍 Options length:`, fieldConfig[fieldName].options ? fieldConfig[fieldName].options.length : 'undefined');
        }
      });

      // Format response
      if (responseFormatting.list) {
        records = await responseFormatting.list(records, req);
      }

      // Calculate pagination info
      const totalPages = Math.ceil(total / actualLimit);

      // Check if showing deleted records
      const showDeleted = req.query.deleted === 'true';

      // Get deleted records count for the badge (only if soft delete is enabled)
      let deletedPagination = null;
      if (softDelete) {
        try {
          // Build query for deleted records count
          let deletedQuery = {};
          
          // Apply search to deleted records
          if (search && searchableFields.length > 0) {
            const searchQuery = searchableFields.map(field => ({
              [field]: { $regex: search, $options: 'i' }
            }));
            deletedQuery.$or = searchQuery;
          }

          // Apply filters to deleted records
          filterableFields.forEach(field => {
            if (filters[field] !== undefined && filters[field] !== '') {
              if (typeof filters[field] === 'string' && filters[field].includes(',')) {
                deletedQuery[field] = { $in: filters[field].split(',') };
              } else if (filters[field] === 'true' || filters[field] === 'false') {
                deletedQuery[field] = filters[field] === 'true';
              } else if (!isNaN(filters[field])) {
                deletedQuery[field] = Number(filters[field]);
              } else {
                deletedQuery[field] = filters[field];
              }
            }
          });

          // Only show deleted records
          deletedQuery.deletedAt = { $exists: true, $ne: null };

          // Get count of deleted records
          const deletedTotal = await Model.countDocuments(deletedQuery);
          
          deletedPagination = {
            totalItems: deletedTotal
          };
        } catch (error) {
          console.error('Error getting deleted records count:', error);
          deletedPagination = { totalItems: 0 };
        }
      }

      // Resolve custom tabs for the current module
      const routeTabs = routeRegistry.getCustomTabs(modelName) || [];
      const activePath = `${req.baseUrl || ''}${req.path === '/' ? '' : req.path}`;

      // Fetch company options for filters (only if the model uses company_id)
      let companyOptions = [];
      if (Model.schema.paths.company_id) {
        try {
          companyOptions = await Company.find({ deletedAt: null })
            .select('_id company_name')
            .sort({ company_name: 1 })
            .lean();
          companyOptions = companyOptions.map(company => ({
            _id: company._id.toString(),
            company_name: company.company_name
          }));
        } catch (error) {
          console.error('Error fetching company options:', error);
        }
      }

      // Render the list view
      res.render('admin/list', {
        title: `${titleCase}s`,
        modelName,
        singularName,
        titleCase,
        records,
        fieldConfig,
        showDeleted,
        deletedPagination,
        softDelete, // Pass softDelete flag to template
        routes: req.routes || [], // Add routes data for dynamic menu
        baseUrl: req.baseUrl || 'http://localhost:8000',
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalItems: total,
          itemsPerPage: actualLimit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        filters: {
          search,
          applied: Object.keys(filters),
          searchable: searchableFields,
          filterable: filterableFields,
          sortable: sortableFields,
          company_id: filters.company_id || ''
        },
        companies: companyOptions,
        cssClasses,
        customJS,
        baseUrl: getBaseUrl(),
        customTabs: routeTabs,
        customTabsActivePath: activePath || undefined
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'list', req);
      if (errorResponse.statusCode === 500) {
        res.status(500).render('admin/error', {
          title: 'Error',
          message: 'An error occurred while loading the data',
          error: errorResponse,
          baseUrl: getBaseUrl()
        });
      } else {
        res.status(errorResponse.statusCode).json(errorResponse);
      }
    }
  }

  /**
   * CREATE FORM - Display form for creating new record
   */
  async function createForm(req, res) {
    try {
      console.log(`🚀 createForm called for model: ${modelName}`);
      console.log(`🚀 createForm URL: ${req.url}`);
      console.log(`🚀 createForm middleware.beforeCreateForm exists:`, !!middleware.beforeCreateForm);
      
      // Set fieldConfig on req before middleware runs
      req.fieldConfig = fieldConfig;
      console.log(`🚀 createForm - fieldConfig keys:`, Object.keys(fieldConfig));
      
      // Apply custom middleware
      if (middleware.beforeCreateForm) {
        console.log(`🚀 createForm - calling beforeCreateForm middleware...`);
        await middleware.beforeCreateForm(req, res);
        console.log(`✅ createForm - beforeCreateForm middleware completed`);
      } else {
        console.log(`⚠️ createForm - no beforeCreateForm middleware defined`);
      }

      // Use the modified fieldConfig from req if available, otherwise use the original
      const finalFieldConfig = req.fieldConfig || fieldConfig;
      
      // Debug: Check fieldConfig state
      console.log(`🔍 adminCrudGenerator [${modelName}] - finalFieldConfig keys:`, Object.keys(finalFieldConfig));
      if (finalFieldConfig.warehouse_id) {
        console.log(`🔍 adminCrudGenerator [${modelName}] - warehouse_id exists in finalFieldConfig`);
        console.log(`🔍 adminCrudGenerator [${modelName}] - warehouse_id options:`, finalFieldConfig.warehouse_id.options?.length || 0);
      } else {
        console.log(`⚠️ adminCrudGenerator [${modelName}] - warehouse_id NOT in finalFieldConfig`);
      }

      // Create record object with default values
      const recordWithDefaults = {};
      Object.keys(finalFieldConfig).forEach(fieldName => {
        const field = finalFieldConfig[fieldName];
        if (field.defaultValue !== null && field.defaultValue !== undefined) {
          recordWithDefaults[fieldName] = field.defaultValue;
        }
      });

      res.render('admin/create', {
        title: `Create ${titleCase}`,
        modelName,
        singularName,
        titleCase,
        fieldConfig: finalFieldConfig,
        record: recordWithDefaults, // Record with default values
        action: `/admin/${modelName}`,
        method: 'POST',
        errors: [],
        cssClasses,
        customJS,
        routes: req.routes || [], // Add routes data for dynamic menu
        baseUrl: getBaseUrl(),
        warehouses: req.warehouses || [] // Pass warehouses from middleware
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'createForm', req);
      res.status(errorResponse.statusCode).render('admin/error', {
        title: 'Error',
        message: 'An error occurred while loading the form',
        error: errorResponse,
        baseUrl: getBaseUrl()
      });
    }
  }

  /**
   * INSERT - Create a new record
   */
  async function insert(req, res) {
    try {
      // Apply custom validation
      if (validation.insert) {
        const validationResult = await validation.insert(req.body);
        if (!validationResult.isValid) {
          return res.status(400).render('admin/create', {
            title: `Create ${titleCase}`,
            modelName,
            singularName,
            titleCase,
            fieldConfig,
            record: req.body,
            action: `/admin/${modelName}`,
            method: 'POST',
            errors: validationResult.errors,
            cssClasses,
            customJS,
            baseUrl: getBaseUrl(),
            warehouses: req.warehouses || [] // Pass warehouses even on validation errors
          });
        }
      }

      // Apply custom middleware
      if (middleware.beforeInsert) {
        await middleware.beforeInsert(req, res);
      }

      // Process fields
      let data = { ...req.body };
      
      // Debug: Log all req.body keys related to multiselect fields
      console.log(`🔍 All req.body keys:`, Object.keys(req.body));
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect') {
          console.log(`🔍 Checking multiselect field: ${fieldName}`);
          console.log(`🔍 req.body[${fieldName}]:`, req.body[fieldName]);
          console.log(`🔍 req.body[${fieldName}[]]:`, req.body[`${fieldName}[]`]);
          // Check for indexed format
          Object.keys(req.body).forEach(key => {
            if (key.startsWith(`${fieldName}[`) && key.includes(']')) {
              console.log(`🔍 Found indexed key: ${key} =`, req.body[key]);
            }
          });
        }
      });
      
      // Handle array fields (multiselect fields with [] in name or indexed format like category_id[0])
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect') {
          // FIRST: Check if the field already exists in req.body (might be parsed from indexed format)
          // This handles cases where express-fileupload/body-parser already parsed category_id[0] into category_id
          if (req.body[fieldName] && (Array.isArray(req.body[fieldName]) || typeof req.body[fieldName] === 'object')) {
            console.log(`🔍 Found ${fieldName} directly in req.body (likely parsed from indexed format):`, req.body[fieldName]);
            let values = req.body[fieldName];
            
            // Extract values from objects if array contains objects
            // e.g., [ { '0': 'id' } ] -> [ 'id' ]
            const extractedValues = [];
            if (Array.isArray(values)) {
              values.forEach((val, idx) => {
                if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof mongoose.Types.ObjectId)) {
                  // Extract value from object like { '0': 'id' } or { 'category_id': 'id' }
                  const objValue = Object.values(val)[0];
                  if (objValue) {
                    extractedValues.push(objValue);
                    console.log(`✅ Extracted from object at index ${idx}:`, objValue);
                  }
                } else {
                  extractedValues.push(val);
                }
              });
            } else if (typeof values === 'object' && values !== null) {
              // Handle object with numeric keys like { '0': 'id', '1': 'id2' }
              const sortedKeys = Object.keys(values).sort((a, b) => parseInt(a) - parseInt(b));
              sortedKeys.forEach(key => {
                extractedValues.push(values[key]);
              });
            }
            
            values = extractedValues.length > 0 ? extractedValues : (Array.isArray(values) ? values : [values]);
            
            // Process as ObjectId array
            const schemaPath = Model.schema.paths[fieldName];
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              const processedValues = [];
              values.forEach((val, idx) => {
                if (!val || val === '' || val === null || val === undefined) return;
                
                if (val instanceof mongoose.Types.ObjectId) {
                  processedValues.push(val);
                } else if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val.trim())) {
                  processedValues.push(new mongoose.Types.ObjectId(val.trim()));
                }
              });
              data[fieldName] = processedValues;
              console.log(`✅ Processed direct field ${fieldName} (from parsed format):`, data[fieldName]);
              
              // Remove from req.body to prevent re-processing
              delete req.body[fieldName];
              return; // Skip other checks
            }
          }
          
          // SECOND: Check for indexed array format (category_id[0], category_id[1], etc.)
          const indexedPattern = new RegExp(`^${fieldName}\\[\\d+\\]$`);
          const indexedValues = [];
          Object.keys(req.body).forEach(key => {
            if (indexedPattern.test(key)) {
              const index = parseInt(key.match(/\[(\d+)\]/)[1]);
              let value = req.body[key];
              
              // Handle stringified values
              if (typeof value === 'string') {
                value = value.trim();
                console.log(`🔍 Processing indexed field ${key}:`, value, `(type: ${typeof value})`);
                
                // Try to parse if it looks like JSON
                if ((value.startsWith('[') || value.startsWith('{')) && value.length > 1) {
                  try {
                    // Replace single quotes with double quotes for JSON parsing
                    let jsonString = value.replace(/'/g, '"');
                    const parsed = JSON.parse(jsonString);
                    console.log(`✅ Parsed JSON from ${key}:`, parsed);
                    
                    // If parsed is an array, extract values
                    if (Array.isArray(parsed)) {
                      parsed.forEach((item, i) => {
                        if (typeof item === 'object' && item !== null) {
                          // Extract value from object like { '0': 'id' } or { 'category_id': 'id' }
                          const objValue = Object.values(item)[0];
                          if (objValue) {
                            indexedValues[index + i] = objValue;
                            console.log(`✅ Extracted from array item ${i}:`, objValue);
                          }
                        } else {
                          indexedValues[index + i] = item;
                          console.log(`✅ Using array item ${i} directly:`, item);
                        }
                      });
                      // Skip adding the original value since we processed the array
                      return;
                    }
                    // If parsed is an object, extract the value
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                      const objValue = Object.values(parsed)[0];
                      if (objValue) {
                        value = objValue;
                        console.log(`✅ Extracted from object:`, value);
                      }
                    }
                  } catch (e) {
                    console.log(`⚠️ Failed to parse JSON from ${key}:`, e.message);
                    // If it's a valid ObjectId string, use it directly
                    if (mongoose.Types.ObjectId.isValid(value)) {
                      indexedValues[index] = value;
                      return;
                    }
                    // Not valid JSON, use as is
                  }
                } else if (mongoose.Types.ObjectId.isValid(value)) {
                  // Direct ObjectId string
                  indexedValues[index] = value;
                  return;
                }
              }
              
              indexedValues[index] = value;
            }
          });
          
          // Check for array format (category_id[] or category_id) or indexed format
          if (indexedValues.length > 0) {
            console.log(`🔍 Processing multiselect field: ${fieldName} (indexed format)`);
            console.log(`🔍 Found indexed values:`, indexedValues);
            
            // Use indexed values
            let values = indexedValues.filter(v => v !== undefined && v !== null);
            
            // Process the values
            const schemaPath = Model.schema.paths[fieldName];
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              const processedValues = [];
              values.forEach((val, idx) => {
                if (!val || val === '' || val === null || val === undefined) return;
                
                if (val instanceof mongoose.Types.ObjectId) {
                  processedValues.push(val);
                } else if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val.trim())) {
                  processedValues.push(new mongoose.Types.ObjectId(val.trim()));
                }
              });
              data[fieldName] = processedValues;
              console.log(`✅ Processed indexed multiselect data:`, data[fieldName]);
            } else {
              data[fieldName] = values.filter(val => val && val !== '' && val !== null && val !== undefined);
            }
            
            // Remove indexed fields from both req.body and data
            Object.keys(req.body).forEach(key => {
              if (indexedPattern.test(key)) {
                delete req.body[key];
                delete data[key]; // Also remove from data object
              }
            });
            
            // Also remove any direct fieldName entry that might be in wrong format
            if (data[fieldName] && typeof data[fieldName] === 'object' && !Array.isArray(data[fieldName])) {
              console.log(`⚠️ Removing incorrectly formatted ${fieldName} from data:`, data[fieldName]);
              delete data[fieldName];
            }
          } else if (req.body[`${fieldName}[]`]) {
            console.log(`🔍 Processing multiselect field: ${fieldName}[]`);
            console.log(`🔍 Raw form data type:`, typeof req.body[`${fieldName}[]`]);
            console.log(`🔍 Raw form data:`, req.body[`${fieldName}[]`]);
            
            // Handle different input formats
            let values = req.body[`${fieldName}[]`];
            
            // If it's a string, try to parse it
            if (typeof values === 'string') {
              // Remove any leading/trailing whitespace
              values = values.trim();
              
              // Check if it looks like a JSON string (starts with [ or {)
              if (values.startsWith('[') || values.startsWith('{')) {
                try {
                  // Try to parse as JSON
                  values = JSON.parse(values);
                  console.log(`🔍 Parsed JSON string:`, values);
                } catch (e) {
                  console.log(`⚠️ Failed to parse JSON, treating as single value:`, e.message);
                  // If not valid JSON, treat as single value
                  values = [values];
                }
              } else {
                // Not JSON, treat as single value
                values = [values];
              }
            }
            
            // If values is still a string, it might be a stringified array
            if (typeof values === 'string') {
              try {
                values = JSON.parse(values);
              } catch (e) {
                values = [values];
              }
            }
            
            // Ensure it's an array
            if (!Array.isArray(values)) {
              // If it's an object, try to extract values
              if (typeof values === 'object' && values !== null) {
                values = Object.values(values);
              } else {
                values = [values];
              }
            }
            
            console.log(`🔍 After parsing, values:`, values);
            console.log(`🔍 Is array:`, Array.isArray(values));
            
            // Filter out empty values and convert to ObjectIds if needed
            const schemaPath = Model.schema.paths[fieldName];
            
            // Check if this is an array of ObjectIds
            // For type: [mongoose.Schema.Types.ObjectId], check if it's an Array and the caster is ObjectId
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              // It's an array of ObjectIds - process each value
              const processedValues = [];
              
              values.forEach((val, idx) => {
                console.log(`🔍 Processing value ${idx}:`, val, `(type: ${typeof val})`);
                
                if (!val || val === '' || val === null || val === undefined) {
                  console.log(`⏭️ Skipping empty value at index ${idx}`);
                  return; // Skip empty values
                }
                
                // If it's already an ObjectId, use it
                if (val instanceof mongoose.Types.ObjectId) {
                  console.log(`✅ Value ${idx} is already ObjectId:`, val);
                  processedValues.push(val);
                  return;
                }
                
                // If it's a string that looks like an ObjectId, convert it
                if (typeof val === 'string') {
                  const trimmedVal = val.trim();
                  if (mongoose.Types.ObjectId.isValid(trimmedVal)) {
                    console.log(`✅ Converting string to ObjectId at index ${idx}:`, trimmedVal);
                    processedValues.push(new mongoose.Types.ObjectId(trimmedVal));
                    return;
                  }
                }
                
                // If it's an object, extract the value
                if (typeof val === 'object' && val !== null) {
                  console.log(`🔍 Value ${idx} is object, extracting values:`, val);
                  
                  // Handle objects like { '0': 'id' } or { 'id': 'value' }
                  const objValues = Object.values(val);
                  console.log(`🔍 Object values:`, objValues);
                  
                  for (const objValue of objValues) {
                    if (!objValue) continue;
                    
                    // If the object value is a string ObjectId
                    if (typeof objValue === 'string') {
                      const trimmedObjVal = objValue.trim();
                      if (mongoose.Types.ObjectId.isValid(trimmedObjVal)) {
                        console.log(`✅ Extracted ObjectId from object at index ${idx}:`, trimmedObjVal);
                        processedValues.push(new mongoose.Types.ObjectId(trimmedObjVal));
                        return;
                      }
                    }
                    
                    // If the object value is itself an ObjectId
                    if (objValue instanceof mongoose.Types.ObjectId) {
                      console.log(`✅ Extracted ObjectId from object at index ${idx}:`, objValue);
                      processedValues.push(objValue);
                      return;
                    }
                    
                    // Handle nested objects
                    if (typeof objValue === 'object' && objValue !== null) {
                      const nestedValues = Object.values(objValue);
                      for (const nestedValue of nestedValues) {
                        if (typeof nestedValue === 'string' && mongoose.Types.ObjectId.isValid(nestedValue.trim())) {
                          console.log(`✅ Extracted ObjectId from nested object at index ${idx}:`, nestedValue);
                          processedValues.push(new mongoose.Types.ObjectId(nestedValue.trim()));
                          return;
                        }
                      }
                    }
                  }
                }
                
                // Last resort: try to convert if it's valid
                if (typeof val === 'string' || typeof val === 'number') {
                  const strVal = String(val).trim();
                  if (mongoose.Types.ObjectId.isValid(strVal)) {
                    console.log(`✅ Last resort conversion at index ${idx}:`, strVal);
                    processedValues.push(new mongoose.Types.ObjectId(strVal));
                  } else {
                    console.log(`⚠️ Could not convert value at index ${idx} to ObjectId:`, val);
                  }
                } else {
                  console.log(`⚠️ Unhandled value type at index ${idx}:`, typeof val, val);
                }
              });
              
              console.log(`✅ Final processed values for ${fieldName}:`, processedValues);
              data[fieldName] = processedValues;
            } else {
              // Regular array
              data[fieldName] = values.filter(val => val && val !== '' && val !== null && val !== undefined);
            }
            
            console.log(`🔍 Processed multiselect data:`, data[fieldName]);
            // Remove the original array field
            delete data[`${fieldName}[]`];
          } else if (req.body[fieldName]) {
            // Handle case where field is sent without [] suffix
            console.log(`🔍 Processing multiselect field: ${fieldName} (direct field)`);
            let values = req.body[fieldName];
            
            // Handle string input
            if (typeof values === 'string') {
              values = values.trim();
              // Try to parse if it looks like JSON
              if ((values.startsWith('[') || values.startsWith('{')) && values.length > 1) {
                try {
                  // Replace single quotes with double quotes for JSON parsing
                  let jsonString = values.replace(/'/g, '"');
                  values = JSON.parse(jsonString);
                  console.log(`✅ Parsed JSON from ${fieldName}:`, values);
                } catch (e) {
                  console.log(`⚠️ Failed to parse JSON from ${fieldName}:`, e.message);
                  values = [values];
                }
              } else {
                values = [values];
              }
            }
            
            // Ensure it's an array
            if (!Array.isArray(values)) {
              values = [values];
            }
            
            // Extract values from objects if array contains objects
            // e.g., [ { '0': 'id' } ] -> [ 'id' ]
            const extractedValues = [];
            values.forEach((val, idx) => {
              if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof mongoose.Types.ObjectId)) {
                // Extract value from object like { '0': 'id' } or { 'category_id': 'id' }
                const objValue = Object.values(val)[0];
                if (objValue) {
                  extractedValues.push(objValue);
                  console.log(`✅ Extracted from object at index ${idx}:`, objValue);
                }
              } else {
                extractedValues.push(val);
              }
            });
            values = extractedValues;
            
            const schemaPath = Model.schema.paths[fieldName];
            // Check if this is an array of ObjectIds
            // For type: [mongoose.Schema.Types.ObjectId], check if it's an Array and the caster is ObjectId
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              // It's an array of ObjectIds - process each value
              const processedValues = [];
              
              values.forEach((val, idx) => {
                console.log(`🔍 Processing value ${idx}:`, val, `(type: ${typeof val})`);
                
                if (!val || val === '' || val === null || val === undefined) {
                  console.log(`⏭️ Skipping empty value at index ${idx}`);
                  return; // Skip empty values
                }
                
                // If it's already an ObjectId, use it
                if (val instanceof mongoose.Types.ObjectId) {
                  console.log(`✅ Value ${idx} is already ObjectId:`, val);
                  processedValues.push(val);
                  return;
                }
                
                // If it's a string that looks like an ObjectId, convert it
                if (typeof val === 'string') {
                  const trimmedVal = val.trim();
                  if (mongoose.Types.ObjectId.isValid(trimmedVal)) {
                    console.log(`✅ Converting string to ObjectId at index ${idx}:`, trimmedVal);
                    processedValues.push(new mongoose.Types.ObjectId(trimmedVal));
                    return;
                  }
                }
                
                // If it's an object, extract the value
                if (typeof val === 'object' && val !== null) {
                  console.log(`🔍 Value ${idx} is object, extracting values:`, val);
                  
                  // Handle objects like { '0': 'id' } or { 'id': 'value' }
                  const objValues = Object.values(val);
                  console.log(`🔍 Object values:`, objValues);
                  
                  for (const objValue of objValues) {
                    if (!objValue) continue;
                    
                    // If the object value is a string ObjectId
                    if (typeof objValue === 'string') {
                      const trimmedObjVal = objValue.trim();
                      if (mongoose.Types.ObjectId.isValid(trimmedObjVal)) {
                        console.log(`✅ Extracted ObjectId from object at index ${idx}:`, trimmedObjVal);
                        processedValues.push(new mongoose.Types.ObjectId(trimmedObjVal));
                        return;
                      }
                    }
                    
                    // If the object value is itself an ObjectId
                    if (objValue instanceof mongoose.Types.ObjectId) {
                      console.log(`✅ Extracted ObjectId from object at index ${idx}:`, objValue);
                      processedValues.push(objValue);
                      return;
                    }
                    
                    // Handle nested objects
                    if (typeof objValue === 'object' && objValue !== null) {
                      const nestedValues = Object.values(objValue);
                      for (const nestedValue of nestedValues) {
                        if (typeof nestedValue === 'string' && mongoose.Types.ObjectId.isValid(nestedValue.trim())) {
                          console.log(`✅ Extracted ObjectId from nested object at index ${idx}:`, nestedValue);
                          processedValues.push(new mongoose.Types.ObjectId(nestedValue.trim()));
                          return;
                        }
                      }
                    }
                  }
                }
                
                // Last resort: try to convert if it's valid
                if (typeof val === 'string' || typeof val === 'number') {
                  const strVal = String(val).trim();
                  if (mongoose.Types.ObjectId.isValid(strVal)) {
                    console.log(`✅ Last resort conversion at index ${idx}:`, strVal);
                    processedValues.push(new mongoose.Types.ObjectId(strVal));
                  } else {
                    console.log(`⚠️ Could not convert value at index ${idx} to ObjectId:`, val);
                  }
                } else {
                  console.log(`⚠️ Unhandled value type at index ${idx}:`, typeof val, val);
                }
              });
              
              console.log(`✅ Final processed values for ${fieldName}:`, processedValues);
              data[fieldName] = processedValues;
            }
          }
        }
      });
      
      // Don't handle file uploads here - we'll do it after creating the record to get the ID
      // Store file references for later processing
      const filesToUpload = {};
      if (req.files) {
        Object.keys(fieldConfig).forEach(fieldName => {
          const field = fieldConfig[fieldName];
          if (field.type === 'file' && req.files[fieldName]) {
            filesToUpload[fieldName] = req.files[fieldName];
            // Don't set data[fieldName] yet - we'll do it after record creation
          }
        });
      }
      
      if (fieldProcessing.beforeInsert) {
        data = await fieldProcessing.beforeInsert(data, req);
      }

      // Automatically set created_by if field exists and user is authenticated
      if (req.user && req.user._id && Model.schema.paths.created_by) {
        data.created_by = req.user._id;
      }

      // Automatically set company_id if field exists and user has company_id
      if (req.user && req.user.company_id && Model.schema.paths.company_id) {
        data.company_id = req.user.company_id;
      }

      // Automatically generate EAN13 barcode if barcode field is empty and exists in schema
      if (Model.schema.paths.barcode && (!data.barcode || data.barcode.trim() === "")) {
        const { generateProductBarcode } = require('./barcodeGenerator');
        data.barcode = generateProductBarcode();
        console.log("🏷️ Generated new EAN13 barcode for admin form:", data.barcode);
      }

      // Final cleanup: Ensure multiselect fields are arrays and clean up any incorrectly formatted entries
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect') {
          // Check if the field exists but is not an array (might be an object with numeric keys)
          if (data[fieldName] && typeof data[fieldName] === 'object' && !Array.isArray(data[fieldName])) {
            console.log(`⚠️ Found incorrectly formatted ${fieldName} before save:`, data[fieldName]);
            // Try to extract values from object like { 0: "value", 1: "value" }
            const extractedValues = Object.values(data[fieldName]).filter(v => v && v !== '');
            if (extractedValues.length > 0) {
              const schemaPath = Model.schema.paths[fieldName];
              const isObjectIdArray = schemaPath && 
                schemaPath.instance === 'Array' && 
                (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
              
              if (isObjectIdArray) {
                data[fieldName] = extractedValues
                  .filter(val => mongoose.Types.ObjectId.isValid(val))
                  .map(val => new mongoose.Types.ObjectId(val));
              } else {
                data[fieldName] = extractedValues;
              }
              console.log(`✅ Cleaned up ${fieldName}:`, data[fieldName]);
            } else {
              delete data[fieldName];
            }
          }
        }
      });
      
      console.log(`📝 Final data.category_id before save:`, data.category_id);
      
      // Create record first to get the ID
      const record = new Model(data);
      
      // Apply custom hooks
      if (hooks.beforeSave) {
        await hooks.beforeSave(record, req);
      }

      const savedRecord = await record.save();

      // Now handle file uploads with the record ID (using same structure as API: uploads/singularName/recordId/)
      if (Object.keys(filesToUpload).length > 0) {
        const recordId = savedRecord._id.toString();
        const fs = require('fs');
        
        // Process all file uploads
        for (const fieldName of Object.keys(filesToUpload)) {
          const file = filesToUpload[fieldName];
          const field = fieldConfig[fieldName];
          
          // Create upload directory: uploads/{singularName}/{recordId}/ (e.g., uploads/product/recordId/)
          const uploadDir = path.join(__dirname, '..', 'uploads', singularName, recordId);
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          
          // Support multiple files if input is multiple
          const filesArray = Array.isArray(file) ? file : [file];
          const storedPaths = [];
          
          // Upload files one by one (await each upload)
          for (let index = 0; index < filesArray.length; index++) {
            const f = filesArray[index];
            const timestamp = Date.now();
            const fileExtension = path.extname(f.name) || `.${f.mimetype.split('/')[1]}`;
            const fileName = `${fieldName}_${timestamp}_${index}${fileExtension}`;
            const filePath = path.join(uploadDir, fileName);
            
            try {
              // Use promise-based file move
              await new Promise((resolve, reject) => {
                f.mv(filePath, (err) => {
                  if (err) {
                    console.error(`Error uploading file ${fileName}:`, err);
                    reject(err);
                  } else {
                    resolve();
                  }
                });
              });
              
              // Store relative path: uploads/singularName/recordId/filename (e.g., uploads/product/recordId/filename)
              const relativePath = `uploads/${singularName}/${recordId}/${fileName}`;
              storedPaths.push(relativePath);
              console.log(`✅ File uploaded: ${relativePath}`);
            } catch (error) {
              console.error(`❌ Error uploading file ${fileName}:`, error);
            }
          }
          
          // If schema expects array store array else single string
          const expectsArray = Array.isArray(Model.schema.obj[fieldName]?.type) || Model.schema.paths[fieldName]?.instance === 'Array';
          savedRecord[fieldName] = expectsArray ? storedPaths : storedPaths[0];
        }
        
        // Save the record again with image paths
        await savedRecord.save();
        console.log(`✅ All files uploaded to: uploads/${singularName}/${recordId}/`);
      }

      // Apply custom hooks
      if (hooks.afterInsert) {
        await hooks.afterInsert(savedRecord, req);
      }

      // Format response
      let responseData = savedRecord.toObject();
      if (responseFormatting.insert) {
        responseData = await responseFormatting.insert(responseData, req);
      }

      // Remove excluded fields
      excludedFields.forEach(field => delete responseData[field]);

      // Redirect to list view with success message
      req.flash('success', `${titleCase} created successfully`);
      res.redirect(`/admin/${modelName}`);

    } catch (error) {
      const errorResponse = await handleError(error, 'insert', req);
      
      if (error.name === 'ValidationError') {
        // Re-render form with validation errors
        const errors = Object.values(error.errors).map(err => ({
          field: err.path,
          message: err.message,
          value: err.value
        }));

        return res.render('admin/create', {
          title: `Create ${titleCase}`,
          modelName,
          singularName,
          titleCase,
          fieldConfig,
          record: req.body,
          action: `/admin/${modelName}`,
          method: 'POST',
          errors,
          cssClasses,
          customJS,
          routes: req.routes || [], // Add routes data for dynamic menu
          baseUrl: getBaseUrl(),
          warehouses: req.warehouses || [] // Pass warehouses even on validation errors
        });
      }

      res.status(errorResponse.statusCode).render('admin/error', {
        title: 'Error',
        message: 'An error occurred while creating the record',
        error: errorResponse,
        baseUrl: getBaseUrl()
      });
    }
  }

  /**
   * EDIT FORM - Display form for editing existing record
   */
  async function editForm(req, res) {
    try {
      console.log(`🚀 editForm called for model: ${modelName}`);
      console.log(`🚀 editForm URL: ${req.url}`);
      console.log(`🚀 editForm middleware.beforeEditForm exists:`, !!middleware.beforeEditForm);
      
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).render('admin/error', {
          title: 'Error',
          message: 'Invalid ID format',
          error: { statusCode: 400, message: 'Invalid ID format' },
          baseUrl: getBaseUrl()
        });
      }

      // Build query
      let query = { _id: id };
      if (softDelete) {
        // Fix: Use $or to handle both cases - fields that don't exist and fields with null default
        query.$or = [
          { deletedAt: { $exists: false } },  // For models without the field
          { deletedAt: null }                  // For models with default null
        ];
      }

      // Set fieldConfig on req before middleware runs
      req.fieldConfig = fieldConfig;
      console.log(`🚀 editForm - fieldConfig keys:`, Object.keys(fieldConfig));
      
      // Apply custom middleware
      if (middleware.beforeEditForm) {
        console.log(`🚀 editForm - calling beforeEditForm middleware...`);
        await middleware.beforeEditForm(req, res);
        console.log(`✅ editForm - beforeEditForm middleware completed`);
      } else {
        console.log(`⚠️ editForm - no beforeEditForm middleware defined`);
      }

      const record = await Model.findOne(query)
        .select(includedFields.length > 0 ? includedFields.join(' ') : `-${excludedFields.join(' -')}`);

      if (!record) {
        return res.status(404).render('admin/error', {
          title: 'Error',
          message: `${titleCase} not found`,
          error: { statusCode: 404, message: `${titleCase} not found` }
        });
      }

      // Apply custom middleware
      if (middleware.afterGetById) {
        await middleware.afterGetById(record, req);
      }

      // Apply afterQuery middleware to populate field options (like user dropdown)
      // BUT preserve options that were set in beforeEditForm
      if (middleware.afterQuery) {
        console.log(`🚀 editForm - calling afterQuery middleware...`);
        const existingOptions = req.fieldConfig?.warehouse_id?.options || [];
        await middleware.afterQuery([record], req);
        // Restore options if afterQuery overwrote them
        if (req.fieldConfig?.warehouse_id && existingOptions.length > 0 && (!req.fieldConfig.warehouse_id.options || req.fieldConfig.warehouse_id.options.length === 0)) {
          req.fieldConfig.warehouse_id.options = existingOptions;
          console.log(`✅ editForm - restored warehouse_id options after afterQuery`);
        }
        console.log(`✅ editForm - afterQuery middleware completed`);
      }

      // Use the modified fieldConfig from req if available, otherwise use the original
      const finalFieldConfig = req.fieldConfig || fieldConfig;
      
      // Debug: Check fieldConfig state
      console.log(`🔍 adminCrudGenerator [${modelName}] editForm - finalFieldConfig keys:`, Object.keys(finalFieldConfig));
      if (finalFieldConfig.warehouse_id) {
        console.log(`🔍 adminCrudGenerator [${modelName}] editForm - warehouse_id exists in finalFieldConfig`);
        console.log(`🔍 adminCrudGenerator [${modelName}] editForm - warehouse_id options:`, finalFieldConfig.warehouse_id.options?.length || 0);
      } else {
        console.log(`⚠️ adminCrudGenerator [${modelName}] editForm - warehouse_id NOT in finalFieldConfig`);
      }

      // Format response
      let responseData = record.toObject();
      if (responseFormatting.editForm) {
        responseData = await responseFormatting.editForm(responseData, req);
      }

      res.render('admin/edit', {
        title: `Edit ${titleCase}`,
        modelName,
        singularName,
        titleCase,
        fieldConfig: finalFieldConfig,
        record: responseData,
        action: `/admin/${modelName}/${id}`,
        method: 'PUT',
        errors: [],
        cssClasses,
        customJS,
        routes: req.routes || [], // Add routes data for dynamic menu
        baseUrl: getBaseUrl(),
        warehouses: req.warehouses || [] // Pass warehouses from middleware
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'editForm', req);
      res.status(errorResponse.statusCode).render('admin/error', {
        title: 'Error',
        message: 'An error occurred while loading the form',
        error: errorResponse,
        baseUrl: getBaseUrl()
      });
    }
  }

  /**
   * UPDATE - Update record by ID
   */
  async function update(req, res) {
    console.log(`🔄 UPDATE function called for ${modelName}:`, {
      method: req.method,
      url: req.url,
      params: req.params,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod
    });
    
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).render('admin/error', {
          title: 'Error',
          message: 'Invalid ID format',
          error: { statusCode: 400, message: 'Invalid ID format' },
          baseUrl: getBaseUrl()
        });
      }

      // Apply custom validation
      if (validation.update) {
        const validationResult = await validation.update(req.body);
        if (!validationResult.isValid) {
          return res.status(400).render('admin/edit', {
            title: `Edit ${titleCase}`,
            modelName,
            singularName,
            titleCase,
            fieldConfig,
            record: { ...req.body, _id: id },
            action: `/admin/${modelName}/${id}`,
            method: 'PUT',
            errors: validationResult.errors,
            cssClasses,
            customJS,
            routes: req.routes || [],
            baseUrl: getBaseUrl(),
            warehouses: req.warehouses || [] // Pass warehouses even on validation errors
          });
        }
      }

      // Apply custom middleware
      if (middleware.beforeUpdate) {
        await middleware.beforeUpdate(req, res);
      }

      // Build query
      let query = { _id: id };
      if (softDelete) {
        query.$or = [
          { deletedAt: { $exists: false } },  // For models without the field
          { deletedAt: null }                  // For models with default null
        ];
      }

      const record = await Model.findOne(query);
      if (!record) {
        return res.status(404).render('admin/error', {
          title: 'Error',
          message: `${titleCase} not found`,
          error: { statusCode: 404, message: `${titleCase} not found` }
        });
      }

      // Process fields
      let updateData = { ...req.body };
      
      // Handle array fields (multiselect fields with [] in name or indexed format like category_id[0])
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect') {
          // FIRST: Check if the field already exists in req.body (might be parsed from indexed format)
          // This handles cases where express-fileupload/body-parser already parsed category_id[0] into category_id
          if (req.body[fieldName] && (Array.isArray(req.body[fieldName]) || typeof req.body[fieldName] === 'object')) {
            console.log(`🔍 Found ${fieldName} directly in req.body (UPDATE - likely parsed from indexed format):`, req.body[fieldName]);
            let values = req.body[fieldName];
            
            // Extract values from objects if array contains objects
            // e.g., [ { '0': 'id' } ] -> [ 'id' ]
            const extractedValues = [];
            if (Array.isArray(values)) {
              values.forEach((val, idx) => {
                if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof mongoose.Types.ObjectId)) {
                  // Extract value from object like { '0': 'id' } or { 'category_id': 'id' }
                  const objValue = Object.values(val)[0];
                  if (objValue) {
                    extractedValues.push(objValue);
                    console.log(`✅ Extracted from object at index ${idx} (UPDATE):`, objValue);
                  }
                } else {
                  extractedValues.push(val);
                }
              });
            } else if (typeof values === 'object' && values !== null) {
              // Handle object with numeric keys like { '0': 'id', '1': 'id2' }
              const sortedKeys = Object.keys(values).sort((a, b) => parseInt(a) - parseInt(b));
              sortedKeys.forEach(key => {
                extractedValues.push(values[key]);
              });
            }
            
            values = extractedValues.length > 0 ? extractedValues : (Array.isArray(values) ? values : [values]);
            
            // Process as ObjectId array
            const schemaPath = Model.schema.paths[fieldName];
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              const processedValues = [];
              values.forEach((val, idx) => {
                if (!val || val === '' || val === null || val === undefined) return;
                
                if (val instanceof mongoose.Types.ObjectId) {
                  processedValues.push(val);
                } else if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val.trim())) {
                  processedValues.push(new mongoose.Types.ObjectId(val.trim()));
                }
              });
              updateData[fieldName] = processedValues;
              console.log(`✅ Processed direct field ${fieldName} (UPDATE - from parsed format):`, updateData[fieldName]);
              
              // Remove from req.body to prevent re-processing
              delete req.body[fieldName];
              return; // Skip other checks
            }
          }
          
          // SECOND: Check for indexed array format (category_id[0], category_id[1], etc.)
          const indexedPattern = new RegExp(`^${fieldName}\\[\\d+\\]$`);
          const indexedValues = [];
          Object.keys(req.body).forEach(key => {
            if (indexedPattern.test(key)) {
              const index = parseInt(key.match(/\[(\d+)\]/)[1]);
              let value = req.body[key];
              
              // Handle stringified values
              if (typeof value === 'string') {
                value = value.trim();
                console.log(`🔍 Processing indexed field (UPDATE) ${key}:`, value, `(type: ${typeof value})`);
                
                // Try to parse if it looks like JSON
                if ((value.startsWith('[') || value.startsWith('{')) && value.length > 1) {
                  try {
                    // Replace single quotes with double quotes for JSON parsing
                    let jsonString = value.replace(/'/g, '"');
                    const parsed = JSON.parse(jsonString);
                    console.log(`✅ Parsed JSON from ${key}:`, parsed);
                    
                    // If parsed is an array, extract values
                    if (Array.isArray(parsed)) {
                      parsed.forEach((item, i) => {
                        if (typeof item === 'object' && item !== null) {
                          // Extract value from object like { '0': 'id' } or { 'category_id': 'id' }
                          const objValue = Object.values(item)[0];
                          if (objValue) {
                            indexedValues[index + i] = objValue;
                            console.log(`✅ Extracted from array item ${i}:`, objValue);
                          }
                        } else {
                          indexedValues[index + i] = item;
                          console.log(`✅ Using array item ${i} directly:`, item);
                        }
                      });
                      // Skip adding the original value since we processed the array
                      return;
                    }
                    // If parsed is an object, extract the value
                    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                      const objValue = Object.values(parsed)[0];
                      if (objValue) {
                        value = objValue;
                        console.log(`✅ Extracted from object:`, value);
                      }
                    }
                  } catch (e) {
                    console.log(`⚠️ Failed to parse JSON from ${key}:`, e.message);
                    // If it's a valid ObjectId string, use it directly
                    if (mongoose.Types.ObjectId.isValid(value)) {
                      indexedValues[index] = value;
                      return;
                    }
                    // Not valid JSON, use as is
                  }
                } else if (mongoose.Types.ObjectId.isValid(value)) {
                  // Direct ObjectId string
                  indexedValues[index] = value;
                  return;
                }
              }
              
              indexedValues[index] = value;
            }
          });
          
          // Check for indexed format first
          if (indexedValues.length > 0) {
            console.log(`🔍 Processing multiselect field (UPDATE): ${fieldName} (indexed format)`);
            console.log(`🔍 Found indexed values:`, indexedValues);
            
            // Use indexed values
            let values = indexedValues.filter(v => v !== undefined && v !== null);
            
            // Process the values
            const schemaPath = Model.schema.paths[fieldName];
            const isObjectIdArray = schemaPath && 
              schemaPath.instance === 'Array' && 
              (schemaPath.caster && schemaPath.caster.instance === 'ObjectID');
            
            if (isObjectIdArray) {
              const processedValues = [];
              values.forEach((val, idx) => {
                if (!val || val === '' || val === null || val === undefined) return;
                
                if (val instanceof mongoose.Types.ObjectId) {
                  processedValues.push(val);
                } else if (typeof val === 'string' && mongoose.Types.ObjectId.isValid(val.trim())) {
                  processedValues.push(new mongoose.Types.ObjectId(val.trim()));
                }
              });
              updateData[fieldName] = processedValues;
              console.log(`✅ Processed indexed multiselect data (UPDATE):`, updateData[fieldName]);
            } else {
              updateData[fieldName] = values.filter(val => val && val !== '' && val !== null && val !== undefined);
            }
            
            // Remove indexed fields from updateData
            Object.keys(updateData).forEach(key => {
              if (indexedPattern.test(key)) {
                delete updateData[key];
              }
            });
          } else if (req.body[`${fieldName}[]`]) {
            console.log(`🔍 Processing multiselect field (UPDATE): ${fieldName}[]`);
            console.log(`🔍 Raw form data:`, req.body[`${fieldName}[]`]);
            // Convert array field to proper format
            updateData[fieldName] = Array.isArray(req.body[`${fieldName}[]`]) 
              ? req.body[`${fieldName}[]`] 
              : [req.body[`${fieldName}[]`]];
            console.log(`🔍 Processed data:`, updateData[fieldName]);
            // Remove the original array field
            delete updateData[`${fieldName}[]`];
          }
        }
      });
      
      // Handle image removal for file fields
      console.log('🔍 Full request body keys:', Object.keys(req.body));
      console.log('🔍 Checking for removed images in request body:', Object.keys(req.body).filter(key => key.startsWith('removed_images_')));
      
      // Log all removed_images data
      Object.keys(req.body).forEach(key => {
        if (key.startsWith('removed_images_')) {
          console.log('🔍 Found removal data:', key, '=', req.body[key]);
          console.log('🔍 Removal data type:', typeof req.body[key], 'Array?', Array.isArray(req.body[key]));
        }
      });
      
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        const expectsArray = Array.isArray(Model.schema.obj[fieldName]?.type) || Model.schema.paths[fieldName]?.instance === 'Array';
        
        if (field.type === 'file' && req.body[`removed_images_${fieldName}[]`]) {
          console.log(`🔍 Processing removal for field: ${fieldName}, expectsArray: ${expectsArray}`);
          
          const removedImages = Array.isArray(req.body[`removed_images_${fieldName}[]`]) 
            ? req.body[`removed_images_${fieldName}[]`] 
            : [req.body[`removed_images_${fieldName}[]`]];
          
          console.log(`🔍 Removed images:`, removedImages);
          
          if (expectsArray) {
            // For array fields, filter out removed images
            const existingImages = record[fieldName] || [];
            const existingArray = Array.isArray(existingImages) ? existingImages : [existingImages].filter(img => img);
            
            console.log(`🔍 Existing images:`, existingArray);
            
            // Filter out removed images
            const filteredImages = existingArray.filter(img => !removedImages.includes(img));
            updateData[fieldName] = filteredImages;
            
            console.log(`🗑️ Removed ${removedImages.length} images from array field ${fieldName}, ${filteredImages.length} images remaining`);
          } else {
            // For single image fields, clear the field if the image is removed
            const currentImage = record[fieldName];
            console.log(`🔍 Current single image:`, currentImage);
            
            if (removedImages.includes(currentImage)) {
              updateData[fieldName] = '';
              console.log(`🗑️ Removed single image from field ${fieldName}`);
            }
          }
          
          // Remove the removal tracking field from updateData
          delete updateData[`removed_images_${fieldName}[]`];
        }
      });
      
      // Handle file uploads for file fields (using same structure as API: uploads/singularName/recordId/)
      if (req.files) {
        const recordId = record._id.toString();
        Object.keys(fieldConfig).forEach(fieldName => {
          const field = fieldConfig[fieldName];
          if (field.type === 'file' && req.files[fieldName]) {
            const file = req.files[fieldName];
            
            // Create upload directory: uploads/{singularName}/{recordId}/ (e.g., uploads/product/recordId/)
            const uploadDir = path.join(__dirname, '..', 'uploads', singularName, recordId);
            if (!require('fs').existsSync(uploadDir)) {
              require('fs').mkdirSync(uploadDir, { recursive: true });
            }
            
            // Support multiple files if input is multiple
            const filesArray = Array.isArray(file) ? file : [file];
            const storedPaths = [];
            filesArray.forEach((f, index) => {
              const timestamp = Date.now();
              const fileExtension = path.extname(f.name) || `.${f.mimetype.split('/')[1]}`;
              const fileName = `${fieldName}_${timestamp}_${index}${fileExtension}`;
              const filePath = path.join(uploadDir, fileName);
              
              f.mv(filePath, (err) => {
                if (err) {
                  console.error('File upload error:', err);
                }
              });
              // Store relative path: uploads/singularName/recordId/filename (e.g., uploads/product/recordId/filename)
              const relativePath = `uploads/${singularName}/${recordId}/${fileName}`;
              storedPaths.push(relativePath);
            });
            const expectsArray = Array.isArray(Model.schema.obj[fieldName]?.type) || Model.schema.paths[fieldName]?.instance === 'Array';
            
            if (expectsArray) {
              // For array fields, append new images to existing ones (or already filtered ones)
              let existingImages;
              if (updateData[fieldName] !== undefined) {
                // Use already filtered images if removal was processed
                existingImages = Array.isArray(updateData[fieldName]) ? updateData[fieldName] : [updateData[fieldName]].filter(img => img);
              } else {
                // Use original images from record
                const recordImages = record[fieldName] || [];
                existingImages = Array.isArray(recordImages) ? recordImages : [recordImages].filter(img => img);
              }
              
              updateData[fieldName] = [...existingImages, ...storedPaths];
              console.log(`📷 Appending ${storedPaths.length} new images to existing ${existingImages.length} images for field ${fieldName}`);
            } else {
              // For single image fields, replace the existing image
              updateData[fieldName] = storedPaths[0];
            }
          }
        });
      }
      
      if (fieldProcessing.beforeUpdate) {
        updateData = await fieldProcessing.beforeUpdate(updateData, req, record);
      }

      // Automatically set updated_by if field exists and user is authenticated
      if (req.user && req.user._id && Model.schema.paths.updated_by) {
        updateData.updated_by = req.user._id;
      }

      // Automatically set company_id if field exists and user has company_id
      if (req.user && req.user.company_id && Model.schema.paths.company_id) {
        updateData.company_id = req.user.company_id;
      }

      // Apply custom hooks
      if (hooks.beforeUpdate) {
        await hooks.beforeUpdate(record, updateData, req);
      }

      // Debug logging
      console.log('🔄 Final updateData before saving:', updateData);
      console.log('🔄 Original record images:', {
        multi_images: record.multi_images,
        product_image: record.product_image
      });

      // Update record
      Object.assign(record, updateData);
      const updatedRecord = await record.save();
      
      console.log('✅ Updated record images:', {
        multi_images: updatedRecord.multi_images,
        product_image: updatedRecord.product_image
      });

      // Apply custom hooks
      if (hooks.afterUpdate) {
        await hooks.afterUpdate(updatedRecord, req);
      }

      // Format response
      let responseData = updatedRecord.toObject();
      if (responseFormatting.update) {
        responseData = await responseFormatting.update(responseData, req);
      }

      // Remove excluded fields
      excludedFields.forEach(field => delete responseData[field]);

      // Redirect to list view with success message
      req.flash('success', `${titleCase} updated successfully`);
      res.redirect(`/admin/${modelName}`);

    } catch (error) {
      const errorResponse = await handleError(error, 'update', req);
      
      if (error.name === 'ValidationError') {
        // Re-render form with validation errors
        const errors = Object.values(error.errors).map(err => ({
          field: err.path,
          message: err.message,
          value: err.value
        }));

        return res.render('admin/edit', {
          title: `Edit ${titleCase}`,
          modelName,
          singularName,
          titleCase,
          fieldConfig,
          record: { ...req.body, _id: req.params.id },
          action: `/admin/${modelName}/${req.params.id}`,
          method: 'PUT',
          errors,
          cssClasses,
          customJS,
          routes: req.routes || [], // Add routes data for dynamic menu
          baseUrl: getBaseUrl(),
          warehouses: req.warehouses || [] // Pass warehouses even on validation errors
        });
      }

      res.status(errorResponse.statusCode).render('admin/error', {
        title: 'Error',
        message: 'An error occurred while updating the record',
        error: errorResponse,
        baseUrl: getBaseUrl()
      });
    }
  }

  /**
   * DELETE - Delete record by ID
   */
  async function deleteRecord(req, res) {
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${singularName} ID format`
        });
      }

      // Apply custom middleware
      if (middleware.beforeDelete) {
        await middleware.beforeDelete(req, res);
      }

      // Build query
      let query = { _id: id };
      if (softDelete) {
        query.$or = [
          { deletedAt: { $exists: false } },  // For models without the field
          { deletedAt: null }                  // For models with default null
        ];
      }

      const record = await Model.findOne(query);
      if (!record) {
        return res.status(404).json({
          success: false,
          message: `${titleCase} not found`
        });
      }

      // Apply custom hooks
      if (hooks.beforeDelete) {
        await hooks.beforeDelete(record, req);
      }

      let deleteResult;
      if (softDelete) {
        // Soft delete
        deleteResult = await Model.findByIdAndUpdate(id, { deletedAt: new Date() }, { new: true });
      } else {
        // Hard delete
        deleteResult = await Model.findByIdAndDelete(id);
      }

      // Apply custom hooks
      if (hooks.afterDelete) {
        await hooks.afterDelete(deleteResult, req);
      }

      res.status(200).json({
        success: true,
        message: `${titleCase} deleted successfully`,
        data: {
          id: deleteResult._id,
          deletedAt: softDelete ? deleteResult.deletedAt : undefined
        }
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'delete', req);
      res.status(errorResponse.statusCode).json(errorResponse);
    }
  }

  /**
   * RESTORE - Restore soft-deleted record by ID
   */
  async function restoreRecord(req, res) {
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${singularName} ID format`
        });
      }

      if (!softDelete) {
        return res.status(400).json({
          success: false,
          message: 'Restore functionality is only available when soft delete is enabled'
        });
      }

      // Find the deleted record
      const record = await Model.findOne({ 
        _id: id, 
        deletedAt: { $exists: true, $ne: null } 
      });
      
      if (!record) {
        return res.status(404).json({
          success: false,
          message: `${titleCase} not found or not deleted`
        });
      }

      // Apply custom hooks
      if (hooks.beforeRestore) {
        await hooks.beforeRestore(record, req);
      }

      // Restore the record
      const restoreResult = await Model.findByIdAndUpdate(
        id, 
        { $unset: { deletedAt: 1 } }, 
        { new: true }
      );

      // Apply custom hooks
      if (hooks.afterRestore) {
        await hooks.afterRestore(restoreResult, req);
      }

      res.status(200).json({
        success: true,
        message: `${titleCase} restored successfully`,
        data: {
          id: restoreResult._id,
          restoredAt: new Date()
        }
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'restore', req);
      res.status(errorResponse.statusCode).json(errorResponse);
    }
  }

  /**
   * PERMANENT DELETE - Permanently delete record by ID
   */
  async function permanentDeleteRecord(req, res) {
    try {
      const { id } = req.params;

      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${singularName} ID format`
        });
      }

      if (!softDelete) {
        return res.status(400).json({
          success: false,
          message: 'Permanent delete functionality is only available when soft delete is enabled'
        });
      }

      // Find the deleted record
      const record = await Model.findOne({ 
        _id: id, 
        deletedAt: { $exists: true, $ne: null } 
      });
      
      if (!record) {
        return res.status(404).json({
          success: false,
          message: `${titleCase} not found or not deleted`
        });
      }

      // Apply custom hooks
      if (hooks.beforePermanentDelete) {
        await hooks.beforePermanentDelete(record, req);
      }

      // Permanently delete the record
      const deleteResult = await Model.findByIdAndDelete(id);

      // Apply custom hooks
      if (hooks.afterPermanentDelete) {
        await hooks.afterPermanentDelete(deleteResult, req);
      }

      res.status(200).json({
        success: true,
        message: `${titleCase} permanently deleted successfully`,
        data: {
          id: deleteResult._id,
          permanentlyDeletedAt: new Date()
        }
      });

    } catch (error) {
      const errorResponse = await handleError(error, 'permanentDelete', req);
      res.status(errorResponse.statusCode).json(errorResponse);
    }
  }

  /**
   * Generate field configuration for forms
   */
  function generateFieldConfig(Model, fields, fieldTypes, fieldLabels, fieldValidation, fieldOptions) {
    const config = {};
    
    fields.forEach(fieldName => {
      const schemaPath = Model.schema.paths[fieldName];
      if (!schemaPath) return;

      const field = {
        name: fieldName,
        type: fieldTypes[fieldName] || inferFieldType(schemaPath),
        label: fieldLabels[fieldName] || getFieldLabel(schemaPath, fieldName),
        required: schemaPath.isRequired || false,
        validation: fieldValidation[fieldName] || generateFieldValidation(schemaPath),
        options: fieldOptions[fieldName] || generateFieldOptions(schemaPath),
        placeholder: generateFieldPlaceholder(fieldName),
        helpText: generateFieldHelpText(fieldName, schemaPath),
        defaultValue: (() => {
          // Handle Mongoose default values properly
          if (schemaPath.defaultValue !== undefined) {
            if (typeof schemaPath.defaultValue === 'function') {
              return schemaPath.defaultValue();
            }
            return schemaPath.defaultValue;
          }
          if (schemaPath.default !== undefined) {
            if (typeof schemaPath.default === 'function') {
              return schemaPath.default();
            }
            return schemaPath.default;
          }
          return null;
        })()
      };

      config[fieldName] = field;
    });

    return config;
  }

  /**
   * Get base URL for assets
   */
  function getBaseUrl() {
    // Use the configured baseUrl from options
    return baseUrl;
  }

  /**
   * Clean up image path to avoid double /uploads/ prefixes
   */
  function cleanImagePath(imagePath) {
    if (!imagePath) return '';
    
    // Remove duplicate /uploads/uploads/ prefixes
    if (imagePath.startsWith('/uploads/uploads/')) {
      return imagePath.replace('/uploads/uploads/', '/uploads/');
    }
    
    return imagePath;
  }

  /**
   * Build full URL for assets
   */
  function buildAssetUrl(assetPath) {
    if (!assetPath) return '';
    
    // If it's already a full URL, return as is
    if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
      return assetPath;
    }
    
    // If it starts with /, it's a relative path from root
    if (assetPath.startsWith('/')) {
      return getBaseUrl() + assetPath;
    }
    
    // Otherwise, treat as relative path
    return getBaseUrl() + '/' + assetPath;
  }

  /**
   * Infer field type from schema
   */
  function inferFieldType(schemaPath) {
    // Check if field has field_type defined in schema options
    if (schemaPath.options && schemaPath.options.field_type) {
      return schemaPath.options.field_type;
    }
    
    if (schemaPath.instance === 'String') {
      if (schemaPath.enumValues && schemaPath.enumValues.length > 0) {
        return 'select';
      }
      if (schemaPath.path === 'email') {
        return 'email';
      }
      if (schemaPath.path === 'password') {
        return 'password';
      }
      if (schemaPath.path.includes('description') || schemaPath.path.includes('content')) {
        return 'textarea';
      }
      return 'text';
    }
    
    if (schemaPath.instance === 'Number') {
      return 'number';
    }
    
    if (schemaPath.instance === 'Boolean') {
      return 'checkbox';
    }
    
    if (schemaPath.instance === 'Date') {
      return 'date';
    }
    
    if (schemaPath.instance === 'Array') {
      // Check if it's an array of strings (could be images, tags, or multiselect)
      if (schemaPath.schema && schemaPath.schema.instance === 'String') {
        // Check if field name suggests it's for images
        if (schemaPath.path.includes('image') || schemaPath.path.includes('photo') || schemaPath.path.includes('picture')) {
          return 'file';
        }
        // Check if field has enumValues (for multiselect)
        if (schemaPath.enumValues && schemaPath.enumValues.length > 0) {
          return 'multiselect';
        }
        return 'tags';
      }
      return 'tags';
    }
    
    if (schemaPath.instance === 'ObjectID') {
      return 'select';
    }

    return 'text';
  }

  /**
   * Get field label - prioritize field_name from schema, fallback to generated label
   */
  function getFieldLabel(schemaPath, fieldName) {
    // Check if field_name is defined in the schema
    if (schemaPath.options && schemaPath.options.field_name) {
      return schemaPath.options.field_name;
    }
    
    // Fallback to generated label
    return generateFieldLabel(fieldName);
  }

  /**
   * Generate field label
   */
  function generateFieldLabel(fieldName) {
    return fieldName
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .replace(/_/g, ' ');
  }

  /**
   * Generate field validation
   */
  function generateFieldValidation(schemaPath) {
    const validation = {};
    
    if (schemaPath.validators) {
      schemaPath.validators.forEach(validator => {
        if (validator.type === 'minlength') {
          validation.minLength = validator.value;
        }
        if (validator.type === 'maxlength') {
          validation.maxLength = validator.value;
        }
        if (validator.type === 'min') {
          validation.min = validator.value;
        }
        if (validator.type === 'max') {
          validation.max = validator.value;
        }
        if (validator.type === 'regexp') {
          validation.pattern = validator.value;
        }
      });
    }

    return validation;
  }

  /**
   * Generate field options
   */
  function generateFieldOptions(schemaPath) {
    if (schemaPath.enumValues && schemaPath.enumValues.length > 0) {
      return schemaPath.enumValues.map(value => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1)
      }));
    }
    
    // For array fields with enum values (multiselect)
    if (schemaPath.instance === 'Array' && schemaPath.schema && schemaPath.schema.enumValues && schemaPath.schema.enumValues.length > 0) {
      return schemaPath.schema.enumValues.map(value => ({
        value,
        label: value.charAt(0).toUpperCase() + value.slice(1)
      }));
    }
    
    if (schemaPath.instance === 'ObjectID' && schemaPath.options.ref) {
      // For reference fields, you might want to populate options
      return [];
    }

    return [];
  }

  /**
   * Generate field placeholder
   */
  function generateFieldPlaceholder(fieldName) {
    return `Enter ${fieldName.replace(/_/g, ' ')}`;
  }

  /**
   * Generate field help text
   */
  function generateFieldHelpText(fieldName, schemaPath) {
    if (schemaPath.isRequired) {
      return 'This field is required';
    }
    return '';
  }

  /**
   * Error handler
   */
  async function handleError(error, operation, req) {
    console.error(`${titleCase} ${operation} error:`, error);

    // Apply custom error handling
    if (errorHandling[operation]) {
      return await errorHandling[operation](error, req);
    }

    // Default error handling
    let statusCode = 500;
    let message = 'Internal server error';
    let errors = null;

    if (error.name === 'ValidationError') {
      statusCode = 400;
      message = 'Validation Error';
      errors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message,
        value: err.value
      }));
    } else if (error.name === 'CastError') {
      statusCode = 400;
      message = 'Invalid ID format';
    } else if (error.code === 11000) {
      statusCode = 409;
      message = 'Duplicate entry found';
      const field = Object.keys(error.keyPattern)[0];
      errors = [{
        field,
        message: `${field} already exists`,
        value: error.keyValue[field]
      }];
    } else if (error.statusCode) {
      statusCode = error.statusCode;
      message = error.message;
    } else if (error.message) {
      message = error.message;
    }

    return {
      statusCode,
      success: false,
      message,
      ...(errors && { errors }),
      ...(process.env.NODE_ENV === 'development' && {
        stack: error.stack,
        details: error
      })
    };
  }

  /**
   * Generate admin routes
   */
  function generateAdminRoutes() {
    const express = require('express');
    const router = express.Router();

    // CRUD routes
    // console.log(`🔧 Registering routes for model: ${modelName}`);
    router.get('/', list);                           // LIST view
    router.get('/create', createForm);               // CREATE form
    router.post('/', insert);                        // INSERT action
    router.get('/:id/edit', editForm);               // EDIT form
    router.put('/:id', update);                     // UPDATE action
    router.post('/:id', update);                    // UPDATE action (fallback for method override issues)
    router.delete('/:id', deleteRecord);             // DELETE action
    
    // Soft delete routes (only if soft delete is enabled)
    if (softDelete) {
      router.post('/:id/restore', restoreRecord);    // RESTORE action
      router.delete('/:id/permanent-delete', permanentDeleteRecord); // PERMANENT DELETE action
      // console.log(`✅ Soft delete routes registered for ${modelName}: POST /:id/restore, DELETE /:id/permanent-delete`);
    }
    
    // console.log(`✅ Routes registered for ${modelName}: GET /, GET /create, POST /, GET /:id/edit, PUT /:id, POST /:id, DELETE /:id`);

    return router;
  }

  /**
   * Generate controller object
   */
  const controller = {
    list,
    createForm,
    insert,
    editForm,
    update,
    deleteRecord,
    // Soft delete functions (only if enabled)
    ...(softDelete ? {
      restoreRecord,
      permanentDeleteRecord
    } : {}),
    // Utility methods
    getModel: () => Model,
    getModelName: () => modelName,
    getSingularName: () => singularName,
    getTitleCase: () => titleCase,
    getFieldConfig: () => fieldConfig
  };

  /**
   * Generate routes
   */
  const routes = generateAdminRoutes();

  return {
    controller,
    routes,
    // Utility functions
    generateAdminRoutes,
    // Configuration
    config: {
      modelName,
      singularName,
      titleCase,
      fields,
      fieldConfig,
      options
    }
  };
}

module.exports = adminCrudGenerator;

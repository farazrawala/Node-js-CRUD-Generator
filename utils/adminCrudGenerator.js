const mongoose = require('mongoose');
const path = require('path');

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
      !['_id', '__v', 'createdAt', 'updatedAt'].includes(field)
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
        !['_id', '__v', 'createdAt', 'updatedAt', 'deletedAt'].includes(field)
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
          query.$or = [
            { deletedAt: { $exists: false } },
            { deletedAt: null }
          ];
        }
      }

      // Apply custom filters
      if (middleware.applyFilters) {
        query = await middleware.applyFilters(query, req);
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
      }

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
          sortable: sortableFields
        },
        cssClasses,
        customJS,
        baseUrl: getBaseUrl()
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
      // Apply custom middleware
      if (middleware.beforeCreateForm) {
        await middleware.beforeCreateForm(req, res);
      }

      // Apply afterQuery middleware to populate field options (like user dropdown)
      if (middleware.afterQuery) {
        // Pass fieldConfig to the middleware via req
        req.fieldConfig = fieldConfig;
        await middleware.afterQuery([], req);
      }

      // Use the modified fieldConfig from req if available, otherwise use the original
      const finalFieldConfig = req.fieldConfig || fieldConfig;

      res.render('admin/create', {
        title: `Create ${titleCase}`,
        modelName,
        singularName,
        titleCase,
        fieldConfig: finalFieldConfig,
        record: {},
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
      
      // Handle array fields (multiselect fields with [] in name)
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect' && req.body[`${fieldName}[]`]) {
          console.log(`🔍 Processing multiselect field: ${fieldName}[]`);
          console.log(`🔍 Raw form data:`, req.body[`${fieldName}[]`]);
          // Convert array field to proper format
          data[fieldName] = Array.isArray(req.body[`${fieldName}[]`]) 
            ? req.body[`${fieldName}[]`] 
            : [req.body[`${fieldName}[]`]];
          console.log(`🔍 Processed data:`, data[fieldName]);
          // Remove the original array field
          delete data[`${fieldName}[]`];
        }
      });
      
      // Handle file uploads for file fields
      if (req.files) {
        Object.keys(fieldConfig).forEach(fieldName => {
          const field = fieldConfig[fieldName];
          if (field.type === 'file' && req.files[fieldName]) {
            const file = req.files[fieldName];
            
            // Create upload directory if it doesn't exist
            const uploadDir = path.join(__dirname, '..', 'uploads', modelName);
            if (!require('fs').existsSync(uploadDir)) {
              require('fs').mkdirSync(uploadDir, { recursive: true });
            }
            
            // Support multiple files if input is multiple
            const filesArray = Array.isArray(file) ? file : [file];
            const storedPaths = [];
            filesArray.forEach((f) => {
              const timestamp = Date.now();
              const fileName = `${fieldName}_${timestamp}_${Math.random().toString(36).substring(2)}.${f.mimetype.split('/')[1]}`;
              const filePath = path.join(uploadDir, fileName);
              f.mv(filePath, (err) => {
                if (err) {
                  console.error('File upload error:', err);
                }
              });
              storedPaths.push(cleanImagePath(`/${modelName}/${fileName}`));
            });
            // If schema expects array store array else single string
            const expectsArray = Array.isArray(Model.schema.obj[fieldName]?.type) || Model.schema.paths[fieldName]?.instance === 'Array';
            data[fieldName] = expectsArray ? storedPaths : storedPaths[0];
          }
        });
      }
      
      if (fieldProcessing.beforeInsert) {
        data = await fieldProcessing.beforeInsert(data, req);
      }

      // Create record
      const record = new Model(data);
      
      // Apply custom hooks
      if (hooks.beforeSave) {
        await hooks.beforeSave(record, req);
      }

      const savedRecord = await record.save();

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

      // Apply custom middleware
      if (middleware.beforeEditForm) {
        await middleware.beforeEditForm(req, res);
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
      if (middleware.afterQuery) {
        // Pass fieldConfig to the middleware via req
        req.fieldConfig = fieldConfig;
        await middleware.afterQuery([record], req);
      }

      // Use the modified fieldConfig from req if available, otherwise use the original
      const finalFieldConfig = req.fieldConfig || fieldConfig;

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
      
      // Handle array fields (multiselect fields with [] in name)
      Object.keys(fieldConfig).forEach(fieldName => {
        const field = fieldConfig[fieldName];
        if (field.type === 'multiselect' && req.body[`${fieldName}[]`]) {
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
      
      // Handle file uploads for file fields
      if (req.files) {
        Object.keys(fieldConfig).forEach(fieldName => {
          const field = fieldConfig[fieldName];
          if (field.type === 'file' && req.files[fieldName]) {
            const file = req.files[fieldName];
            
            // Create upload directory if it doesn't exist
            const uploadDir = path.join(__dirname, '..', 'uploads', modelName);
            if (!require('fs').existsSync(uploadDir)) {
              require('fs').mkdirSync(uploadDir, { recursive: true });
            }
            
            // Support multiple files if input is multiple
            const filesArray = Array.isArray(file) ? file : [file];
            const storedPaths = [];
            filesArray.forEach((f) => {
              const timestamp = Date.now();
              const fileName = `${fieldName}_${timestamp}_${Math.random().toString(36).substring(2)}.${f.mimetype.split('/')[1]}`;
              const filePath = path.join(uploadDir, fileName);
              f.mv(filePath, (err) => {
                if (err) {
                  console.error('File upload error:', err);
                }
              });
              storedPaths.push(cleanImagePath(`/${modelName}/${fileName}`));
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
        helpText: generateFieldHelpText(fieldName, schemaPath)
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
    console.log(`🔧 Registering routes for model: ${modelName}`);
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
    
    console.log(`✅ Routes registered for ${modelName}: GET /, GET /create, POST /, GET /:id/edit, PUT /:id, POST /:id, DELETE /:id`);

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

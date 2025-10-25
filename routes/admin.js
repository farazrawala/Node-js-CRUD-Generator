const express = require("express");
const router = express.Router();
const { restrictTo } = require("../middlewares/auth");
const routeRegistry = require("../utils/routeRegistry");

// Base URL configuration for assets and links
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

// Import models
const User = require("../models/user");
const Product = require("../models/product");
const Blog = require("../models/blog");
const Order = require("../models/order");
const Category = require("../models/category");
const Complain = require("../models/complain");
const Company = require("../models/company");
const Warehouse = require("../models/warehouse");



// Import CRUD generators
const adminCrudGenerator = require("../utils/adminCrudGenerator");

/**
 * Auto-generate Admin CRUD with UI Forms for User model
 */
const userAdminCRUD = adminCrudGenerator(
  User,
  "users",
  ["name", "email", "password", "role", "profile_image", "company_id"],
  {
    // Custom options for User model
    excludedFields: ["__v", "password"],
    includedFields: ["name", "email", "role", "profile_image", "company_id", "createdAt"],
    searchableFields: ["name", "email"],
    filterableFields: ["role"],
    sortableFields: ["name", "email", "createdAt"],
    // Base URL for assets
    softDelete: true, // Enable soft delete functionality
    baseUrl: BASE_URL,
    // Custom validation
    validation: {
      insert: async (data) => {
        const errors = [];

        if (!data.name || data.name.trim().length < 2) {
          errors.push({
            field: "name",
            message: "Name must be at least 2 characters",
          });
        }

        if (!data.email || !data.email.includes("@")) {
          errors.push({ field: "email", message: "Valid email is required" });
        }

        if (!data.password || data.password.length < 6) {
          errors.push({
            field: "password",
            message: "Password must be at least 6 characters",
          });
        }

        return {
          isValid: errors.length === 0,
          errors,
        };
      },
    },
    // Custom field types
    fieldTypes: {
      role: "multiselect",
      profile_image: "file",
      company_id: "select",
      password: "password",
    },
    // Custom field options
    fieldOptions: {
      role: [
        { value: "USER", label: "User" },
        { value: "ADMIN", label: "Admin" },
        { value: "VENDOR", label: "Vendor" },
        { value: "CUSTOMER", label: "Customer" },
      ],
      company_id: [], // Will be populated dynamically
    },
    // Custom field labels
    fieldLabels: {
      profile_image: "Profile Image",
      password: "Password",
      company_id: "Company",
    },

    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await User.populate(records, { path: 'company_id', select: 'name' });

        // console.log(populatedRecords,'populatedRecords');
        if (req.fieldConfig?.company_id) {
          const results = await Company.find({ deletedAt: null }, 'name').sort({ name: 1 });
          req.fieldConfig.company_id.options = results.map(result => ({ value: result._id.toString(), label: result.name }));
          req.fieldConfig.company_id.placeholder = 'Select Company';
          req.fieldConfig.company_id.helpText = 'Choose the company for this user';
        }
        
        return populatedRecords;
      }
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        if (recordObj.company_id?.name) {
          recordObj.user_name = recordObj.company_id.name;
          recordObj.user_email = recordObj.company_id.email;
        }
        return recordObj;
      })
    }
  }
);


/**
 * Auto-generate Admin CRUD with UI Forms for Blog model
 */
const companyAdminCRUD = adminCrudGenerator(
  Company,
  "company",
  [], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: ["name", "phone", "email", "address", "logo", "status"],
    searchableFields: ["name", "email", "phone"],
    filterableFields: ["status"],
    sortableFields: ["name", "email", "status", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      logo: "file",
      status: "select",
      deletedAt: 'hidden',
    },
    fieldLabels: {
      logo: "Logo Image",
    },
    fieldOptions: {
      status: [
        { value: "active", label: "Active" },
        { value: "nonactive", label: "Non-Active" }
      ],
    },
    // middleware: {
    //   afterQuery: async (records, req) => {
    //     const populatedRecords = await Blog.populate(records, { path: 'user_id', select: 'name email' });
        
    //     if (req.fieldConfig?.user_id) {
    //       const users = await User.find({ deletedAt: { $exists: false } }, 'name email').sort({ name: 1 });
    //       req.fieldConfig.user_id.options = users.map(user => ({ value: user._id.toString(), label: user.name }));
    //       req.fieldConfig.user_id.placeholder = 'Select User';
    //       req.fieldConfig.user_id.helpText = 'Choose the user who posted this blog';
    //     }
        
    //     return populatedRecords;
    //   }
    // },
    // // Custom response formatting to show user name
    // responseFormatting: {
    //   list: async (records) => records.map(record => {
    //     const recordObj = record.toObject ? record.toObject() : record;
    //     if (recordObj.user_id?.name) {
    //       recordObj.user_name = recordObj.user_id.name;
    //       recordObj.user_email = recordObj.user_id.email;
    //     }
    //     return recordObj;
    //   })
    // }
  }
  );



  /**
 * Auto-generate Admin CRUD with UI Forms for Blog model
 */
const blogAdminCRUD = adminCrudGenerator(
  Blog,
  "blogs",
  ["name", "description", "user_id", "image"], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: ["name", "description", "user_id", "image", "createdAt"],
      searchableFields: ["name", "description"],
      filterableFields: ["user_id"],
      sortableFields: ["name", "description", "user_id", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      image: "file",
      user_id: "select",
    },
    fieldLabels: {
      image: "Blog Image",
      user_id: "Posted User",
    },
    fieldOptions: {
      user_id: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Blog.populate(records, { path: 'user_id', select: 'name email' });
        
        if (req.fieldConfig?.user_id) {
          const users = await User.find({ deletedAt: { $exists: false } }, 'name email').sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map(user => ({ value: user._id.toString(), label: user.name }));
          req.fieldConfig.user_id.placeholder = 'Select User';
          req.fieldConfig.user_id.helpText = 'Choose the user who posted this blog';
        }
        
        return populatedRecords;
      }
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        if (recordObj.user_id?.name) {
          recordObj.user_name = recordObj.user_id.name;
          recordObj.user_email = recordObj.user_id.email;
        }
        return recordObj;
      })
    }
  }
  );


  /**
 * Auto-generate Admin CRUD with UI Forms for Order model
 */
const orderAdminCRUD = adminCrudGenerator(
  Order,
  "orders",
  ["name", "email", "phone", "address", "description", "user_id"],
  {
    excludedFields: ["__v"],
    includedFields: [
      "name",
      "email",
      "phone",
      "address",
      "description",
      "user_id",
      "createdAt",
    ],
    searchableFields: ["name", "email", "phone","address"],
    filterableFields: [],
    sortableFields: ["name", "email", "phone", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      email: "email",
      phone: "number",
      user_id: "select",
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Blog.populate(records, { path: 'user_id', select: 'name' });
         if (req.fieldConfig?.user_id) {
          const users = await User.find({ deletedAt: { $exists: false } }, 'name').sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map(user => ({ value: user._id.toString(), label: user.name }));
          req.fieldConfig.user_id.placeholder = 'Select User';
          req.fieldConfig.user_id.helpText = 'Choose the user who posted this blog';
        }
        return populatedRecords;
      }
    },
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        if (recordObj.user_id?.name) {
          recordObj.user_name = recordObj.user_id.name;
          recordObj.user_email = recordObj.user_id.email;
        }
        return recordObj;
      })
    }
  }
);
/**
 * Auto-generate Admin CRUD with UI Forms for Product model
 */
const productAdminCRUD = adminCrudGenerator(
  Product, // Mongoose model for products
  "products", // Route prefix for product CRUD operations
  ["parent_product_id", "product_name", "product_slug", "category_id", "product_description", "warehouse_inventory", "warehouse_inventory_display", "total_quantity", "product_price", "product_image", "multi_images", "product_type", "unit", "weight", "length", "width", "height", "dimension", "tax_rate", "barcode"], // Fields to include in CRUD operations
  {
    excludedFields: ["__v"], // Fields to exclude from forms and display
    includedFields: [], // Additional fields to include (empty means use all except excluded)
    searchableFields: ["product_name", "product_description", "product_price", "product_type", "unit", "weight", "length", "width", "height", "dimension", "tax_rate", "barcode"], // Fields that can be searched (excluded parent_product_id as it's ObjectId)
    filterableFields: [], // Fields that can be filtered (empty means filter by all displayed fields)
    sortableFields: ["name", "price", "description", "description_details", "createdAt", "product_type", "unit", "weight", "length", "width", "height", "dimension", "tax_rate", "barcode"], // Fields that can be sorted
    baseUrl: BASE_URL, // Base URL for the application
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      price: "number", // Number input field
      product_image: "file", // File upload field for single image
      description: "textarea", // Multi-line text area
      multi_images: "file", // File upload field for multiple images
      warehouse_inventory: "custom", // Custom field type for warehouse inventory
      warehouse_inventory_display: "text", // Display only field
      total_quantity: "number", // Display only field
      parent_product_id: "select", // Dropdown select field+ 
      category_id: "multiselect",
    },
    fieldLabels: {
      product_image: "Product Image", // Human-readable label for product image
      multi_images: "Multiple Product Images", // Human-readable label for multiple images
      warehouse_inventory: "Warehouse Inventory", // Human-readable label for warehouse inventory
      warehouse_inventory_display: "Warehouse Inventory", // Human-readable label for warehouse inventory display
      total_quantity: "Total Quantity", // Human-readable label for total quantity
      product_price: "Product Price" // Human-readable label for product price
    },
    middleware: {
      afterQuery: async (records, req) => {
        // Filter out records with empty parent_product_id to avoid cast errors
        const validRecords = records.filter(record => 
          record.parent_product_id && 
          record.parent_product_id !== null &&
          record.parent_product_id !== ''
        );

        if (req.fieldConfig?.category_id) {
          const categories = await Category.find({ deletedAt: null }, 'name').sort({ name: 1 });
          req.fieldConfig.category_id.options = categories.map(category => ({ value: category._id.toString(), label: category.name }));
          req.fieldConfig.category_id.placeholder = 'Select Category';
          req.fieldConfig.category_id.helpText = 'Choose the category for this product';
        }
        // Only populate if there are valid records
        let populatedRecords = records;
        if (validRecords.length > 0) {
          populatedRecords = await Product.populate(records, [
            {
              path:'category_id',
              select: 'name'
            },
            { 
              path: 'parent_product_id', 
              select: 'product_name' 
            },
            { 
              path: 'warehouse_inventory.warehouse_id', 
              select: 'warehouse_name warehouse_address status' 
            }
          ]);
        }
        
        // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
        // This afterQuery middleware is only for populating existing records in list views
        
        // console.log('🔍 Populated records:', populatedRecords); // Debug log of populated records
        return populatedRecords; // Return populated records with both parent products and warehouse data
      },
      // Fetch warehouses before rendering create form
      beforeCreateForm: async (req, res) => {
        
        try {
          // Fetch all active products for parent_product_id dropdown
          // Use aggregate to avoid ObjectId casting issues with legacy data
          const categories = await Category.find({ 
            status: 'active', // Only active companies
            deletedAt: null // Only non-deleted companies
          }).select('name').sort({ name: 1 }); // Select company details and sort by name
          console.log('categories___',categories);
          // Add companies to request object for view access
          req.categories = categories; // Store categories in request for form access
          req.fieldConfig.category_id.options = categories.map(category => ({ value: category._id.toString(), label: category.name }));
          req.fieldConfig.category_id.placeholder = 'Select Category';
          req.fieldConfig.category_id.helpText = 'Choose the Category for this product';
           // Use aggregation pipeline to filter parent products efficiently
           const parent_products = await Product.aggregate([
             {
               $match: {
                 deletedAt: null, // Only non-deleted products
                 $or: [
                   { parent_product_id: null }, // Products with null parent
                   { parent_product_id: { $exists: false } }, // Products without parent_product_id field
                   { parent_product_id: "" }, // Products with empty string parent (legacy data)
                   { parent_product_id: { $eq: "" } } // Alternative empty string check
                 ]
               }
             },
             {
               $project: {
                 _id: 1,
                 product_name: 1
               }
             },
             {
               $sort: { product_name: 1 }
             }
           ]);
          
           console.log('✅ Parent product options set:',parent_products);
           console.log('🔍 Parent products count:', parent_products.length);
           console.log('🔍 Field config exists:', !!req.fieldConfig);
           console.log('🔍 Parent product field exists:', !!req.fieldConfig?.parent_product_id);
           
           // Add parent products to request object for view access
           if (req.fieldConfig?.parent_product_id) { // Check if field config exists
             req.fieldConfig.parent_product_id.options = parent_products.map(product => ({ value: product._id.toString(), label: product.product_name })); // Convert products to dropdown options
             req.fieldConfig.parent_product_id.placeholder = 'Select Parent Product'; // Set dropdown placeholder
             req.fieldConfig.parent_product_id.helpText = 'Choose the parent product for this product'; // Set dropdown help text
             console.log('✅ Parent product options set:', req.fieldConfig.parent_product_id.options.length); // Log success with count
             console.log('🔍 Options array:', req.fieldConfig.parent_product_id.options); // Log the actual options
           } else {
             console.log('❌ Parent product field config not found'); // Log error if config missing
             console.log('🔍 Available field config keys:', Object.keys(req.fieldConfig || {})); // Log available fields
           }

          // Fetch all active warehouses
          const warehouses = await Warehouse.find({ 
            status: 'active', // Only active warehouses
            deletedAt: null // Only non-deleted warehouses
          }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 }); // Select warehouse details and sort by name
          
          // Add warehouses to request object for view access
          req.warehouses = warehouses; // Store warehouses in request for form access
          
          // Debug: Final fieldConfig state
          console.log('🔍 Final fieldConfig parent_product_id:', req.fieldConfig?.parent_product_id);
          console.log('🔍 Final fieldConfig keys:', Object.keys(req.fieldConfig || {}));
        } catch (error) {
          console.error('Error fetching data:', error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Fetch warehouses before rendering edit form
      beforeEditForm: async (req, res) => {
        try {
          
          

          // Fetch all active products for parent_product_id dropdown
          const parent_products = await Product.find({ 
            deletedAt: null, // Only non-deleted products
          }).select('parent_product_id product_name').sort({ product_name: 1 }); // Select parent product ID and name, sort alphabetically

          console.log('🔍 Parent products:', parent_products); // Debug log of fetched products
          console.log('🔍 Parent products found:', parent_products.length); // Debug log of product count
          console.log('🔍 Field config exists:', !!req.fieldConfig); // Debug log of field config existence
          console.log('🔍 Parent product field exists:', !!req.fieldConfig?.parent_product_id); // Debug log of specific field existence
          
          // Add parent products to request object for view access
          req.fieldConfig.parent_product_id.options = parent_products.map(product => ({ value: product._id.toString(), label: product.product_name })); // Convert products to dropdown options
          req.fieldConfig.parent_product_id.placeholder = 'Select Parent Product'; // Set dropdown placeholder text
          req.fieldConfig.parent_product_id.helpText = 'Choose the parent product for this product'; // Set dropdown help text

          // Fetch all active warehouses
          const warehouses = await Warehouse.find({ 
            status: 'active', // Only active warehouses
            deletedAt: null // Only non-deleted warehouses
          }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 }); // Select warehouse details and sort by name
          
          // Add warehouses to request object for view access
          req.warehouses = warehouses; // Store warehouses in request for form access
        } catch (error) {
          console.error('Error fetching data:', error); // Log any errors that occur
          req.warehouses = []; // Set empty array on error
        }
      },
      // Process warehouse inventory before insert
      beforeInsert: async (req, res) => {
        // Parse warehouse_inventory from request
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
          
          // Update request body with processed inventory
          req.body.warehouse_inventory = warehouseInventory;
        } else {
          // Check for warehouse_inventory fields with different patterns
          const warehouseFields = Object.keys(req.body).filter(key => key.includes('warehouse_inventory'));
          
          if (warehouseFields.length > 0) {
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
            
            req.body.warehouse_inventory = warehouseInventory;
          }
        }
      },
      // Process warehouse inventory before update
      beforeUpdate: async (req, res) => {
        console.log('🔧 beforeUpdate middleware - Processing warehouse inventory');
        console.log('🔧 Original req.body.warehouse_inventory:', req.body.warehouse_inventory);
        
        // Parse warehouse_inventory from request
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
          
          // Update request body with processed inventory
          req.body.warehouse_inventory = warehouseInventory;
          console.log('✅ Processed warehouse inventory:', warehouseInventory);
        } else {
          // Check for warehouse_inventory fields with different patterns
          const warehouseFields = Object.keys(req.body).filter(key => key.includes('warehouse_inventory'));
          
          if (warehouseFields.length > 0) {
            console.log('🔧 Found warehouse fields:', warehouseFields);
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
            
            req.body.warehouse_inventory = warehouseInventory;
            console.log('✅ Processed warehouse inventory from field names:', warehouseInventory);
          }
        }
      }
    },
    // Custom response formatting to show warehouse inventory nicely
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        
        // Format warehouse inventory for display
        if (recordObj.warehouse_inventory && Array.isArray(recordObj.warehouse_inventory)) {
          recordObj.warehouse_inventory_display = recordObj.warehouse_inventory.map(item => {
            const warehouse = item.warehouse_id;
            if (warehouse && warehouse.warehouse_name) {
              return `${warehouse.warehouse_name}: ${item.quantity}`;
            }
            return `Unknown Warehouse: ${item.quantity}`;
          }).join(', ');
          
          // Also add a summary
          const totalQuantity = recordObj.warehouse_inventory.reduce((sum, item) => sum + (item.quantity || 0), 0);
          recordObj.total_quantity = totalQuantity;
        } else {
          recordObj.warehouse_inventory_display = 'No inventory';
          recordObj.total_quantity = 0;
        }
        
        return recordObj;
      })
    }
  }
);




/**
 * Auto-generate Admin CRUD with UI Forms for warehouse model
 */
const warehouseAdminCRUD = adminCrudGenerator(
  Warehouse, // Mongoose model for warehouse
  "warehouse", // Route prefix for warehouse CRUD operations
  ["warehouse_name", "warehouse_address", "company_id", "warehouse_image", "status"], // Fields to include in CRUD operations
  {
    excludedFields: ["__v"], // Fields to exclude from forms and display
    includedFields: ["warehouse_name", "warehouse_address", "company_id", "warehouse_image", "status", "createdAt", "updatedAt"], // Fields to include in queries
    searchableFields: ["warehouse_name", "warehouse_address", "company_id"], // Fields that can be searched (excluded parent_product_id as it's ObjectId)
    filterableFields: [], // Fields that can be filtered (empty means filter by all displayed fields)
    sortableFields: ["warehouse_name", "warehouse_address", "company_name", "status", "createdAt"], // Fields that can be sorted
    baseUrl: BASE_URL, // Base URL for the application
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      warehouse_image: "file", // File upload field for single image
      status: "select", // Dropdown select field
    },
    fieldLabels: {
      warehouse_name: "Warehouse Name",
      warehouse_address: "Address", 
      company_name: "Company Name",
      warehouse_image: "Warehouse Image",
      status: "Status"
    },
    fieldOptions: {
      company_name: {
        name: 'company_name',
        type: 'text',
        label: 'Company Name',
        required: false,
        validation: {},
        options: [],
        placeholder: 'Company Name',
        helpText: 'Company name'
      }
    },
    middleware: {
      afterQuery: async (records, req) => {
        // Populate company_id for all records that have it
        const populatedRecords = await Warehouse.populate(records, [
          { 
            path: 'company_id', 
            select: 'company_name' 
          }
        ]);
        
        // Add company_name field to fieldConfig so it shows in the list view
        if (req.fieldConfig) {
          req.fieldConfig.company_name = {
            name: 'company_name',
            type: 'text',
            label: 'Company Name',
            required: false,
            validation: {},
            options: [],
            placeholder: 'Company Name',
            helpText: 'Company name'
          };
        }
        
        // Note: Dropdown options are set in beforeCreateForm/beforeEditForm middleware
        // This afterQuery middleware is only for populating existing records in list views
        
        return populatedRecords; // Return populated records with company data
      },
       
      // Fetch warehouses before rendering create form
      beforeCreateForm: async (req, res) => {
        try {
          // Fetch all active companies for company_id dropdown
          const companies = await Company.find({ 
            status: 'active', // Only active companies
            deletedAt: null // Only non-deleted companies
          }).select('company_name').sort({ company_name: 1 }); // Select company details and sort by name
          console.log('companies_find',companies);
          // Add companies to request object for view access
          req.companies = companies; // Store companies in request for form access
          req.fieldConfig.company_id.options = companies.map(company => ({ value: company._id.toString(), label: company.company_name }));
          req.fieldConfig.company_id.placeholder = 'Select Company';
          req.fieldConfig.company_id.helpText = 'Choose the company for this warehouse';
        } catch (error) {
          console.error('Error fetching data:', error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Fetch warehouses before rendering edit form
      beforeEditForm: async (req, res) => {
          // try {
            
          // } catch (error) {
            
          // }
        try {
          // Fetch all active companies for company_id dropdown
          const companies = await Company.find({ 
            status: 'active', // Only active companies
            deletedAt: null // Only non-deleted companies
          }).select('company_name').sort({ company_name: 1 }); // Select company details and sort by name
          
          // Add companies to request object for view access
          req.companies = companies; // Store companies in request for form access
          req.fieldConfig.company_id.options = companies.map(company => ({ value: company._id.toString(), label: company.company_name }));
          req.fieldConfig.company_id.placeholder = 'Select Company';
          req.fieldConfig.company_id.helpText = 'Choose the company for this warehouse';
          
          // Fetch all active warehouses
          // console.log('🔍 Field config exists:', !!req.fieldConfig); // Debug log of field config existence
          // console.log('🔍 Warehouse field exists:', !!req.fieldConfig?.warehouse_id); // Debug log of specific field existence
          // console.log('🔍 Final fieldConfig keys:', Object.keys(req.fieldConfig || {}));
        } catch (error) {
          console.error('Error fetching data:', error); // Log any errors
          req.warehouses = []; // Set empty array on error
        }
      },
      // Process warehouse inventory before insert
      
    },
    // Custom response formatting to show company name instead of ObjectId
    responseFormatting: {
      list: async (records) => {
        return records.map(record => {
          const recordObj = record.toObject ? record.toObject() : record;
          if (recordObj.company_id?.company_name) {
            recordObj.company_id = recordObj.company_id.company_name;
          }
          return recordObj;
        });
      }
    }
  }
);




const complainAdminCRUD = adminCrudGenerator(
  Complain,
  "complain",
  ["title", "description", "user_id", "image"], // Headings.
  {
    excludedFields: ["__v"],
    includedFields: ["title", "description", "user_id", "image", "createdAt"],
    searchableFields: ["title", "description"],
    filterableFields: ["user_id"],
    sortableFields: ["title", "description", "user_id", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      description: "textarea",
      image: "file",
      user_id: "select",
    },
    fieldLabels: {
      image: "Blog Image",
      user_id: "Posted User",
    },
    fieldOptions: {
      user_id: [], // Will be populated dynamically
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Complain.populate(records, { path: 'user_id', select: 'name email' });
        
        if (req.fieldConfig?.user_id) {
          const users = await User.find({ deletedAt: { $exists: false } }, 'name email').sort({ name: 1 });
          req.fieldConfig.user_id.options = users.map(user => ({ value: user._id.toString(), label: user.name }));
          req.fieldConfig.user_id.placeholder = 'Select User';
          req.fieldConfig.user_id.helpText = 'Choose the user who posted this complaint';
        }
        
        return populatedRecords;
      }
    },
    // Custom response formatting to show user name
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        if (recordObj.user_id?.name) {
          recordObj.user_name = recordObj.user_id.name;
          recordObj.user_email = recordObj.user_id.email;
        }
        return recordObj;
      })
    }
  }
  );
  


/**
 * Auto-generate Admin CRUD with UI Forms for Category model (Minimal Setup Example)
 */
const categoryAdminCRUD = adminCrudGenerator(
  Category,
  "categories",
  ["parent_id", "name", "description", "isActive", "icon", "color", "sort_order", "status"],
  {
    excludedFields: ["__v"],
    includedFields: [
      "parent_id",
      "name",
      "description",
      "isActive",
      "icon",
      "color",
      "sort_order",
      "status",
      "createdAt",
    ],
    searchableFields: ["name", "description"],
    filterableFields: ["isActive"],
    sortableFields: ["name", "sort_order", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      isActive: "checkbox",
      sort_order: "number",
      description: "textarea",
      parent_id: "select",
    },
    fieldLabels: {
      parent_id: "Parent Category",
    },
    fieldOptions: {
      isActive: [
        { value: true, label: "Active" },
        { value: false, label: "Inactive" },
      ],
    },
    middleware: {
      afterQuery: async (records, req) => {
        const populatedRecords = await Category.populate(records, { path: 'parent_id', select: 'name' });
        console.log('populatedRecords',populatedRecords);
        if (req.fieldConfig?.parent_id) {
          const categories = await Category.find({ deletedAt: null }, 'name').sort({ name: 1 });
          req.fieldConfig.parent_id.options = [
            { value: '', label: 'None (Top Level Category)' },
            ...categories.map(category => ({ value: category._id.toString(), label: category.name }))
          ];
          req.fieldConfig.parent_id.placeholder = 'Select Parent Category';
          req.fieldConfig.parent_id.helpText = 'Choose the parent category (optional)';
        }
        return populatedRecords;
      }
    },
    responseFormatting: {
      list: async (records) => records.map(record => {
        const recordObj = record.toObject ? record.toObject() : record;
        // If parent_id is populated, convert it to display the name
        if (recordObj.parent_id) {
          if (typeof recordObj.parent_id === 'object' && recordObj.parent_id.name) {
            recordObj.parent_id = recordObj.parent_id.name;
          }
        } else {
          recordObj.parent_id = 'Top Level';
        }
        return recordObj;
      })
    },
    fieldOptions: {
      isActive: [
        { value: true, label: "Active" },
        { value: false, label: "Inactive" },
      ],
    },
  }
);

/**
 * Mount all Admin CRUD routes under /admin
 *
 * This automatically creates:
 * - /admin/users - User CRUD with forms
 * - /admin/products - Product CRUD with forms
 * - /admin/blogs - Blog CRUD with forms
 * - /admin/orders - Order CRUD with forms
 * - /admin/categories - Category CRUD with forms
 */

// Apply admin authentication middleware to all routes
router.use(restrictTo(["ADMIN"]));

// Update existing routes with CRUD controllers
routeRegistry.updateRoute('users', { crudController: userAdminCRUD });
routeRegistry.updateRoute('products', { crudController: productAdminCRUD });
routeRegistry.updateRoute('blogs', { crudController: blogAdminCRUD });
routeRegistry.updateRoute('orders', { crudController: orderAdminCRUD });
routeRegistry.updateRoute('categories', { crudController: categoryAdminCRUD });
routeRegistry.updateRoute('complain', { crudController: complainAdminCRUD });
routeRegistry.updateRoute('company', { crudController: companyAdminCRUD });
routeRegistry.updateRoute('warehouse', { crudController: warehouseAdminCRUD });

// Add routes data to all requests for dynamic menu rendering (after all routes are registered)
router.use((req, res, next) => {
  req.routes = routeRegistry.getEnabledRoutes();
  req.baseUrl = BASE_URL;
  next();
});

// Product complaints route
router.get("/products/complaints", (req, res) => {
  try {
    res.render("admin/list", {
      title: "Product Complaints",
      modelName: "products/complaints",
      records: [], // You can fetch actual complaints here
      fieldConfig: {},
      routes: req.routes || [],
      baseUrl: req.baseUrl || BASE_URL,
      pagination: {
        currentPage: 1,
        totalPages: 1,
        totalItems: 0,
        itemsPerPage: 10,
        hasNextPage: false,
        hasPrevPage: false
      },
      filters: {
        search: '',
        applied: [],
        searchable: [],
        filterable: [],
        sortable: []
      }
    });
  } catch (error) {
    console.error("Product complaints error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading product complaints",
      error: { statusCode: 500, message: "Internal server error" }
    });
  }
});

// Mount all registered CRUD routes dynamically
const enabledRoutes = routeRegistry.getEnabledRoutes();
enabledRoutes.forEach(route => {
  if (route.crudController && route.crudController.routes) {
    const routePath = route.path.replace('/admin/', '');
    // console.log(`🔧 Mounting ${route.name} routes at /${routePath}`);
    router.use(`/${routePath}`, route.crudController.routes);
    // console.log(`✅ ${route.name} routes mounted successfully`);
  }
});


/**
 * Admin Dashboard Overview
 * GET /admin/dashboard
 */
router.get("/dashboard", async (req, res) => {
  try {
    // Get quick statistics for dashboard
    const stats = {
      users: await User.countDocuments(),
      products: await Product.countDocuments(),
      blogs: await Blog.countDocuments(),
      orders: await Order.countDocuments(),
      categories: await Category.countDocuments(),
    };

    // Get recent activity
    const recentUsers = await User.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name email createdAt");
    const recentProducts = await Product.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name price createdAt");
    const recentOrders = await Order.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("order_number total_amount status createdAt");

    // Get dynamic routes for sidebar
    const enabledRoutes = routeRegistry.getEnabledRoutes();

    res.render("admin/dashboard", {
      title: "Admin Dashboard",
      stats,
      recentActivity: {
        users: recentUsers,
        products: recentProducts,
        orders: recentOrders,
      },
      routes: enabledRoutes,
      baseUrl: BASE_URL
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error retrieving dashboard data",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

/**
 * Admin System Info
 * GET /admin/system-info
 */
router.get("/system-info", (req, res) => {
  const systemInfo = {
    nodeVersion: process.version,
    platform: process.platform,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  };

  res.status(200).json({
    success: true,
    message: "System information retrieved successfully",
    data: systemInfo,
  });
});

/**
 * Route Management Endpoints
 */

// Get all routes
router.get("/routes", (req, res) => {
  try {
    const routes = routeRegistry.getAllRoutes();
    const stats = routeRegistry.getStats();
    
    res.status(200).json({
      success: true,
      message: "Routes retrieved successfully",
      data: {
        routes,
        stats
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving routes",
      error: error.message
    });
  }
});

// Get enabled routes (for sidebar)
router.get("/routes/enabled", (req, res) => {
  try {
    const routes = routeRegistry.getEnabledRoutes();
    
    res.status(200).json({
      success: true,
      message: "Enabled routes retrieved successfully",
      data: routes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error retrieving enabled routes",
      error: error.message
    });
  }
});

// Create new route
router.post("/routes", (req, res) => {
  try {
    const { key, name, icon, path, description, order, enabled } = req.body;
    
    if (!key || !name) {
      return res.status(400).json({
        success: false,
        message: "Key and name are required"
      });
    }
    
    const route = routeRegistry.registerRoute(key, {
      name,
      icon: icon || 'fas fa-cog',
      path: path || `/admin/${key}`,
      description: description || `Manage ${name.toLowerCase()}`,
      order: order || routeRegistry.getNextOrder(),
      enabled: enabled !== false
    });
    
    res.status(201).json({
      success: true,
      message: "Route created successfully",
      data: route
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating route",
      error: error.message
    });
  }
});

// Update route
router.put("/routes/:key", (req, res) => {
  try {
    const { key } = req.params;
    const updates = req.body;
    
    const route = routeRegistry.updateRoute(key, updates);
    
    if (!route) {
      return res.status(404).json({
        success: false,
        message: "Route not found"
      });
    }
    
    res.status(200).json({
      success: true,
      message: "Route updated successfully",
      data: route
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating route",
      error: error.message
    });
  }
});

// Toggle route enabled/disabled
router.patch("/routes/:key/toggle", (req, res) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body;
    
    const route = routeRegistry.toggleRoute(key, enabled);
    
    if (!route) {
      return res.status(404).json({
        success: false,
        message: "Route not found"
      });
    }
    
    res.status(200).json({
      success: true,
      message: `Route ${enabled ? 'enabled' : 'disabled'} successfully`,
      data: route
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error toggling route",
      error: error.message
    });
  }
});

// Delete route
router.delete("/routes/:key", (req, res) => {
  try {
    const { key } = req.params;
    
    const deleted = routeRegistry.deleteRoute(key);
    
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Route not found"
      });
    }
    
    res.status(200).json({
      success: true,
      message: "Route deleted successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting route",
      error: error.message
    });
  }
});

// Reorder routes
router.post("/routes/reorder", (req, res) => {
  try {
    const { orderedKeys } = req.body;
    
    if (!Array.isArray(orderedKeys)) {
      return res.status(400).json({
        success: false,
        message: "orderedKeys must be an array"
      });
    }
    
    routeRegistry.reorderRoutes(orderedKeys);
    
    res.status(200).json({
      success: true,
      message: "Routes reordered successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error reordering routes",
      error: error.message
    });
  }
});

// Route management view
router.get("/routes", (req, res) => {
  try {
    const enabledRoutes = routeRegistry.getEnabledRoutes();
    
    res.render("admin/route-management", {
      title: "Route Management",
      routes: enabledRoutes,
      baseUrl: BASE_URL
    });
  } catch (error) {
    console.error("Route management error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading route management",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

// Create route form view
router.get("/routes/create", (req, res) => {
  try {
    const enabledRoutes = routeRegistry.getEnabledRoutes();
    
    res.render("admin/route-management", {
      title: "Create Route",
      routes: enabledRoutes,
      baseUrl: BASE_URL,
      showCreateForm: true
    });
  } catch (error) {
    console.error("Create route form error:", error);
    res.status(500).render("admin/error", {
      title: "Error",
      message: "Error loading create route form",
      error: { statusCode: 500, message: "Internal server error" },
    });
  }
});

/**
 * Export CRUD controllers for external use
 */
router.get("/crud-controllers", (req, res) => {
  const controllers = {
    users: userAdminCRUD.controller,
    products: productAdminCRUD.controller,
    blogs: blogAdminCRUD.controller,
    orders: orderAdminCRUD.controller,
    categories: categoryAdminCRUD.controller,
    complain: complainAdminCRUD.controller,
    company: companyAdminCRUD.controller,
    warehouse: warehouseAdminCRUD.controller,
  };

  res.status(200).json({
    success: true,
    message: "Admin CRUD controllers information",
    data: {
      available: Object.keys(controllers),
      endpoints: {
        users: "/admin/users",
        products: "/admin/products",
        blogs: "/admin/blogs",
        orders: "/admin/orders",
        categories: "/admin/categories",
        complain: "/admin/complain",
        company: "/admin/company",
        warehouse: "/admin/warehouse",
      },
    },
  });
});

module.exports = router;

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
  Product,
  "products",
  ["product_name", "product_slug", "product_description", "warehouse_inventory", "warehouse_inventory_display", "total_quantity", "product_price", "product_image", "multi_images"],
  {
    excludedFields: ["__v"],
    includedFields: [],
    searchableFields: ["name", "description", "description_details", "price"],
    filterableFields: [],
    sortableFields: ["name", "price", "description", "description_details", "createdAt"],
    baseUrl: BASE_URL,
    softDelete: true, // Enable soft delete functionality
    fieldTypes: {
      price: "number",
      product_image: "file",
      description: "textarea",
      multi_images: "file",
      warehouse_inventory: "custom", // Custom field type for warehouse inventory
      warehouse_inventory_display: "text", // Display only field
      total_quantity: "number", // Display only field
    },
    fieldLabels: {
      product_image: "Product Image",
      multi_images: "Multiple Product Images",
      warehouse_inventory: "Warehouse Inventory",
      warehouse_inventory_display: "Warehouse Inventory",
      total_quantity: "Total Quantity",
      product_price: "Product Price"
    },
    middleware: {
      // Fetch warehouses before rendering create form
      beforeCreateForm: async (req, res) => {
        try {
          // Fetch all active warehouses
          const warehouses = await Warehouse.find({ 
            status: 'active',
            deletedAt: null 
          }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 });
          
          // Add warehouses to request object for view access
          req.warehouses = warehouses;
        } catch (error) {
          console.error('Error fetching warehouses:', error);
          req.warehouses = [];
        }
      },
      // Fetch warehouses before rendering edit form
      beforeEditForm: async (req, res) => {
        try {
          // Fetch all active warehouses
          const warehouses = await Warehouse.find({ 
            status: 'active',
            deletedAt: null 
          }).select('warehouse_name warehouse_address').sort({ warehouse_name: 1 });
          
          // Add warehouses to request object for view access
          req.warehouses = warehouses;
        } catch (error) {
          console.error('Error fetching warehouses:', error);
          req.warehouses = [];
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
        }
      },
      // Populate warehouse data after query
      afterQuery: async (records, req) => {
        const populatedRecords = await Product.populate(records, { 
          path: 'warehouse_inventory.warehouse_id', 
          select: 'warehouse_name warehouse_address status' 
        });
        return populatedRecords;
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
  ["parent_id", "name", "description", "isActive", "icon", "color", "sort_order"],
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
      },
    },
  });
});

module.exports = router;

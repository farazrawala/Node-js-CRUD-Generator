/**
 * Dynamic Route Generator
 * Automatically generates CRUD routes for all models
 */

const fs = require('fs');
const path = require('path');
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericDelete
} = require('./modelHelper');

/**
 * Get all model names from the models directory
 */
function getAllModels() {
  const modelsDir = path.join(__dirname, '..', 'models');
  const modelFiles = fs.readdirSync(modelsDir).filter(file => file.endsWith('.js'));
  return modelFiles.map(file => file.replace('.js', ''));
}

/**
 * Generate controller functions dynamically for a model
 */
function generateControllerFunctions(modelName) {
  return {
    // Create
    create: async (req, res) => {
      const response = await handleGenericCreate(req, modelName, {
        afterCreate: async (record, req) => {
          console.log(`✅ ${modelName} created successfully:`, record._id);
        },
      });
      return res.status(response.status).json(response);
    },

    // Update
    update: async (req, res) => {
      const filter = {};
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
      }
      
      const response = await handleGenericUpdate(req, modelName, {
        excludeFields: ['password'], // Don't return password in response
        filter: filter,
      });
      return res.status(response.status).json(response);
    },

    // Get by ID
    getById: async (req, res) => {
      const filter = {};
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
      }
      
      const response = await handleGenericGetById(req, modelName, {
        excludeFields: ['password'], // Don't exclude any fields except password
        filter: filter,
      });
      return res.status(response.status).json(response);
    },

    // Get all
    getAll: async (req, res) => {
      const filter = {};
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
      }
      
      const response = await handleGenericGetAll(req, modelName, {
        excludeFields: ['password'], // Don't exclude any fields except password
        sort: { createdAt: -1 }, // Sort by newest first
        limit: req.query.limit ? parseInt(req.query.limit) : null,
        skip: req.query.skip ? parseInt(req.query.skip) : 0,
        filter: filter,
      });
      return res.status(response.status).json(response);
    },

    // Get all active (if status field exists)
    getAllActive: async (req, res) => {
      const filter = { status: 'active', deletedAt: null };
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
      }
      
      const response = await handleGenericGetAll(req, modelName, {
        filter: filter,
        excludeFields: ['password'],
        sort: { createdAt: -1 },
        limit: req.query.limit ? parseInt(req.query.limit) : null,
        skip: req.query.skip ? parseInt(req.query.skip) : 0,
      });
      return res.status(response.status).json(response);
    },

    // Delete (soft delete)
    delete: async (req, res) => {
      console.log(`🔐 ${modelName} delete attempt:`, {
        id: req.params.id,
        time: new Date().toISOString(),
      });
      
      const filter = {};
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
      }
      
      // Manually set the request body with deletedAt data
      req.body = { deletedAt: new Date().toISOString() };
      const response = await handleGenericUpdate(req, modelName, {
        filter: filter,
        afterUpdate: async (record, req, existingRecord) => {
          console.log(`✅ ${modelName} soft deleted successfully.`);
        },
      });
      return res.status(response.status).json(response);
    }
  };
}

/**
 * Register CRUD routes for a model
 */
function registerModelRoutes(router, modelName, options = {}) {
  const {
    enabled = true, // Whether to enable this route
    excludedRoutes = [], // Routes to exclude (e.g., ['delete'])
    customRoutes = [], // Custom additional routes
  } = options;

  if (!enabled) {
    console.log(`⚠️  Routes for ${modelName} are disabled`);
    return;
  }

  const controller = generateControllerFunctions(modelName);

  // Register standard CRUD routes
  if (!excludedRoutes.includes('create')) {
    router.post(`/${modelName}/create`, controller.create);
  }
  
  if (!excludedRoutes.includes('update')) {
    router.patch(`/${modelName}/update/:id`, controller.update);
  }
  
  if (!excludedRoutes.includes('getById')) {
    router.get(`/${modelName}/get/:id`, controller.getById);
  }
  
  if (!excludedRoutes.includes('getAll')) {
    router.get(`/${modelName}/get-all`, controller.getAll);
  }
  
  if (!excludedRoutes.includes('getAllActive')) {
    router.get(`/${modelName}/get-all-active`, controller.getAllActive);
  }
  
  if (!excludedRoutes.includes('delete')) {
    router.delete(`/${modelName}/delete/:id`, controller.delete);
  }

  // Register custom routes
  customRoutes.forEach(route => {
    if (route.method && route.path && route.handler) {
      router[route.method.toLowerCase()](route.path, route.handler);
      console.log(`✅ Registered custom route: ${route.method} ${route.path}`);
    }
  });

  console.log(`✅ Registered ${modelName} routes: POST /create, PATCH /update/:id, GET /get/:id, GET /get-all, GET /get-all-active, DELETE /delete/:id`);
}

/**
 * Register routes for all models in the models directory
 * @param {Object} router - Express router instance
 * @param {Object} options - Configuration options
 */
function registerAllModelRoutes(router, options = {}) {
  const {
    excludedModels = [], // Models to exclude from automatic registration
    modelConfigs = {}, // Per-model configurations
    enabled = true, // Global enable/disable
  } = options;

  if (!enabled) {
    console.log('⚠️  Dynamic route registration is disabled');
    return;
  }

  const allModels = getAllModels();
  console.log(`\n🚀 Starting dynamic route registration for ${allModels.length} models...\n`);

  allModels.forEach(modelName => {
    // Skip excluded models
    if (excludedModels.includes(modelName)) {
      console.log(`⏭️  Skipping ${modelName} (in excluded list)`);
      return;
    }

    // Get model-specific configuration
    const modelConfig = modelConfigs[modelName] || {};
    
    // Register routes for this model
    registerModelRoutes(router, modelName, modelConfig);
  });

  console.log(`\n✅ Dynamic route registration completed!\n`);
}

module.exports = {
  getAllModels,
  generateControllerFunctions,
  registerModelRoutes,
  registerAllModelRoutes
};

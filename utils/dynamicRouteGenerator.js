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
  handleGenericDelete,
  parseSearchFieldsFromQuery,
  buildPopulateFromQuery,
} = require('./modelHelper');

const RESERVED_QUERY_KEYS = new Set([
  'limit',
  'skip',
  'search',
  'searchFields',
  'populate',
  'sort',
  'sortBy',
  'sortOrder',
  'page',
  'deleted',
]);

function parseQueryValue(raw) {
  if (raw === undefined || raw === null) return raw;
  if (Array.isArray(raw)) return raw.map(parseQueryValue);
  const str = String(raw).trim();
  if (str.includes(',')) {
    return str
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (str === 'true') return true;
  if (str === 'false') return false;
  if (str !== '' && !Number.isNaN(Number(str))) return Number(str);
  return str;
}

function applyQueryFilters(baseFilter, query = {}) {
  const filter = { ...baseFilter };
  Object.keys(query).forEach((key) => {
    if (RESERVED_QUERY_KEYS.has(key)) return;
    const parsed = parseQueryValue(query[key]);
    if (parsed === '' || parsed === undefined) return;
    if (Array.isArray(parsed)) {
      filter[key] = { $in: parsed };
      return;
    }
    filter[key] = parsed;
  });
  return filter;
}

function buildSortFromQuery(query = {}, fallback = { createdAt: -1 }) {
  const sortBy = typeof query.sortBy === 'string' ? query.sortBy.trim() : '';
  const sortOrderRaw = typeof query.sortOrder === 'string' ? query.sortOrder.trim().toLowerCase() : '';
  if (!sortBy) {
    return fallback;
  }
  const direction = sortOrderRaw === 'asc' || sortOrderRaw === '1' ? 1 : -1;
  return { [sortBy]: direction };
}

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
      console.log(`🚀 ${modelName} create called with req.user:`, req.user ? { _id: req.user._id, email: req.user.email, company_id: req.user.company_id } : 'NO USER');
      
      // Always add company_id to req.body if user has one
      if (req.user && req.user.company_id) {
        req.body.company_id = req.user.company_id;
        console.log(`🔍 Adding company_id to ${modelName} create:`, req.user.company_id);
      } else {
        console.log(`⚠️  No company_id found in req.user for ${modelName} create`);
      }
      
      const response = await handleGenericCreate(req, modelName, {
        afterCreate: async (record, req) => {
          // Special case: when creating a company, link it back to the creator user.
          // Company documents do not have `company_id`, but user documents do.
          if (modelName === 'company' && req.user && req.user._id) {
            try {
              const UserModel = require(path.join(__dirname, '..', 'models', 'user'));
              await UserModel.findByIdAndUpdate(
                req.user._id,
                { company_id: record._id },
                { new: true }
              );
              console.log(`🔗 Linked user ${req.user._id} to company ${record._id}`);
            } catch (linkErr) {
              console.error(`⚠️ Failed to link user to company after create:`, linkErr.message);
            }
          }

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
        console.log(`🔍 Filtering ${modelName} update by company_id:`, req.user.company_id);
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
        console.log(`🔍 Filtering ${modelName} by company_id:`, req.user.company_id);
      }
      
      const response = await handleGenericGetById(req, modelName, {
        excludeFields: ['password'], // Don't exclude any fields except password
        filter: filter,
      });
      return res.status(response.status).json(response);
    },

    // Get all
    getAll: async (req, res) => {
      let filter = { deletedAt: null };
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
        console.log(`🔍 Filtering ${modelName} by company_id:`, req.user.company_id);
      }
      filter = applyQueryFilters(filter, req.query);
      const sort = buildSortFromQuery(req.query, { createdAt: -1 });

      // console.log("filter", filter);
      // console.log("req.query.limit", req.query.limit);
      // console.log("req.query.skip", req.query.skip);
      // console.log("req.query.sort", req.query.sort);
      // console.log("req.query.populate", req.query.populate);
      // console.log("req.query.select", req.query.select);
      // console.log("req.query.populate", req.query.populate);
      // console.log("req.query.populate", req.query.populate);
      // exit();
      
      const response = await handleGenericGetAll(req, modelName, {
        excludeFields: ['password'], // Don't exclude any fields except password
        sort,
        limit: req.query.limit ? parseInt(req.query.limit) : null,
        skip: req.query.skip ? parseInt(req.query.skip) : 0,
        filter: filter,
        search: req.query.search,
        searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
        populate: buildPopulateFromQuery(req.query, modelName),
      });
      return res.status(response.status).json(response);
    },

    // Get all active (if status field exists)
    getAllActive: async (req, res) => {
      let filter = { status: 'active', deletedAt: null };
      
      // Always filter by company_id if user has one
      if (req.user && req.user.company_id) {
        filter.company_id = req.user.company_id;
        console.log(`🔍 Filtering ${modelName} by company_id:`, req.user.company_id);
      }
      filter = applyQueryFilters(filter, req.query);
      const sort = buildSortFromQuery(req.query, { createdAt: -1 });

      const response = await handleGenericGetAll(req, modelName, {
        filter: filter,
        excludeFields: ['password'],
        sort,
        limit: req.query.limit ? parseInt(req.query.limit) : null,
        skip: req.query.skip ? parseInt(req.query.skip) : 0,
        search: req.query.search,
        searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
        populate: buildPopulateFromQuery(req.query, modelName),
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
        console.log(`🔍 Filtering ${modelName} delete by company_id:`, req.user.company_id);
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
 * Build route names for a model (singular + plural alias).
 * Example: "order" -> ["order", "orders"]
 */
function getModelRouteNames(modelName) {
  const names = [modelName];
  const pluralName = modelName.endsWith('s') ? modelName : `${modelName}s`;
  if (!names.includes(pluralName)) {
    names.push(pluralName);
  }
  return names;
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
  const routeNames = getModelRouteNames(modelName);

  routeNames.forEach((routeName) => {
    // Register standard CRUD routes for singular/plural aliases.
    if (!excludedRoutes.includes('create')) {
      router.post(`/${routeName}/create`, controller.create);
    }

    if (!excludedRoutes.includes('update')) {
      router.patch(`/${routeName}/update/:id`, controller.update);
    }

    if (!excludedRoutes.includes('getById')) {
      router.get(`/${routeName}/get/:id`, controller.getById);
    }

    if (!excludedRoutes.includes('getAll')) {
      router.get(`/${routeName}/get-all`, controller.getAll);
    }

    if (!excludedRoutes.includes('getAllActive')) {
      router.get(`/${routeName}/get-all-active`, controller.getAllActive);
    }

    if (!excludedRoutes.includes('delete')) {
      router.delete(`/${routeName}/delete/:id`, controller.delete);
    }
  });

  // Register custom routes
  customRoutes.forEach(route => {
    if (route.method && route.path && route.handler) {
      router[route.method.toLowerCase()](route.path, route.handler);
      console.log(`✅ Registered custom route: ${route.method} ${route.path}`);
    }
  });

  const routeSummary = routeNames.map((name) => `/${name}`).join(', ');
  console.log(
    `✅ Registered ${modelName} routes for ${routeSummary}: POST /create, PATCH /update/:id, GET /get/:id, GET /get-all, GET /get-all-active, DELETE /delete/:id`
  );
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
  getModelRouteNames,
  generateControllerFunctions,
  registerModelRoutes,
  registerAllModelRoutes
};

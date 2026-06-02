/**
 * Dynamic Route Generator
 * Automatically generates CRUD routes for all models
 */

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericSoftDelete,
  handleGenericGetById,
  handleGenericGetAll,
  parseSearchFieldsFromQuery,
  buildPopulateFromQuery,
  getModelFromController,
  shouldTreatQueryKeyAsPopulateOnly,
  coalesceObjectId,
  applyIncludeExcludeIdQueryFilter,
  INCLUDE_EXCLUDE_ID_QUERY_KEYS,
} = require("./modelHelper");
const {
  runCachedListHandler,
  invalidateListCacheForReq,
} = require("./redisCache");

const RESERVED_QUERY_KEYS = new Set([
  "limit",
  "skip",
  "search",
  "searchFields",
  "populate",
  "sort",
  "sortBy",
  "sortOrder",
  "page",
  "deleted",
  "include_inactive",
  "role",
  ...INCLUDE_EXCLUDE_ID_QUERY_KEYS,
]);

function parseQueryValue(raw) {
  if (raw === undefined || raw === null) return raw;
  if (Array.isArray(raw)) return raw.map(parseQueryValue);
  const str = String(raw).trim();
  if (str.includes(",")) {
    return str
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (str === "true") return true;
  if (str === "false") return false;
  if (str !== "" && !Number.isNaN(Number(str))) return Number(str);
  return str;
}

/** Tenant id for filters / body when `req.user.company_id` is populated `{ _id, ... }` or raw ObjectId. */
function tenantCompanyIdFromUser(user) {
  if (!user?.company_id) return null;
  return coalesceObjectId(user.company_id);
}

/** `amount_gt=0` → `{ amount: { $gt: 0 } }` (see getAll / get-all-active query strings). */
const QUERY_RANGE_FIELD_RE = /^([a-zA-Z][a-zA-Z0-9_]*)_(gt|gte|lt|lte)$/;

function applyQueryFilters(baseFilter, query = {}, modelName = null) {
  const filter = { ...baseFilter };
  let Model = null;
  if (modelName) {
    try {
      Model = getModelFromController(modelName);
    } catch (_) {
      Model = null;
    }
  }
  Object.keys(query).forEach((key) => {
    if (RESERVED_QUERY_KEYS.has(key)) return;
    if (shouldTreatQueryKeyAsPopulateOnly(Model, modelName, key, query[key])) {
      return;
    }

    const rangeMatch = key.match(QUERY_RANGE_FIELD_RE);
    if (rangeMatch) {
      const field = rangeMatch[1];
      const op = `$${rangeMatch[2]}`;
      const parsed = parseQueryValue(query[key]);
      const num = Number(parsed);
      if (!Number.isFinite(num)) return;
      const existing = filter[field];
      const isOperatorBucket =
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        !(existing instanceof Date) &&
        !mongoose.Types.ObjectId.isValid(String(existing));
      if (isOperatorBucket) {
        filter[field] = { ...existing, [op]: num };
      } else if (existing === undefined || existing === null) {
        filter[field] = { [op]: num };
      }
      return;
    }

    const parsed = parseQueryValue(query[key]);
    if (parsed === "" || parsed === undefined) return;
    if (Array.isArray(parsed)) {
      filter[key] = { $in: parsed };
      return;
    }
    filter[key] = parsed;
  });
  return filter;
}

/**
 * `?role=CUSTOMER` or `?role=customer` on user list routes.
 * `role` is stored as a string array; equality matches docs that include the role.
 */
function applyUserRoleQueryFilter(filter, query, modelName) {
  if (modelName !== "user") {
    return { filter, error: null };
  }
  const raw = query?.role;
  if (raw == null || String(raw).trim() === "") {
    return { filter, error: null };
  }

  let allowed = ["USER", "ADMIN", "VENDOR", "CUSTOMER"];
  try {
    const User = getModelFromController("user");
    if (Array.isArray(User.USER_ROLE_VALUES) && User.USER_ROLE_VALUES.length) {
      allowed = User.USER_ROLE_VALUES;
    }
  } catch (_) {
    /* keep default */
  }

  const roles = (
    Array.isArray(raw) ? raw : String(raw).split(",")
  )
    .map((s) => String(s).trim().toUpperCase())
    .filter(Boolean);
  const valid = roles.filter((r) => allowed.includes(r));
  if (valid.length === 0) {
    return {
      filter,
      error: {
        success: false,
        status: 400,
        error: "Invalid role",
        message: `role must be one of: ${allowed.join(", ")}`,
        allowed,
      },
    };
  }

  return {
    filter: {
      ...filter,
      role: valid.length === 1 ? valid[0] : { $in: valid },
    },
    error: null,
  };
}

function buildSortFromQuery(query = {}, fallback = { createdAt: -1 }) {
  const sortBy = typeof query.sortBy === "string" ? query.sortBy.trim() : "";
  const sortOrderRaw =
    typeof query.sortOrder === "string" ?
      query.sortOrder.trim().toLowerCase()
    : "";
  if (!sortBy) {
    return fallback;
  }
  const direction = sortOrderRaw === "asc" || sortOrderRaw === "1" ? 1 : -1;
  return { [sortBy]: direction };
}

/** Standalone MongoDB has no replica-set transactions — session-based ops fail until we retry without `session`. */
function mongoTransactionsProbablyUnsupported(err, handlerFailureDetails = "") {
  const combined = [
    err?.message,
    err?.details,
    handlerFailureDetails,
    String(err?.code ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
  return /replica set|Transaction numbers|Sessions are not supported|transaction.*not supported|multidocument transaction|cannot use session|Snapshot session|IllegalOperation/i.test(
    combined,
  );
}

/**
 * Run `fn(session)` inside a Mongo transaction; if the deployment does not support
 * transactions, retry `fn(null)` once without a session.
 */
async function withTxnFallback(fn) {
  try {
    return await mongoose.connection.transaction((session) => fn(session));
  } catch (err) {
    if (err.retryWithoutSession || mongoTransactionsProbablyUnsupported(err)) {
      console.warn(
        "[dynamicRoute] Mongo transactions unavailable; retrying without session:",
        err.message,
      );
      return fn(null);
    }
    throw err;
  }
}

/**
 * Get all model names from the models directory
 */
function getAllModels() {
  const modelsDir = path.join(__dirname, "..", "models");
  const modelFiles = fs
    .readdirSync(modelsDir)
    .filter((file) => file.endsWith(".js"));
  return modelFiles.map((file) => file.replace(".js", ""));
}

/**
 * Generate controller functions dynamically for a model
 */
function generateControllerFunctions(modelName) {
  return {
    // Create
    create: async (req, res) => {
      console.log(
        `🚀 ${modelName} create called with req.user:`,
        req.user ?
          {
            _id: req.user._id,
            email: req.user.email,
            company_id: req.user.company_id,
          }
        : "NO USER",
      );

      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Request body is required",
        });
      }

      // Always add company_id to req.body if user has one
      const tenantCo = tenantCompanyIdFromUser(req.user);
      if (tenantCo) {
        req.body.company_id = tenantCo;
        console.log(`🔍 Adding company_id to ${modelName} create:`, tenantCo);
      } else {
        console.log(
          `⚠️  No company_id found in req.user for ${modelName} create`,
        );
      }

      // `assets` requires user_id — default to authenticated user
      if (modelName === "assets" && req.user?._id && !req.body.user_id) {
        req.body.user_id = req.user._id;
      }

      const userControllerPath = path.join(
        __dirname,
        "..",
        "controllers",
        "user",
      );

      const afterCreate = async (record, req, session) => {
        // When creating a company, link the creator user to the new tenant root (`user.company_id`).
        // `Company.company_id` on the schema is an optional **parent** ref (branch rows); generic create may set it from `req.user.company_id` above for subsidiary flows.
        if (modelName === "company" && req.user && req.user._id) {
          try {
            const UserModel = require(
              path.join(__dirname, "..", "models", "user"),
            );
            await UserModel.findByIdAndUpdate(
              req.user._id,
              { company_id: record._id },
              { new: true, ...(session ? { session } : {}) },
            );
            console.log(
              `🔗 Linked user ${req.user._id} to company ${record._id}`,
            );
          } catch (linkErr) {
            console.error(
              `⚠️ Failed to link user to company after create:`,
              linkErr.message,
            );
          }
        }

        if (modelName === "user") {
          try {
            const { postTransactionsForUserInitialBalance } = require(
              userControllerPath,
            );
            await postTransactionsForUserInitialBalance(record, req, session);
          } catch (glErr) {
            console.error(
              `⚠️ postTransactionsForUserInitialBalance:`,
              glErr.message,
            );
            throw glErr;
          }
        }

        console.log(`✅ ${modelName} created successfully:`, record._id);
      };

      try {
        if (modelName === "user") {
          const response = await withTxnFallback(async (session) => {
            const out = await handleGenericCreate(req, modelName, {
              ...(session ? { session } : {}),
              afterCreate,
            });
            if (!out.success) {
              const det = String(out.details || "");
              if (
                session &&
                mongoTransactionsProbablyUnsupported({ message: det }, det)
              ) {
                const e = new Error(det);
                e.retryWithoutSession = true;
                throw e;
              }
              throw new Error(det || out.error || "User create failed");
            }
            return out;
          });
          if (response?.success) {
            await invalidateListCacheForReq(req, modelName, "get-all-active");
          }
          return res.status(response.status).json(response);
        }

        const response = await handleGenericCreate(req, modelName, {
          afterCreate,
        });
        if (response?.success) {
          await invalidateListCacheForReq(req, modelName, "get-all-active");
        }
        return res.status(response.status).json(response);
      } catch (err) {
        console.error(`❌ ${modelName} create error:`, err.message);
        return res.status(500).json({
          success: false,
          message: err.message || "Create transaction aborted",
        });
      }
    },

    // Update
    update: async (req, res) => {
      const filter = {};

      // Always filter by company_id if user has one
      const tenantCo = tenantCompanyIdFromUser(req.user);
      if (tenantCo) {
        filter.company_id = tenantCo;
        console.log(
          `🔍 Filtering ${modelName} update by company_id:`,
          tenantCo,
        );
      }

      const userControllerPath = path.join(
        __dirname,
        "..",
        "controllers",
        "user",
      );

      const updateOptions = {
        excludeFields: ["password"], // Don't return password in response
        filter: filter,
      };

      const priorAfterUpdate = updateOptions.afterUpdate;
      updateOptions.afterUpdate = async (
        updatedRecord,
        req,
        existingRecord,
        session,
      ) => {
        if (modelName === "user") {
          try {
            const { reconcileUserInitialBalanceOnUpdate } = require(
              userControllerPath,
            );
            await reconcileUserInitialBalanceOnUpdate(
              updatedRecord,
              req,
              existingRecord,
              session,
            );
          } catch (e) {
            console.error("⚠️ reconcileUserInitialBalanceOnUpdate:", e.message);
            throw e;
          }
        }
        if (priorAfterUpdate) {
          await priorAfterUpdate(updatedRecord, req, existingRecord, session);
        }
      };

      try {
        if (modelName === "user") {
          const response = await withTxnFallback(async (session) => {
            const out = await handleGenericUpdate(req, modelName, {
              ...updateOptions,
              ...(session ? { session } : {}),
            });
            if (!out.success) {
              const det = String(out.details || "");
              if (
                session &&
                mongoTransactionsProbablyUnsupported({ message: det }, det)
              ) {
                const e = new Error(det);
                e.retryWithoutSession = true;
                throw e;
              }
              throw new Error(det || out.error || "User update failed");
            }
            return out;
          });
          if (response?.success) {
            await invalidateListCacheForReq(req, modelName, "get-all-active");
          }
          return res.status(response.status).json(response);
        }

        const response = await handleGenericUpdate(
          req,
          modelName,
          updateOptions,
        );
        if (response?.success) {
          await invalidateListCacheForReq(req, modelName, "get-all-active");
        }
        return res.status(response.status).json(response);
      } catch (err) {
        console.error(`❌ ${modelName} update error:`, err.message);
        return res.status(500).json({
          success: false,
          message: err.message || "Update transaction aborted",
        });
      }
    },

    // Get by ID
    getById: async (req, res) => {
      const filter = {};

      // Always filter by company_id if user has one
      const tenantCo = tenantCompanyIdFromUser(req.user);
      if (tenantCo) {
        filter.company_id = tenantCo;
        console.log(`🔍 Filtering ${modelName} by company_id:`, tenantCo);
      }

      const response = await handleGenericGetById(req, modelName, {
        excludeFields: ["password"], // Don't exclude any fields except password
        filter: filter,
      });
      return res.status(response.status).json(response);
    },

    // Get all
    getAll: async (req, res) => {
      let filter = { deletedAt: null };

      // Always filter by company_id if user has one
      const tenantCo = tenantCompanyIdFromUser(req.user);
      if (tenantCo) {
        filter.company_id = tenantCo;
        console.log(`🔍 Filtering ${modelName} by company_id:`, tenantCo);
      }
      filter = applyQueryFilters(filter, req.query, modelName);
      const roleFilter = applyUserRoleQueryFilter(filter, req.query, modelName);
      if (roleFilter.error) {
        return res.status(roleFilter.error.status).json(roleFilter.error);
      }
      filter = roleFilter.filter;
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
        excludeFields: ["password"], // Don't exclude any fields except password
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
      return runCachedListHandler(req, res, {
        module: modelName,
        action: "get-all-active",
        fetch: async () => {
          // `user`: "active" = not soft-deleted and not explicitly `inactive` (legacy docs may omit `status`).
          // Pass `?include_inactive=true` to list every non-deleted user for the tenant (admin-style directory).
          let filter = { deletedAt: null };
          if (modelName === "user") {
            const includeInactive =
              req.query.include_inactive === "true" ||
              req.query.include_inactive === "1";
            if (!includeInactive) {
              filter.status = { $ne: "inactive" };
            }
          } else {
            filter.status = "active";
          }

          const tenantCo = tenantCompanyIdFromUser(req.user);
          if (tenantCo) {
            filter.company_id = tenantCo;
            console.log(`🔍 Filtering ${modelName} by company_id:`, tenantCo);
          }
          filter = applyQueryFilters(filter, req.query, modelName);
          const roleFilter = applyUserRoleQueryFilter(
            filter,
            req.query,
            modelName,
          );
          if (roleFilter.error) {
            return roleFilter.error;
          }
          filter = roleFilter.filter;
          filter = applyIncludeExcludeIdQueryFilter(filter, req.query);
          const sort = buildSortFromQuery(req.query, { createdAt: -1 });

          return handleGenericGetAll(req, modelName, {
            filter: filter,
            excludeFields: ["password"],
            sort,
            limit: req.query.limit ? parseInt(req.query.limit) : null,
            skip: req.query.skip ? parseInt(req.query.skip) : 0,
            search: req.query.search,
            searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
            populate: buildPopulateFromQuery(req.query, modelName),
          });
        },
      });
    },

    // Delete (soft delete)
    delete: async (req, res) => {
      console.log(`🔐 ${modelName} delete attempt:`, {
        id: req.params.id,
        time: new Date().toISOString(),
      });

      const filter = {};

      // Always filter by company_id if user has one
      const tenantCo = tenantCompanyIdFromUser(req.user);
      if (tenantCo) {
        filter.company_id = tenantCo;
        console.log(
          `🔍 Filtering ${modelName} delete by company_id:`,
          tenantCo,
        );
      }

      const response = await handleGenericSoftDelete(req, modelName, {
        filter,
        afterSoftDelete: async () => {
          console.log(`✅ ${modelName} soft deleted successfully.`);
          await invalidateListCacheForReq(req, modelName, "get-all-active");
        },
      });
      return res.status(response.status).json(response);
    },
  };
}

/**
 * Build route names for a model (singular + plural alias).
 * Example: "order" -> ["order", "orders"]
 */
function getModelRouteNames(modelName) {
  const names = [modelName];
  const pluralName = modelName.endsWith("s") ? modelName : `${modelName}s`;
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
    if (!excludedRoutes.includes("create")) {
      router.post(`/${routeName}/create`, controller.create);
    }

    if (!excludedRoutes.includes("update")) {
      router.patch(`/${routeName}/update/:id`, controller.update);
    }

    if (!excludedRoutes.includes("getById")) {
      router.get(`/${routeName}/get/:id`, controller.getById);
    }

    if (!excludedRoutes.includes("getAll")) {
      router.get(`/${routeName}/get-all`, controller.getAll);
    }

    if (!excludedRoutes.includes("getAllActive")) {
      router.get(`/${routeName}/get-all-active`, controller.getAllActive);
    }

    if (!excludedRoutes.includes("delete")) {
      router.delete(`/${routeName}/delete/:id`, controller.delete);
    }
  });

  // Register custom routes
  customRoutes.forEach((route) => {
    if (route.method && route.path && route.handler) {
      router[route.method.toLowerCase()](route.path, route.handler);
      console.log(`✅ Registered custom route: ${route.method} ${route.path}`);
    }
  });

  const routeSummary = routeNames.map((name) => `/${name}`).join(", ");
  console.log(
    `✅ Registered ${modelName} routes for ${routeSummary}: POST /create, PATCH /update/:id, GET /get/:id, GET /get-all, GET /get-all-active, DELETE /delete/:id`,
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
    console.log("⚠️  Dynamic route registration is disabled");
    return;
  }

  const allModels = getAllModels();
  console.log(
    `\n🚀 Starting dynamic route registration for ${allModels.length} models...\n`,
  );

  allModels.forEach((modelName) => {
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
  registerAllModelRoutes,
};

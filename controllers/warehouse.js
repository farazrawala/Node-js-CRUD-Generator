const {
  handleGenericCreate,

  handleGenericUpdate,

  handleGenericGetById,

  handleGenericGetAll,

  handleGenericFindOne,
} = require("../utils/modelHelper");

const {
  runCachedListHandler,
  invalidateListCacheForReq,
} = require("../utils/redisCache");

const WAREHOUSE_LIST_CACHE_MODULE = "warehouse";
const WAREHOUSE_LIST_CACHE_ACTION = "get-all-active";

async function warehouseCreate(req, res) {
  const response = await handleGenericCreate(req, "warehouse", {
    afterCreate: async (record, req) => {
      await invalidateListCacheForReq(
        req,
        WAREHOUSE_LIST_CACHE_MODULE,
        WAREHOUSE_LIST_CACHE_ACTION,
      );

      console.log("✅ Record created successfully:", record);
    },
  });

  return res.status(response.status).json(response);
}

async function warehouseUpdate(req, res) {
  const response = await handleGenericUpdate(req, "warehouse", {
    excludeFields: ["password"], // Don't return password in response

    // allowedFields: [] - Empty array means allow all fields except password (dynamic)

    beforeUpdate: async (updateData, req, existingUser) => {
      console.log("🔧 Processing user update...", {
        userId: existingUser._id,

        currentName: existingUser.name,

        newName: updateData.name,

        currentEmail: existingUser.email,

        newEmail: updateData.email,

        hasProfileImage: !!req.files?.profile_image,

        updateFields: Object.keys(updateData),
      });
    },

    afterUpdate: async (record, req, existingUser) => {
      await invalidateListCacheForReq(
        req,
        WAREHOUSE_LIST_CACHE_MODULE,
        WAREHOUSE_LIST_CACHE_ACTION,
      );

      console.log("✅ Record updated successfully:", record);
    },
  });

  return res.status(response.status).json(response);
}

async function warehouseById(req, res) {
  const response = await handleGenericGetById(req, "warehouse", {
    excludeFields: [], // Don't exclude any fields
  });

  return res.status(response.status).json(response);
}

async function getAllwarehouse(req, res) {
  const response = await handleGenericGetAll(req, "warehouse", {
    excludeFields: [], // Don't exclude any fields

    // populate: ["user_id"],

    sort: { createdAt: -1 }, // Sort by newest first

    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params

    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });

  return res.status(response.status).json(response);
}

/**
 * Active warehouses for the user's company (cached via generic list handler).
 */
async function getallwarehouseactive(req, res) {
  return runCachedListHandler(req, res, {
    module: WAREHOUSE_LIST_CACHE_MODULE,
    action: WAREHOUSE_LIST_CACHE_ACTION,
    fetch: () =>
      handleGenericGetAll(req, "warehouse", {
        filter: {
          status: "active",
          deletedAt: null,
          companyId: req.user.companyId,
        },
        excludeFields: [],
        sort: { createdAt: -1 },
        limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
        skip: req.query.skip ? parseInt(req.query.skip, 10) : 0,
      }),
  });
}

async function warehousedelete(req, res) {
  console.log("🔐 warehouse delete attempt:", {
    id: req.params.id,

    time: new Date().toISOString(),
  });

  // Manually set the request body with deletedAt data

  req.body = { deletedAt: new Date().toISOString() };

  const response = await handleGenericUpdate(req, "warehouse", {
    afterUpdate: async (record, req, existingRecord) => {
      await invalidateListCacheForReq(
        req,
        WAREHOUSE_LIST_CACHE_MODULE,
        WAREHOUSE_LIST_CACHE_ACTION,
      );
    },
  });

  return res.status(response.status).json(response);
}

async function findOnewarehouse(req, res) {
  const response = await handleGenericFindOne(req, "warehouse", {
    searchCriteria: { slug: req.params.slug },

    excludeFields: ["internal_notes"], // Exclude sensitive fields

    populate: ["author"], // Populate author information
  });

  return res.status(response.status).json(response);
}

// Example: Find warehouse by slug instead of ID

async function findwarehouseBySlug(req, res) {
  const response = await handleGenericFindOne(req, "warehouse", {
    searchCriteria: { slug: req.params.slug },

    excludeFields: ["internal_notes"], // Exclude sensitive fields

    populate: ["author"], // Populate author information
  });

  return res.status(response.status).json(response);
}

// Example: Find active warehouse by title

async function findActivewarehouseByTitle(req, res) {
  const response = await handleGenericFindOne(req, "warehouse", {
    searchCriteria: {
      title: req.body.title,

      active: true,

      status: "published",
    },

    excludeFields: ["password"],

    beforeFind: async (criteria, req) => {
      console.log("🔍 Searching for active warehouse with criteria:", criteria);

      return criteria;
    },

    afterFind: async (record, req) => {
      console.log("✅ Found active warehouse:", record.title);
    },
  });

  return res.status(response.status).json(response);
}

// Example: Find warehouse by custom parameters from request body

async function findwarehouseByParams(req, res) {
  const { category, author, tags, status } = req.body;

  // Build search criteria dynamically

  const searchCriteria = {};

  if (category) searchCriteria.category = category;

  if (author) searchCriteria.author = author;

  if (tags) searchCriteria.tags = { $in: tags }; // MongoDB operator for array contains

  if (status) searchCriteria.status = status;

  const response = await handleGenericFindOne(req, "warehouse", {
    searchCriteria,

    includeFields: ["title", "slug", "createdAt", "author"], // Only return specific fields

    populate: ["author", "category"],

    sort: { createdAt: -1 }, // Get the most recent one if multiple match
  });

  return res.status(response.status).json(response);
}

module.exports = {
  warehouseCreate,

  warehouseUpdate,

  warehouseById,

  getAllwarehouse,

  getallwarehouseactive,

  warehousedelete,

  findActivewarehouseByTitle,

  findwarehouseByParams,
};

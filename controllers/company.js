const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
} = require("../utils/modelHelper");
const {
  invalidateAllListCacheForReq,
  listAllListCacheForReq,
  resolveCompanyIdFromReq,
} = require("../utils/redisCache");

// async function companyCreate(req, res) {
//   const response = await handleGenericCreate(req, "company", {
//     afterCreate: async (record, req) => {
//       console.log("✅ Record created successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

// async function companyUpdate(req, res) {
//   const response = await handleGenericUpdate(req, "", {
//     afterUpdate: async (record, req, existingUser) => {
//       console.log("✅ Record updated successfully:", record);
//     },
//   });
//   return res.status(response.status).json(response);
// }

// async function companyUpdate(req, res) {
//   const response = await handleGenericUpdate(req, "company", {
//     excludeFields: ["password"], // Don't return password in response
//     // allowedFields: [] - Empty array means allow all fields except password (dynamic)
//     beforeUpdate: async (updateData, req, existingRecord) => {
//       console.log("🔧 Processing company update...", {
//         companyId: existingRecord._id,
//         currentName: existingRecord.company_name,
//         newName: updateData.company_name,
//         updateFields: Object.keys(updateData),
//       });
//     },
//     afterUpdate: async (record, req, existingRecord) => {
//       console.log("✅ Record updated successfully:", record);
//     },
//   });

//   return res.status(response.status).json(response);
// }

// async function companyById(req, res) {
//   const response = await handleGenericGetById(req, "company", {
//     excludeFields: [], // Don't exclude any fields
//   });
//   return res.status(response.status).json(response);
// }

// async function getAllcompany(req, res) {
//   const response = await handleGenericGetAll(req, "company", {
//     excludeFields: [], // Don't exclude any fields
//     populate: [], // Company model doesn't have user_id field
//     sort: { createdAt: -1 }, // Sort by newest first
//     limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
//     skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
//   });
//   return res.status(response.status).json(response);
// }

// async function getallcompanyactive(req, res) {
//   const response = await handleGenericGetAll(req, "company", {
//     filter: { status: "active", deletedAt: null },
//     excludeFields: [], // Don't exclude any fields
//     populate: [], // Company model doesn't have user_id field
//     sort: { createdAt: -1 }, // Sort by newest first
//     limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
//     skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
//   });
//   return res.status(response.status).json(response);
// }

// async function companydelete(req, res) {
//   console.log("🔐 company delete attempt:", {
//     id: req.params.id,
//     time: new Date().toISOString(),
//   });

//   // Manually set the request body with deletedAt data
//   req.body = { deletedAt: new Date().toISOString() };
//   const response = await handleGenericUpdate(req, "company", {
//     afterUpdate: async (record, req, existingRecord) => {
//       // console.log("✅ company soft deleted successfully. DeletedAt:", record.deletedAt);
//     },
//   });
//   return res.status(response.status).json(response);
// }

async function getMyBranches(req, res) {
  const filter = { status: "active", deletedAt: null };

  // Tenant root (`_id`) plus subsidiary `Company` rows whose `company_id` parent points at that tenant.
  if (req.user?.company_id || req.user?._id) {
    filter.$or = [];
    if (req.user?.company_id) {
      filter.$or.push({ _id: req.user.company_id });
      filter.$or.push({ company_id: req.user.company_id });
    }
    if (req.user?._id) {
      filter.$or.push({ created_by: req.user._id });
    }
  }

  const response = await handleGenericGetAll(req, "company", {
    filter,
    excludeFields: [], // Don't exclude any fields
    populate: [], // Company model doesn't have user_id field
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}


/**
 * DELETE/POST — clear all list-cache entries for the authenticated user's company.
 * Pattern: `{companyId}:*` (warehouse, product, inventory_movements, etc.).
 */
async function removeCache(req, res) {
  try {
    const companyId = resolveCompanyIdFromReq(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message:
          "company_id is required (authenticate with a user linked to a company)",
      });
    }

    const before = await listAllListCacheForReq(req);
    const keysDeleted = await invalidateAllListCacheForReq(req);
    const after = await listAllListCacheForReq(req);

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        after.count === 0 ?
          keysDeleted > 0 || before.count > 0 ?
            "Company cache cleared successfully"
          : "No cached list entries found for this company"
        : "Some cache entries could not be cleared",
      company_id: companyId,
      pattern: `${companyId}:*`,
      keys_before: before.count,
      keys_deleted: keysDeleted,
      keys_remaining: after.count,
      remaining_keys: after.entries.map((e) => e.key),
    });
  } catch (error) {
    console.error("❌ removeCache:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to clear cache",
    });
  }
}

/**
 * GET — list all list-cache keys for the authenticated user's company.
 * Query: `?include_values=true` to add a small summary of each cached payload.
 */
async function listAllCache(req, res) {
  try {
    const companyId = resolveCompanyIdFromReq(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message:
          "company_id is required (authenticate with a user linked to a company)",
      });
    }

    const data = await listAllListCacheForReq(req);

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        data.count > 0 ?
          `Found ${data.count} cached list entry(ies) for this company`
        : "No cached list entries found for this company",
      ...data,
    });
  } catch (error) {
    console.error("❌ listAllCache:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to list cache",
    });
  }
}

module.exports = {
  getMyBranches,
  removeCache,
  listAllCache,
};

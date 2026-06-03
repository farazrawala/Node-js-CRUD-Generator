const mongoose = require("mongoose");
const User = require("../models/user");
const Company = require("../models/company");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  coalesceObjectId,
} = require("../utils/modelHelper");
const {
  invalidateAllListCacheForReq,
  invalidateListCacheForReq,
  listAllListCacheForReq,
  resolveCompanyIdFromReq,
} = require("../utils/redisCache");
const { logListAccess } = require("../utils/applicationLogs");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const {
  isMongoTransactionUnsupportedError,
} = require("../utils/mongoTransactionSupport");

function tenantCompanyIdFromUser(user) {
  if (!user?.company_id) return null;
  return coalesceObjectId(user.company_id);
}

function throwWithGenericFailure(response, fallbackMessage) {
  const err = new Error(
    response?.error || response?.message || fallbackMessage || "Request failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details ?? response?.missing ?? response;
  err.clientErrorPayload = response;
  throw err;
}

function companyCreateLogContext(req, extra = {}) {
  return {
    user_id: req.user?._id ?? null,
    company_name: req.body?.company_name,
    parent_company_id: req.body?.company_id,
    ...extra,
  };
}

async function runCompanyCreateWithOptionalTransaction(runFlow) {
  let session = null;
  let txnError = null;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runFlow(session);
    });
  } catch (error) {
    if (isMongoTransactionUnsupportedError(error)) {
      if (session) {
        try {
          session.endSession();
        } catch (_) {
          /* ignore */
        }
        session = null;
      }
      try {
        await runFlow(null);
      } catch (retryError) {
        txnError = retryError;
      }
    } else {
      txnError = error;
    }
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return txnError;
}

async function linkCreatorUserToCompany(userId, companyId, session = null) {
  const userOid = coalesceObjectId(userId);
  const companyOid = coalesceObjectId(companyId);
  if (!userOid || !companyOid) {
    const err = new Error("user_id and company_id are required to link tenant");
    err.statusCode = 400;
    throw err;
  }

  const updated = await User.findByIdAndUpdate(
    userOid,
    { company_id: companyOid },
    { new: true, ...(session ? { session } : {}) },
  );
  if (!updated) {
    const err = new Error("Failed to link user to company after create");
    err.statusCode = 500;
    throw err;
  }
  return updated;
}

async function rollbackCompanyCreate(tracker, req, session = null) {
  const opts = session ? { session } : {};
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const uid = coalesceObjectId(req.user?._id);
  if (uid) softDeleteSet.updated_by = uid;

  if (tracker.companyId) {
    await Company.updateOne(
      { _id: tracker.companyId },
      { $set: softDeleteSet },
      opts,
    );
  }

  if (tracker.userLinked && tracker.userId) {
    const userSet = {
      company_id: tracker.userCompanyIdBefore ?? null,
    };
    await User.updateOne({ _id: tracker.userId }, { $set: userSet }, opts);
  }

  console.warn(
    `⚠️ company create compensating rollback: company=${tracker.companyId}, user=${tracker.userId}`,
  );
}

/**
 * POST /api/company/create — company row + link creator `user.company_id` atomically.
 */
async function runCompanyCreateBody(req, session, tracker) {
  const tenantCo = tenantCompanyIdFromUser(req.user);
  if (tenantCo) {
    req.body.company_id = tenantCo;
  }

  tracker.create_step = "company";
  const response = await handleGenericCreate(req, "company", {
    ...(session ? { session } : {}),
    afterCreate: async (record, req, sess) => {
      tracker.companyId = record._id;
      if (req.user?._id) {
        tracker.create_step = "link_user";
        await linkCreatorUserToCompany(
          req.user._id,
          record._id,
          sess || session,
        );
        tracker.userLinked = true;
      }
    },
  });

  if (!response?.success) {
    throwWithGenericFailure(response, "Company create failed");
  }

  tracker.create_step = "complete";
  return response;
}

async function companyCreate(req, res) {
  const tracker = {
    create_step: "init",
    companyId: null,
    userId: coalesceObjectId(req.user?._id),
    userCompanyIdBefore: null,
    userLinked: false,
  };

  if (tracker.userId) {
    const userRow = await User.findById(tracker.userId)
      .select("company_id")
      .lean();
    tracker.userCompanyIdBefore = userRow?.company_id ?? null;
  }

  let response = null;
  const txnError = await runCompanyCreateWithOptionalTransaction(
    async (session) => {
      try {
        response = await runCompanyCreateBody(req, session, tracker);
      } catch (stepError) {
        if (!session && (tracker.companyId || tracker.userLinked)) {
          await rollbackCompanyCreate(tracker, req, null);
        }
        throw stepError;
      }
    },
  );

  if (txnError) {
    console.error("❌ companyCreate failed:\n", serializeErrorForLog(txnError));
    await logRollbackFailure(req, txnError, {
      action: "COMPANY CREATE ROLLBACK",
      tags: ["company", "create", "error"],
      fallbackUrl: req.originalUrl || "/api/company/create",
      context: companyCreateLogContext(req, {
        create_step: tracker.create_step,
        company_id: tracker.companyId,
        user_id: tracker.userId,
        prior_user_company_id: tracker.userCompanyIdBefore,
        user_linked: tracker.userLinked,
        execution_mode:
          isMongoTransactionUnsupportedError(txnError) ?
            "no_mongodb_transaction_compensating_rollback"
          : "mongodb_transaction_aborted",
        api_client_error: txnError.clientErrorPayload ?? null,
      }),
      fallbackCompanyId: tracker.userCompanyIdBefore ?? req.user?.company_id,
    });

    if (txnError.clientErrorPayload) {
      return res
        .status(
          txnError.clientErrorPayload.status || txnError.statusCode || 400,
        )
        .json(txnError.clientErrorPayload);
    }
    return res.status(txnError.statusCode || 500).json({
      success: false,
      message: txnError.message || "Company create failed",
      details: txnError.details ?? undefined,
      type: txnError.responseType || "internal",
    });
  }

  await invalidateListCacheForReq(req, "company", "get-all-active");

  return res.status(response?.status || 201).json(response);
}

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

    void logListAccess(req, {
      source: "cache",
      module: "company",
      action: "remove-cache",
      description: {
        keys_before: before.count,
        keys_deleted: keysDeleted,
        keys_remaining: after.count,
      },
    });

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
 * GET `/api/company/list-cache` — list tenant list-cache keys (memory + Redis).
 * Not a substitute for module lists; use e.g. `GET /api/category/get-all-active` for data.
 * Query: `?include_values=true` for a small summary per cached payload.
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

    void logListAccess(req, {
      source: "cache",
      module: "company",
      action: "list-cache",
      description: { entry_count: data.count },
    });

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
  companyCreate,
  getMyBranches,
  removeCache,
  listAllCache,
};

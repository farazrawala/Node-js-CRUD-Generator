const ProcessModel = require("../models/process");
const { coalesceObjectId, activeNotDeletedCriteria } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");
const { normalizeCompanyId } = require("./redisQueue");

const FETCH_PRODUCT_ACTIONS = new Set(["fetch_product", "fetch_products"]);

function isFetchProductAction(action) {
  return FETCH_PRODUCT_ACTIONS.has(String(action || "").trim());
}

function buildCompanyCriteria(companyId) {
  const objectId = coalesceObjectId(companyId);
  if (!objectId) return null;
  const asString = String(objectId);
  return { $or: [{ company_id: objectId }, { company_id: asString }] };
}

/**
 * Create (or reuse) an active fetch_product process row and enqueue it in Redis.
 */
async function createFetchProductQueueJob({
  req,
  integration,
  integrationId,
  companyId,
  createdBy,
  options = {},
}) {
  const resolvedIntegrationId = coalesceObjectId(
    integrationId || integration?._id || integration?.id,
  );
  const resolvedCompanyId = normalizeCompanyId(
    companyId ||
      integration?.company_id?._id ||
      integration?.company_id ||
      req?.user?.company_id,
  );
  const actor = coalesceObjectId(createdBy || req?.user?._id);

  if (!resolvedIntegrationId) {
    const err = new Error("integration_id is required.");
    err.statusCode = 400;
    throw err;
  }
  if (!resolvedCompanyId) {
    const err = new Error("company_id is required.");
    err.statusCode = 400;
    throw err;
  }

  const companyCriteria = buildCompanyCriteria(resolvedCompanyId);
  const existingFilter = {
    integration_id: resolvedIntegrationId,
    action: { $in: [...FETCH_PRODUCT_ACTIONS] },
    status: "active",
    progress: { $nin: ["completed", "failed"] },
    $and: [activeNotDeletedCriteria()],
  };
  if (companyCriteria) existingFilter.$and.push(companyCriteria);

  let processDoc = null;
  let created = false;

  if (!options.force) {
    processDoc = await ProcessModel.findOne(existingFilter)
      .sort({ priority: 1, createdAt: 1 })
      .exec();
  }

  if (!processDoc) {
    processDoc = await ProcessModel.create({
      integration_id: resolvedIntegrationId,
      action: "fetch_product",
      company_id: coalesceObjectId(resolvedCompanyId),
      created_by: actor,
      status: "active",
      progress: "not_started",
      priority: Number(options.priority) || 100,
      limit: Number(options.limit) || 10,
      page: Number(options.page) || 1,
      offset: Number(options.offset) || 0,
      count: Number(options.count) || 0,
      hits: Number(options.hits) || 0,
      remarks: options.remarks || "Auto-queued fetch_product job",
    });
    created = true;
  } else if (options.priority != null || options.limit != null) {
    const patch = {};
    if (options.priority != null) patch.priority = Number(options.priority) || 100;
    if (options.limit != null) patch.limit = Number(options.limit) || 10;
    if (options.page != null) patch.page = Number(options.page) || 1;
    if (options.remarks != null) patch.remarks = options.remarks;
    if (Object.keys(patch).length) {
      processDoc = await ProcessModel.findByIdAndUpdate(processDoc._id, patch, {
        new: true,
      });
    }
  }

  const queueResult = await enqueueProcess(processDoc);

  return {
    created,
    reused: !created,
    process: processDoc,
    company_id: resolvedCompanyId,
    queue_key: `${resolvedCompanyId}:process`,
    queue: queueResult,
  };
}

module.exports = {
  FETCH_PRODUCT_ACTIONS,
  isFetchProductAction,
  createFetchProductQueueJob,
};

const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const { dispatchByStoreType } = require("../utils/processHelpers");
const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const woocommerceProcess = require("./woocommerceProcess");
const shopifyProcess = require("./shopifyProcess");
const {
  isQueueEnabled,
  enqueueProcess,
  releaseProcessFromQueue,
  peekNextProcessJob,
} = require("../utils/processQueue");
const { normalizeCompanyId } = require("../utils/redisQueue");
const {
  buildProcessSourceRows,
  normalizeProcessQueueBody,
  PROCESS_QUEUE_FORM_FIELDS,
} = require("../utils/processQueueForm");
const {
  isFetchProductAction,
  createFetchProductQueueJob,
} = require("../utils/fetchProductQueue");
const { createMockExpressResponse } = require("../utils/mockExpressResponse");

/**
 * Process queue orchestrator.
 * Loads the next active job and delegates to woocommerceProcess / shopifyProcess.
 */

function buildCompanyIdCriteria(companyId) {
  if (!companyId) {
    return null;
  }
  const objectId = coalesceObjectId(companyId);
  const asString = String(objectId);
  return {
    $or: [{ company_id: objectId }, { company_id: asString }],
  };
}

function buildActiveProcessFilter(req) {
  const filter = {
    status: "active",
    $and: [activeNotDeletedCriteria()],
  };

  if (req.query.company_id) {
    const companyCriteria = buildCompanyIdCriteria(req.query.company_id);
    if (companyCriteria) {
      filter.$and.push(companyCriteria);
    }
  }

  if (req.params?.id) {
    filter._id = coalesceObjectId(req.params.id);
  } else if (req.query.process_id) {
    filter._id = coalesceObjectId(req.query.process_id);
  }

  return { filter };
}

async function explainNoActiveProcess(req) {
  const { filter } = buildActiveProcessFilter(req);
  const totalActive = await ProcessModel.countDocuments(filter);

  const hints = [];
  if (req.params?.id || req.query.process_id) {
    hints.push("Check that process_id exists and status is active.");
  } else if (totalActive === 0) {
    hints.push(
      "Create a process in Admin with status active, or set an existing row back to active.",
    );
  } else {
    hints.push(
      "Pass ?process_id=<id> or GET /process/execute-process/:id to run a specific process row.",
    );
  }

  hints.push(
    "Use fetch_product / fetch_category / fetch_brand to import from the store; sync_* actions push one POS row to the store.",
  );

  return {
    message: "No active process found for this request.",
    hints,
    active_processes_matching_filter: totalActive,
  };
}

async function hydrateProcessCategory(process, req) {
  if (process?.category_id && typeof process.category_id === "object") {
    if (process.category_id.name) {
      return process.category_id;
    }
    process.category_id = coalesceObjectId(process.category_id._id);
  }

  const categoryId =
    coalesceObjectId(process?.category_id) ||
    coalesceObjectId(req.query?.category_id) ||
    coalesceObjectId(req.body?.category_id);

  if (!categoryId) {
    return null;
  }

  const category = await Category.findOne({
    _id: categoryId,
    deletedAt: null,
  }).lean();

  if (category) {
    process.category_id = category;
    return category;
  }

  return null;
}

async function hydrateProcessBrand(process, req) {
  if (process?.brand_id && typeof process.brand_id === "object") {
    if (process.brand_id.name) {
      return process.brand_id;
    }
    process.brand_id = coalesceObjectId(process.brand_id._id);
  }

  const brandId =
    coalesceObjectId(process?.brand_id) ||
    coalesceObjectId(req.query?.brand_id) ||
    coalesceObjectId(req.body?.brand_id);

  if (!brandId) {
    return null;
  }

  const brand = await Brand.findOne({
    _id: brandId,
    deletedAt: null,
  }).lean();

  if (brand) {
    process.brand_id = brand;
    return brand;
  }

  return null;
}

async function loadActiveProcess(req, queueRetry = 0) {
  const { filter } = buildActiveProcessFilter(req);
  const hasExplicitProcessId = Boolean(req.params?.id || req.query.process_id);
  let queuedJobCompanyId = null;

  if (isQueueEnabled() && !hasExplicitProcessId) {
    const scopedCompanyId =
      req.query.company_id ?
        normalizeCompanyId(req.query.company_id)
      : null;
    const nextJob = await peekNextProcessJob(scopedCompanyId);
    if (nextJob?.jobId) {
      queuedJobCompanyId = nextJob.companyId || scopedCompanyId;
      filter._id = coalesceObjectId(nextJob.jobId);
      if (nextJob.companyId && !scopedCompanyId) {
        const companyCriteria = buildCompanyIdCriteria(nextJob.companyId);
        if (companyCriteria) {
          filter.$and.push(companyCriteria);
        }
      }
    }
  }

  const processDoc = await ProcessModel.findOne(filter)
    .sort({ priority: 1, createdAt: 1 })
    .populate([
      "company_id",
      "integration_id",
      "product_id",
      "category_id",
      "brand_id",
    ]);

  if (!processDoc) {
    if (isQueueEnabled() && filter._id) {
      await releaseProcessFromQueue(queuedJobCompanyId, filter._id);
    }
    return null;
  }

  if (
    isQueueEnabled() &&
    !hasExplicitProcessId &&
    queueRetry < 5 &&
    (processDoc.status !== "active" ||
      ["completed", "failed"].includes(processDoc.progress))
  ) {
    await releaseProcessFromQueue(processDoc);
    return loadActiveProcess(req, queueRetry + 1);
  }

  const rawCategoryId = processDoc.category_id;
  const process = processDoc.toObject({ flattenMaps: true });

  if (!process.category_id && rawCategoryId) {
    process.category_id = rawCategoryId;
  }

  const rawBrandId = processDoc.brand_id;
  if (!process.brand_id && rawBrandId) {
    process.brand_id = rawBrandId;
  }

  await hydrateProcessCategory(process, req);
  await hydrateProcessBrand(process, req);
  return process;
}

const PROCESS_ACTIONS = new Set([
  "fetch_products",
  "fetch_product",
  "sync_product",
  "delete_product",
  "fetch_category",
  "sync_category",
  "delete_category",
  "fetch_brand",
  "sync_brand",
  "delete_brand",
]);

function normalizeBulkProcessRow(row, { companyId, createdBy }) {
  return {
    integration_id:
      row.integration_id ? coalesceObjectId(row.integration_id) : undefined,
    product_id: row.product_id ? coalesceObjectId(row.product_id) : undefined,
    category_id:
      row.category_id ? coalesceObjectId(row.category_id) : undefined,
    brand_id: row.brand_id ? coalesceObjectId(row.brand_id) : undefined,
    action: String(row.action || "").trim(),
    count: Number(row.count) || 0,
    page: Number(row.page) || 1,
    offset: Number(row.offset) || 0,
    limit: Number(row.limit) || 1,
    priority: Number(row.priority) || 100,
    remarks: row.remarks || "",
    hits: Number(row.hits) || 0,
    progress: row.progress || "not_started",
    status: row.status || "active",
    company_id: companyId,
    created_by: createdBy,
  };
}

function validateProcessRow(row) {
  if (!row.action || !PROCESS_ACTIONS.has(row.action)) {
    return `Invalid or missing action: ${row.action || "(empty)"}`;
  }
  if (!row.company_id) {
    return "company_id is required.";
  }
  if (row.action === "sync_category" && !row.category_id) {
    return "category_id is required for sync_category.";
  }
  if (row.action === "sync_brand" && !row.brand_id) {
    return "brand_id is required for sync_brand.";
  }
  if (row.action === "sync_product" && !row.product_id) {
    return "product_id is required for sync_product.";
  }
  if (
    (row.action === "fetch_category" ||
      row.action === "fetch_products" ||
      row.action === "fetch_product" ||
      row.action === "fetch_brand") &&
    !row.integration_id
  ) {
    return "integration_id is required for fetch actions.";
  }
  if (row.action === "sync_category" && !row.integration_id) {
    return "integration_id is required for sync_category.";
  }
  if (row.action === "sync_brand" && !row.integration_id) {
    return "integration_id is required for sync_brand.";
  }
  if (row.action === "sync_product" && !row.integration_id) {
    return "integration_id is required for sync_product.";
  }
  return null;
}

/**
 * POST /api/process/bulk-create
 * POST /api/process/queue-create
 *
 * Accepts JSON, application/x-www-form-urlencoded, or multipart FormData.
 *
 * Single job (FormData):
 *   integration_id, action, status=active, priority, limit, category_id|product_id|brand_id
 *
 * Bulk by ids (FormData):
 *   integration_id, action=sync_category, category_ids=id1,id2,id3
 */
async function createProcessQueueRecords(req, res) {
  const body = normalizeProcessQueueBody(req.body);
  const companyId = coalesceObjectId(body.company_id || req.user?.company_id);
  const createdBy = coalesceObjectId(req.user?._id);

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required (from auth user or request body).",
    });
  }

  const sourceRows = buildProcessSourceRows(body);
  if (!sourceRows.length) {
    return res.status(400).json({
      success: false,
      message:
        "Provide action plus category_id/product_id/brand_id, category_ids/brand_ids/product_ids, or items.",
      form_fields: PROCESS_QUEUE_FORM_FIELDS,
    });
  }

  const created = [];
  const failed = [];

  for (let index = 0; index < sourceRows.length; index += 1) {
    const normalized = normalizeBulkProcessRow(sourceRows[index], {
      companyId,
      createdBy,
    });
    const error = validateProcessRow(normalized);
    if (error) {
      failed.push({ index, error, input: sourceRows[index] });
      continue;
    }

    try {
      if (isFetchProductAction(normalized.action)) {
        const result = await createFetchProductQueueJob({
          req,
          integrationId: normalized.integration_id,
          companyId,
          createdBy,
          options: {
            priority: normalized.priority,
            limit: normalized.limit,
            page: normalized.page,
            offset: normalized.offset,
            remarks: normalized.remarks,
            force:
              body.force === true ||
              body.force === "1" ||
              body.force === 1,
          },
        });
        created.push({
          ...result.process.toObject(),
          queue_auto: true,
          queue_created: result.created,
          queue_reused: result.reused,
        });
        continue;
      }

      const doc = await ProcessModel.create(normalized);
      await enqueueProcess(doc);
      created.push(doc);
    } catch (err) {
      failed.push({
        index,
        error: err.message || "Insert failed",
        input: sourceRows[index],
      });
    }
  }

  if (created.length === 0) {
    return res.status(400).json({
      success: false,
      message: "No process records were created.",
      failed,
      form_fields: PROCESS_QUEUE_FORM_FIELDS,
    });
  }

  const fetchProductQueued = created.some((row) => row.queue_auto);
  const statusCode = failed.length > 0 ? 207 : 201;
  return res.status(statusCode).json({
    success: true,
    message:
      fetchProductQueued ?
        `Fetch product queue ready (${created.length} job(s)). Call execute-process to run.`
      : `Created ${created.length} process queue record(s).`,
    data: {
      created,
      summary: {
        total: sourceRows.length,
        created: created.length,
        failed: failed.length,
      },
      failed,
      queue_key: `${String(companyId).toLowerCase()}:process`,
      execute_process_url: "/api/process/execute-process",
    },
  });
}

async function processBulkCreate(req, res) {
  return createProcessQueueRecords(req, res);
}

async function processQueueCreate(req, res) {
  return createProcessQueueRecords(req, res);
}

/**
 * POST/GET /api/process/fetch-product-queue
 * FormData/JSON: integration_id, limit, priority, page, force
 */
async function processFetchProductQueue(req, res) {
  try {
    const body = normalizeProcessQueueBody(req.body);
    const integrationId =
      body.integration_id || req.params?.integration_id || req.params?.id;
    const companyId = coalesceObjectId(body.company_id || req.user?.company_id);

    if (!integrationId) {
      return res.status(400).json({
        success: false,
        message: "integration_id is required.",
      });
    }
    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required (from auth user or request body).",
      });
    }

    const result = await createFetchProductQueueJob({
      req,
      integrationId,
      companyId,
      options: {
        priority: body.priority,
        limit: body.limit,
        page: body.page,
        offset: body.offset,
        remarks: body.remarks,
        force: body.force === true || body.force === "1" || body.force === 1,
      },
    });

    return res.status(result.created ? 201 : 200).json({
      success: true,
      message:
        result.created ?
          "fetch_product queue created automatically."
        : "Existing fetch_product queue job reused and refreshed.",
      data: {
        process: result.process,
        queue_key: result.queue_key,
        queue: result.queue,
        created: result.created,
        reused: result.reused,
        execute_process_url: "/api/process/execute-process",
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to create fetch_product queue",
    });
  }
}

function processQueueFormSchema(req, res) {
  return res.status(200).json({
    success: true,
    endpoint: "POST /api/process/queue-create",
    content_types: [
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ],
    form_fields: PROCESS_QUEUE_FORM_FIELDS,
    examples: {
      fetch_category_formdata: {
        integration_id: "6789abcdef012345678901234",
        action: "fetch_category",
        status: "active",
        priority: 100,
        limit: 5,
        page: 1,
      },
      sync_category_single: {
        integration_id: "6789abcdef012345678901234",
        action: "sync_category",
        category_id: "69150abcdef012345678901234",
        priority: 50,
      },
      sync_category_bulk: {
        integration_id: "6789abcdef012345678901234",
        action: "sync_category",
        category_ids: "69150...,69151...,69152...",
      },
    },
  });
}

async function execute_process(req, res) {
  const process = await loadActiveProcess(req);

  if (!process) {
    const details = await explainNoActiveProcess(req);
    return res.status(400).json({
      success: false,
      ...details,
    });
  }

  return runProcessAction(req, res, process);
}

async function runProcessAction(req, res, process) {
  switch (process.action) {
    case "sync_product": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_product,
        shopify: shopifyProcess.sync_product,
      });
    }
    case "fetch_product":
    case "fetch_products": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_product,
        shopify: shopifyProcess.fetch_product,
      });
    }
    case "fetch_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_category,
        shopify: shopifyProcess.fetch_category,
      });
    }
    case "sync_category": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_category,
        shopify: shopifyProcess.sync_category,
      });
    }
    case "fetch_brand": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_brand,
        shopify: shopifyProcess.fetch_brand,
      });
    }
    case "sync_brand": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.sync_brand,
        shopify: shopifyProcess.sync_brand,
      });
    }

    default: {
      return res.status(400).json({
        success: false,
        message: `Invalid action: ${process.action}`,
      });
    }
  }
}

async function runProcessExecution(req) {
  const res = createMockExpressResponse();
  await execute_process(req, res);
  return res.getResult();
}

async function runQueueWorker(req, res) {
  const { drainProcessQueue, getWorkerStatus } = require("../utils/processQueueWorker");
  const status = getWorkerStatus();

  if (status.draining) {
    return res.status(409).json({
      success: false,
      message: "Queue worker is already running.",
      data: status,
    });
  }

  const result = await drainProcessQueue({
    companyId: req.query.company_id,
    processId: req.params.id || req.query.process_id,
    maxBatches: req.query.max_batches,
    user: req.user,
  });

  return res.status(200).json({
    success: true,
    message: `Queue worker finished (${result.batches_run || 0} batch(es) run).`,
    data: result,
  });
}

function getQueueWorkerStatus(req, res) {
  const { getWorkerStatus } = require("../utils/processQueueWorker");
  return res.status(200).json({
    success: true,
    data: getWorkerStatus(),
  });
}

module.exports = {
  execute_process,
  runProcessExecution,
  runQueueWorker,
  getQueueWorkerStatus,
  processBulkCreate,
  processQueueCreate,
  processFetchProductQueue,
  processQueueFormSchema,
};

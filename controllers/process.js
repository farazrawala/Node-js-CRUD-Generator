const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const {
  dispatchByStoreType,
  extractProcessErrorMessage,
  recordProcessFailure,
  attachProcessFailureHooks,
  markProcessOutcome,
} = require("../utils/processHelpers");
const ProcessModel = require("../models/process");
const Category = require("../models/category");
const Brand = require("../models/brands");
const woocommerceProcess = require("./woocommerceProcess");
const shopifyProcess = require("./shopifyProcess");
const {
  queue_bigcommerce_product_reset,
} = require("../utils/bigcommerceProductResetQueue");
const {
  isQueueEnabled,
  enqueueProcess,
  releaseProcessFromQueue,
  peekNextProcessJob,
  shouldQueueProcess,
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
const {
  findIntegrationIfActive,
  isIntegrationRecordInactive,
  isSyncProductMappingInactive,
  findSyncProductMapping,
  logIntegrationInactiveSkip,
  logSyncProductMappingInactiveSkip,
} = require("../utils/integrationActiveGuard");

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
    "Use fetch_product / fetch_category / fetch_brand / fetch_order / fetch_latest_order to import from the store; sync_* actions push one POS row to the store.",
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
      req.query.company_id ? normalizeCompanyId(req.query.company_id) : null;
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
  // "delete_product",
  "fetch_category",
  "sync_category",
  // "delete_category",
  "fetch_brand",
  "sync_brand",
  // "delete_brand",
  "fetch_order",
  "fetch_latest_order",
  "queue_bigcommerce_product_reset",
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
    limit:
      Number(row.limit) ||
      (String(row.action || "").trim() === "fetch_latest_order" ? 20 : 1),
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
  if (row.action === "queue_bigcommerce_product_reset" && !row.product_id) {
    return "product_id is required for queue_bigcommerce_product_reset.";
  }
  if (
    (row.action === "fetch_category" ||
      row.action === "fetch_products" ||
      row.action === "fetch_product" ||
      row.action === "fetch_brand" ||
      row.action === "fetch_order" ||
      row.action === "fetch_latest_order") &&
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
      if (normalized.integration_id) {
        const activeIntegration = await findIntegrationIfActive(
          normalized.integration_id,
          companyId,
        );
        if (!activeIntegration) {
          const skipError =
            "Integration is inactive — process was not queued.";
          failed.push({
            index,
            error: skipError,
            code: "INTEGRATION_INACTIVE",
            input: sourceRows[index],
            skipped: true,
          });
          await logIntegrationInactiveSkip(req, {
            action: normalized.action || "process",
            integrationId: normalized.integration_id,
            companyId,
            productId: normalized.product_id,
            createdBy,
            message: skipError,
            extra: {
              source: "process/bulk-create",
              index,
            },
          });
          continue;
        }
      }

      if (
        normalized.action === "sync_product" &&
        normalized.integration_id &&
        normalized.product_id
      ) {
        const mapping = await findSyncProductMapping({
          productId: normalized.product_id,
          integrationId: normalized.integration_id,
          companyId,
        });
        if (isSyncProductMappingInactive(mapping)) {
          const skipError =
            "sync_product mapping is inactive — process was not queued.";
          failed.push({
            index,
            error: skipError,
            code: "SYNC_PRODUCT_INACTIVE",
            input: sourceRows[index],
            skipped: true,
          });
          await logSyncProductMappingInactiveSkip(req, {
            action: "sync_product",
            integrationId: normalized.integration_id,
            companyId,
            productId: normalized.product_id,
            syncProductId: mapping?._id,
            createdBy,
            message: skipError,
            extra: {
              source: "process/bulk-create",
              index,
            },
          });
          continue;
        }
      }

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
              body.force === true || body.force === "1" || body.force === 1,
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

const RUNNABLE_PROCESS_STATUSES = new Set(["active", "pending"]);

function buildProcessEnqueueAllFilter({
  companyId,
  action,
  integrationId,
  progress,
}) {
  const companyCriteria = buildCompanyIdCriteria(companyId);
  const filter = {
    status: { $in: [...RUNNABLE_PROCESS_STATUSES] },
    progress: { $nin: ["completed", "failed"] },
    $and: [activeNotDeletedCriteria()],
  };
  if (companyCriteria) {
    filter.$and.push(companyCriteria);
  }
  if (action) {
    filter.action = action;
  }
  if (integrationId) {
    filter.integration_id = integrationId;
  }
  const progressFilter = String(progress || "").trim();
  if (progressFilter) {
    filter.progress = progressFilter;
  }
  return filter;
}

async function buildProcessEnqueueDiagnostics(companyId, filters = {}) {
  const companyCriteria = buildCompanyIdCriteria(companyId);
  const baseAnd = [activeNotDeletedCriteria()];
  if (companyCriteria) {
    baseAnd.push(companyCriteria);
  }

  const globalMatch = { $and: [activeNotDeletedCriteria()] };
  if (filters.action) globalMatch.action = filters.action;
  if (filters.integrationId) globalMatch.integration_id = filters.integrationId;
  if (filters.progress) globalMatch.progress = filters.progress;
  else {
    globalMatch.progress = { $nin: ["completed", "failed"] };
  }
  globalMatch.status = { $in: [...RUNNABLE_PROCESS_STATUSES] };

  const [forCompany, notStartedForCompany, activeNotStartedForCompany, otherCompanies] =
    await Promise.all([
      ProcessModel.aggregate([
        { $match: { $and: baseAnd } },
        {
          $group: {
            _id: { status: "$status", progress: "$progress" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ]),
      ProcessModel.countDocuments({
        $and: [...baseAnd, { progress: "not_started" }],
      }),
      ProcessModel.countDocuments({
        $and: [
          ...baseAnd,
          { status: "active", progress: "not_started" },
        ],
      }),
      ProcessModel.aggregate([
        { $match: globalMatch },
        { $group: { _id: "$company_id", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

  const otherCompaniesWithProcesses = otherCompanies.map((row) => ({
    company_id: row._id ? String(row._id) : null,
    count: row.count,
  }));

  const hints = [];
  if (notStartedForCompany > 0 && activeNotStartedForCompany === 0) {
    hints.push(
      "Found not_started rows but none with status=active. Edit them in Admin and set Status to Active, or pass progress=not_started (pending rows are auto-activated on enqueue).",
    );
  } else if (notStartedForCompany === 0) {
    hints.push(
      "No matching rows for this company_id. Your login token company may differ from the process rows in Admin.",
    );
    if (otherCompaniesWithProcesses.length > 0) {
      hints.push(
        `Pass company_id in the JSON body, e.g. "company_id": "${otherCompaniesWithProcesses[0].company_id}".`,
      );
    }
  }

  return {
    processes_for_company: forCompany.map((row) => ({
      status: row._id.status,
      progress: row._id.progress,
      count: row.count,
    })),
    not_started_for_company: notStartedForCompany,
    active_not_started_for_company: activeNotStartedForCompany,
    other_companies_with_processes: otherCompaniesWithProcesses,
    hints,
  };
}

/**
 * POST/GET /api/process/queue-enqueue-all
 *
 * Enqueue every eligible process row for a company (status active/pending,
 * progress not completed/failed). Optional filters: action, integration_id, progress.
 */
async function processEnqueueAll(req, res) {
  try {
    const body = normalizeProcessQueueBody(req.body);
    const companyId = coalesceObjectId(
      body.company_id || req.query?.company_id || req.user?.company_id,
    );

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "company_id is required (from auth user or request).",
      });
    }

    const action = String(body.action || req.query?.action || "").trim();
    if (action && !PROCESS_ACTIONS.has(action)) {
      return res.status(400).json({
        success: false,
        message: `Invalid action filter: ${action}`,
      });
    }

    const integrationId = coalesceObjectId(
      body.integration_id || req.query?.integration_id,
    );
    const progress = String(body.progress || req.query?.progress || "").trim();

    const filter = buildProcessEnqueueAllFilter({
      companyId,
      action: action || null,
      integrationId,
      progress,
    });

    const processDocs = await ProcessModel.find(filter)
      .sort({ priority: 1, createdAt: 1 })
      .lean();

    const enqueued = [];
    const skipped = [];
    const failed = [];
    const reactivated = [];

    for (const doc of processDocs) {
      let row = doc;
      if (String(doc.status || "") === "pending") {
        row = await ProcessModel.findByIdAndUpdate(
          doc._id,
          { status: "active" },
          { new: true },
        ).lean();
        reactivated.push(doc._id);
      }

      if (!shouldQueueProcess(row)) {
        skipped.push({
          _id: doc._id,
          action: doc.action,
          status: row?.status,
          progress: row?.progress,
          reason: "not_queueable",
        });
        continue;
      }

      try {
        const result = await enqueueProcess(row);
        if (result.queued) {
          enqueued.push({
            _id: doc._id,
            action: doc.action,
            priority: row.priority,
            backend: result.backend,
          });
        } else {
          skipped.push({
            _id: doc._id,
            action: doc.action,
            reason: "queue_unavailable",
          });
        }
      } catch (err) {
        failed.push({
          _id: doc._id,
          action: doc.action,
          error: err.message || "Enqueue failed",
        });
      }
    }

    const diagnostics =
      processDocs.length === 0 ?
        await buildProcessEnqueueDiagnostics(companyId, {
          action: action || null,
          integrationId,
          progress,
        })
      : null;

    const statusCode = failed.length > 0 && enqueued.length === 0 ? 500 : 200;
    return res.status(statusCode).json({
      success: enqueued.length > 0 || failed.length === 0,
      message:
        enqueued.length > 0 ?
          `Enqueued ${enqueued.length} process job(s). Call execute-process or run-queue-worker to run.`
        : processDocs.length === 0 ?
          "No eligible process records found for this company/filter."
        : "No process jobs were enqueued.",
      data: {
        summary: {
          total: processDocs.length,
          enqueued: enqueued.length,
          skipped: skipped.length,
          failed: failed.length,
          reactivated: reactivated.length,
        },
        filters: {
          company_id: companyId,
          action: action || null,
          integration_id: integrationId || null,
          progress: progress || null,
          status: [...RUNNABLE_PROCESS_STATUSES],
        },
        enqueued,
        skipped,
        failed,
        reactivated,
        diagnostics,
        queue_enabled: isQueueEnabled(),
        queue_key: `${String(companyId).toLowerCase()}:process`,
        execute_process_url: "/api/process/execute-process",
        run_queue_worker_url: "/api/process/run-queue-worker",
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to enqueue process jobs",
    });
  }
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

  attachProcessFailureHooks(req, res, process);

  try {
    return await runProcessAction(req, res, process);
  } catch (err) {
    console.error("[process] execute failed:", err?.response?.data || err?.message || err);
    if (!res.headersSent) {
      await recordProcessFailure(req, process, err);
      return res.status(500).json({
        success: false,
        message: extractProcessErrorMessage(err),
        process_id: process._id,
      });
    }
    throw err;
  }
}

async function runProcessAction(req, res, process) {
  const integration = process?.integration_id;
  if (integration && isIntegrationRecordInactive(integration)) {
    const integrationId =
      integration._id || integration.id || process.integration_id;
    const name = integration.name || String(integrationId || "");
    const msg = `Skipped ${process.action || "process"}: integration "${name}" is inactive`;
    await markProcessOutcome(process._id, "inactive", msg);
    await logIntegrationInactiveSkip(req, {
      action: process.action || "process",
      integrationId,
      integrationName: integration.name,
      companyId: process.company_id?._id || process.company_id,
      productId: process.product_id?._id || process.product_id,
      processId: process._id,
      createdBy: req.user?._id,
      message: msg,
      extra: { source: "execute_process" },
    });
    return res.status(200).json({
      success: true,
      skipped: true,
      code: "INTEGRATION_INACTIVE",
      message: msg,
      process_id: process._id,
    });
  }

  if (process.action === "sync_product") {
    const productId = process.product_id?._id || process.product_id;
    const integrationId =
      process.integration_id?._id ||
      process.integration_id?.id ||
      process.integration_id;
    const companyId = process.company_id?._id || process.company_id;
    const mapping = await findSyncProductMapping({
      productId,
      integrationId,
      companyId,
    });
    if (isSyncProductMappingInactive(mapping)) {
      const msg =
        "Skipped sync_product: sync_product mapping is inactive";
      await markProcessOutcome(process._id, "inactive", msg);
      await logSyncProductMappingInactiveSkip(req, {
        action: "sync_product",
        integrationId,
        companyId,
        productId,
        processId: process._id,
        syncProductId: mapping?._id,
        createdBy: req.user?._id,
        message: msg,
        extra: { source: "execute_process" },
      });
      return res.status(200).json({
        success: true,
        skipped: true,
        code: "SYNC_PRODUCT_INACTIVE",
        message: msg,
        process_id: process._id,
      });
    }
  }

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
    case "fetch_order": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_order,
        shopify: shopifyProcess.fetch_order,
      });
    }
    case "fetch_latest_order": {
      return dispatchByStoreType(req, res, process, {
        woocommerce: woocommerceProcess.fetch_latest_order,
        shopify: shopifyProcess.fetch_latest_order,
      });
    }
    case "queue_bigcommerce_product_reset": {
      return queue_bigcommerce_product_reset(req, res, process);
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
  const process = await loadActiveProcess(req);

  if (!process) {
    const details = await explainNoActiveProcess(req);
    res.status(400).json({ success: false, ...details });
    return res.getResult();
  }

  attachProcessFailureHooks(req, res, process);

  try {
    await runProcessAction(req, res, process);
  } catch (err) {
    console.error("[process] worker batch failed:", err?.response?.data || err?.message || err);
    if (!res.headersSent) {
      await recordProcessFailure(req, process, err);
      res.status(500).json({
        success: false,
        message: extractProcessErrorMessage(err),
        process_id: process._id,
      });
    }
  }

  return res.getResult();
}

async function runQueueWorker(req, res) {
  const {
    drainProcessQueue,
    getWorkerStatus,
    isCompanyDraining,
  } = require("../utils/processQueueWorker");
  const companyId = req.query.company_id || null;
  const status = await getWorkerStatus({
    companyId,
  });

  if (companyId) {
    if (isCompanyDraining(companyId)) {
      return res.status(409).json({
        success: false,
        message: "Queue worker is already running for this company.",
        data: status,
      });
    }
  } else if (
    status.draining &&
    Array.isArray(status.companies_draining) &&
    status.companies_draining.length >= (status.max_parallel_companies || 5)
  ) {
    return res.status(409).json({
      success: false,
      message: `Queue worker is at max parallel company capacity (${status.max_parallel_companies}).`,
      data: status,
    });
  }

  const result = await drainProcessQueue({
    companyId,
    processId: req.params.id || req.query.process_id,
    maxBatches: req.query.max_batches,
    user: req.user,
  });

  const batchesRun = result.batches_run || 0;
  const failedBatches = (result.results || []).filter((row) => row.success === false);
  const workerFailed = result.status === "error";

  return res.status(workerFailed ? 500 : 200).json({
    success: !workerFailed,
    message:
      workerFailed ?
        `Queue worker failed (${batchesRun} batch(es) run before error).`
      : `Queue worker finished (${batchesRun} batch(es) run).`,
    data: {
      ...result,
      failed_batches: failedBatches.length,
    },
  });
}

async function getQueueWorkerStatus(req, res) {
  const { getWorkerStatus } = require("../utils/processQueueWorker");
  return res.status(200).json({
    success: true,
    data: await getWorkerStatus({
      companyId: req.query?.company_id || req.params?.companyId || null,
    }),
  });
}

/**
 * Shared reset used by single + bulk restart.
 * Sets progress → not_started, status → active, clears counters, re-enqueues.
 */
async function restartProcessDocument(existing, req, { remarks = "" } = {}) {
  const processId = existing._id;
  const previous = {
    status: existing.status,
    progress: existing.progress,
    page: existing.page,
    offset: existing.offset,
    count: existing.count,
    hits: existing.hits,
  };

  const updated = await ProcessModel.findByIdAndUpdate(
    processId,
    {
      $set: {
        status: "active",
        progress: "not_started",
        page: 1,
        offset: 0,
        count: 0,
        hits: 0,
        remarks,
        ...(req.user?._id ?
          { updated_by: coalesceObjectId(req.user._id) }
        : {}),
      },
    },
    { new: true, runValidators: true },
  ).lean();

  if (
    !updated ||
    updated.progress !== "not_started" ||
    updated.status !== "active"
  ) {
    const err = new Error(
      "Process restart did not persist progress=not_started / status=active.",
    );
    err.statusCode = 500;
    err.data = { process: updated, previous };
    throw err;
  }

  await releaseProcessFromQueue(updated);
  const queue = await enqueueProcess(updated, { scheduleDrain: false });

  return { updated, previous, queue };
}

/**
 * POST/GET /api/process/restart-all
 * Restart processes with progress failed or not_started.
 * If company_id is omitted, restarts matching processes for ALL companies.
 *
 * Body/query/path optional:
 * - company_id / :companyId — scope to one company; omit to restart all
 * - action, integration_id filters
 * - remarks → custom restart remarks
 * - execute=true → run one execute-process batch after restarting all
 */
async function processRestartAll(req, res) {
  try {
    const body = normalizeProcessQueueBody(req.body);
    // Only explicit company_id scopes the restart; no auth-user fallback
    // so omitting company_id truly means "all companies".
    const companyId = coalesceObjectId(
      req.params?.companyId ||
        req.params?.company_id ||
        body.company_id ||
        req.query?.company_id,
    );

    const action = String(body.action || req.query?.action || "").trim();
    if (action && !PROCESS_ACTIONS.has(action)) {
      return res.status(400).json({
        success: false,
        message: `Invalid action filter: ${action}`,
      });
    }

    const integrationId = coalesceObjectId(
      body.integration_id || req.query?.integration_id,
    );

    const filter = {
      progress: { $in: ["failed", "not_started"] },
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      const companyCriteria = buildCompanyIdCriteria(companyId);
      if (companyCriteria) {
        filter.$and.push(companyCriteria);
      }
    }
    if (action) {
      filter.action = action;
    }
    if (integrationId) {
      filter.integration_id = integrationId;
    }

    const processDocs = await ProcessModel.find(filter)
      .sort({ priority: 1, createdAt: 1 })
      .lean();

    const customRemarks = String(
      body.remarks ?? req.query?.remarks ?? "",
    ).trim();
    const remarks = customRemarks || "";

    const restarted = [];
    const failed = [];

    for (const doc of processDocs) {
      try {
        const { updated, previous, queue } = await restartProcessDocument(
          doc,
          req,
          { remarks },
        );
        restarted.push({
          _id: updated._id,
          action: updated.action,
          company_id: updated.company_id,
          status: updated.status,
          progress: updated.progress,
          previous,
          queue,
        });
      } catch (err) {
        failed.push({
          _id: doc._id,
          action: doc.action,
          company_id: doc.company_id,
          error: err.message || "Restart failed",
        });
      }
    }

    const shouldExecute =
      body.execute === true ||
      body.execute === "1" ||
      body.execute === 1 ||
      req.query?.execute === "true" ||
      req.query?.execute === "1";

    if (shouldExecute && restarted.length > 0) {
      return execute_process(req, res);
    }

    const statusCode =
      failed.length > 0 && restarted.length === 0 ? 500 : 200;

    const scopeLabel = companyId ? "this company/filter" : "any company";

    return res.status(statusCode).json({
      success: restarted.length > 0 || failed.length === 0,
      message:
        restarted.length > 0 ?
          `Restarted ${restarted.length} process(es) (failed/not_started → not_started + active)${companyId ? "" : " across all companies"}. Call execute-process or run-queue-worker to run.`
        : `No failed or not_started process records found for ${scopeLabel}.`,
      data: {
        summary: {
          total: processDocs.length,
          restarted: restarted.length,
          failed: failed.length,
        },
        filters: {
          company_id: companyId || null,
          all_companies: !companyId,
          action: action || null,
          integration_id: integrationId || null,
          progress: ["failed", "not_started"],
        },
        restarted,
        failed,
        queue_enabled: isQueueEnabled(),
        queue_key:
          companyId ? `${String(companyId).toLowerCase()}:process` : null,
        execute_process_url: "/api/process/execute-process",
        run_queue_worker_url: "/api/process/run-queue-worker",
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to restart processes",
    });
  }
}

/**
 * POST/GET /api/process/restart-process/:id
 * Reset a completed/failed/inactive (or stuck) process so it can run again.
 * Always sets progress → not_started and status → active.
 *
 * Body/query optional:
 * - execute=true → run one execute-process batch after restart
 * - remarks → custom restart remarks
 */
async function processRestart(req, res) {
  try {
    const processId = coalesceObjectId(
      req.params?.id ||
        req.body?.process_id ||
        req.body?.id ||
        req.query?.process_id ||
        req.query?.id,
    );

    if (!processId) {
      return res.status(400).json({
        success: false,
        message:
          "process_id is required. Use /process/restart-process/:id or pass process_id.",
      });
    }

    const companyId = coalesceObjectId(
      req.body?.company_id || req.query?.company_id || req.user?.company_id,
    );

    const filter = {
      _id: processId,
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      const companyCriteria = buildCompanyIdCriteria(companyId);
      if (companyCriteria) {
        filter.$and.push(companyCriteria);
      }
    }

    const existing = await ProcessModel.findOne(filter).lean();
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: companyId
          ? "Process not found for this company, or it was deleted."
          : "Process not found, or it was deleted.",
      });
    }

    // Clear remarks so the next execute writes a fresh outcome message.
    // Optional body/query `remarks` still allows an explicit override.
    const customRemarks = String(
      req.body?.remarks ?? req.query?.remarks ?? "",
    ).trim();
    const remarks = customRemarks || "";

    // Use findByIdAndUpdate (not save) so post("save") does not auto-drain
    // the queue worker and immediately overwrite progress again.
    const { updated, previous, queue } = await restartProcessDocument(
      existing,
      req,
      { remarks },
    );

    const shouldExecute =
      req.body?.execute === true ||
      req.body?.execute === "1" ||
      req.body?.execute === 1 ||
      req.query?.execute === "true" ||
      req.query?.execute === "1";

    if (shouldExecute) {
      req.params = { ...(req.params || {}), id: String(processId) };
      req.query = { ...(req.query || {}), process_id: String(processId) };
      return execute_process(req, res);
    }

    return res.status(200).json({
      success: true,
      message:
        queue.queued ?
          "Process restarted: progress set to not_started, status active, and enqueued. Call execute-process or run-queue-worker to run."
        : "Process restarted: progress set to not_started and status active. Call execute-process to run.",
      data: {
        progress: updated.progress,
        status: updated.status,
        process: {
          _id: updated._id,
          action: updated.action,
          status: updated.status,
          progress: updated.progress,
          page: updated.page,
          offset: updated.offset,
          count: updated.count,
          hits: updated.hits,
          remarks: updated.remarks,
          priority: updated.priority,
        },
        previous,
        queue,
        execute_process_url: `/api/process/execute-process/${processId}`,
        run_queue_worker_url: `/api/process/run-queue-worker/${processId}`,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || "Failed to restart process",
      ...(err.data ? { data: err.data } : {}),
    });
  }
}

module.exports = {
  execute_process,
  runProcessExecution,
  loadActiveProcess,
  runQueueWorker,
  getQueueWorkerStatus,
  processBulkCreate,
  processQueueCreate,
  processEnqueueAll,
  processFetchProductQueue,
  processQueueFormSchema,
  processRestart,
  processRestartAll,
};

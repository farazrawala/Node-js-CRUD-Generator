const {
  isQueueEnabled,
  getProcessQueueRemaining,
  PROCESS_MODULE,
} = require("./processQueue");
const {
  normalizeCompanyId,
  listQueueTenants,
  getQueueLength,
} = require("./redisQueue");

/** @type {Map<string, { companyId: string, draining: boolean, currentRun: object|null, timingStats: object }>} */
const lanes = new Map();

/** @type {Map<string, NodeJS.Timeout>} */
const debounceTimers = new Map();

let pollTimer = null;

const SLOW_BATCH_MS = Number(process.env.PROCESS_QUEUE_SLOW_BATCH_MS || 30000);
const STUCK_BATCH_MS = Number(
  process.env.PROCESS_QUEUE_STUCK_BATCH_MS || 120000,
);

function getMaxParallelCompanies() {
  const n = Number(process.env.PROCESS_QUEUE_MAX_PARALLEL_COMPANIES || 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessQueueWorkerEnabled() {
  const flag = String(process.env.PROCESS_QUEUE_WORKER_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") {
    return false;
  }
  return isQueueEnabled();
}

function createEmptyTimingStats() {
  return {
    batch_started_at: null,
    last_batch_ms: null,
    last_batch_success: null,
    last_batch_message: null,
    batch_durations_ms: [],
    same_process_batches: 0,
    last_process_id: null,
    last_page: null,
    page_unchanged_batches: 0,
  };
}

function getOrCreateLane(companyId) {
  const key = normalizeCompanyId(companyId);
  if (!key) return null;
  let lane = lanes.get(key);
  if (!lane) {
    lane = {
      companyId: key,
      draining: false,
      currentRun: null,
      timingStats: createEmptyTimingStats(),
    };
    lanes.set(key, lane);
  }
  return lane;
}

function isCompanyDraining(companyId) {
  const key = normalizeCompanyId(companyId);
  if (!key) return false;
  return Boolean(lanes.get(key)?.draining);
}

function countDrainingCompanies() {
  let n = 0;
  for (const lane of lanes.values()) {
    if (lane.draining) n += 1;
  }
  return n;
}

function listDrainingLanes() {
  return [...lanes.values()].filter((lane) => lane.draining);
}

function resetTimingStats(lane) {
  lane.timingStats = createEmptyTimingStats();
}

function clearCurrentRun(lane) {
  lane.currentRun = null;
  lane.timingStats.batch_started_at = null;
}

function setCurrentRun(lane, partial = {}) {
  const now = Date.now();
  if (!lane.currentRun) {
    lane.currentRun = {
      process_id: null,
      company_id: lane.companyId || null,
      action: null,
      progress: null,
      status: null,
      product_id: null,
      product_name: null,
      category_id: null,
      category_name: null,
      brand_id: null,
      brand_name: null,
      integration_id: null,
      page: null,
      hits: null,
      remarks: null,
      started_at: now,
      batch_index: 0,
      ...partial,
    };
    return;
  }
  lane.currentRun = { ...lane.currentRun, ...partial };
}

function idFromRef(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    if (value._id != null) return String(value._id);
    if (typeof value.toString === "function") {
      const asString = String(value);
      if (asString && asString !== "[object Object]") return asString;
    }
    return null;
  }
  return String(value);
}

function nameFromProductRef(value) {
  if (!value || typeof value !== "object") return null;
  return value.product_name || value.name || value.sku || null;
}

function nameFromCategoryRef(value) {
  if (!value || typeof value !== "object") return null;
  return value.name || value.category_name || null;
}

function nameFromBrandRef(value) {
  if (!value || typeof value !== "object") return null;
  return value.name || value.brand_name || null;
}

function applyProcessToCurrentRun(lane, process) {
  if (!process || !lane) return;
  const timingStats = lane.timingStats;
  const currentRun = lane.currentRun;
  const processId = idFromRef(process._id) || currentRun?.process_id || null;
  const page = process.page ?? currentRun?.page ?? null;
  const productId = idFromRef(process.product_id);
  const categoryId = idFromRef(process.category_id);
  const brandId = idFromRef(process.brand_id);

  if (processId && processId === timingStats.last_process_id) {
    timingStats.same_process_batches += 1;
  } else {
    timingStats.same_process_batches = 1;
    timingStats.last_process_id = processId;
    timingStats.page_unchanged_batches = 0;
  }

  if (
    processId &&
    processId === timingStats.last_process_id &&
    page != null &&
    timingStats.last_page != null &&
    Number(page) === Number(timingStats.last_page)
  ) {
    timingStats.page_unchanged_batches += 1;
  } else if (page != null) {
    timingStats.page_unchanged_batches = 0;
  }
  timingStats.last_page = page;

  const productName =
    nameFromProductRef(process.product_id) ||
    (productId && productId === currentRun?.product_id ?
      currentRun?.product_name
    : null) ||
    null;
  const categoryName =
    nameFromCategoryRef(process.category_id) ||
    (categoryId && categoryId === currentRun?.category_id ?
      currentRun?.category_name
    : null) ||
    null;
  const brandName =
    nameFromBrandRef(process.brand_id) ||
    (brandId && brandId === currentRun?.brand_id ?
      currentRun?.brand_name
    : null) ||
    null;

  setCurrentRun(lane, {
    process_id: processId,
    company_id:
      idFromRef(process.company_id) ||
      currentRun?.company_id ||
      lane.companyId ||
      null,
    action: process.action || currentRun?.action || null,
    progress: process.progress || currentRun?.progress || null,
    status: process.status || currentRun?.status || null,
    product_id: productId,
    product_name: productName,
    category_id: categoryId,
    category_name: categoryName,
    brand_id: brandId,
    brand_name: brandName,
    integration_id: idFromRef(process.integration_id),
    page,
    hits: process.hits ?? currentRun?.hits ?? null,
    remarks:
      process.remarks != null ?
        String(process.remarks)
      : currentRun?.remarks || null,
  });
}

async function hydrateCurrentRunNames(lane) {
  if (!lane?.currentRun) return;
  const currentRun = lane.currentRun;

  try {
    if (currentRun.product_id && !currentRun.product_name) {
      const Product = require("../models/product");
      const product = await Product.findById(currentRun.product_id)
        .select("product_name name sku")
        .lean();
      if (product) {
        setCurrentRun(lane, {
          product_name:
            product.product_name || product.name || product.sku || null,
        });
      }
    }

    if (currentRun.category_id && !currentRun.category_name) {
      const Category = require("../models/category");
      const category = await Category.findById(currentRun.category_id)
        .select("name category_name")
        .lean();
      if (category) {
        setCurrentRun(lane, {
          category_name: category.name || category.category_name || null,
        });
      }
    }

    if (currentRun.brand_id && !currentRun.brand_name) {
      const Brand = require("../models/brands");
      const brand = await Brand.findById(currentRun.brand_id)
        .select("name brand_name")
        .lean();
      if (brand) {
        setCurrentRun(lane, {
          brand_name: brand.name || brand.brand_name || null,
        });
      }
    }
  } catch (err) {
    console.warn(
      "[process-queue-worker] name hydrate failed:",
      err?.message || err,
    );
  }
}

function formatRunningFor(startedAt) {
  if (!startedAt) return null;
  const ms = Math.max(0, Date.now() - startedAt);
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const human =
    hours > 0 ? `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0 ? `${minutes}m ${seconds}s`
    : `${seconds}s`;
  return { ms, seconds: totalSec, human };
}

function average(nums) {
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function buildWhySlow(lane, { remaining_in_db, remaining_in_queue }) {
  const reasons = [];
  const timingStats = lane?.timingStats || createEmptyTimingStats();
  const currentRun = lane?.currentRun || null;
  const draining = Boolean(lane?.draining);
  const batchDelay = Number(
    process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000,
  );
  const durations = timingStats.batch_durations_ms || [];
  const avgMs = average(durations);
  const currentBatchMs =
    timingStats.batch_started_at ?
      Math.max(0, Date.now() - timingStats.batch_started_at)
    : null;

  if (remaining_in_db >= 1000) {
    reasons.push({
      code: "large_backlog",
      severity: "info",
      message: `${remaining_in_db} process row(s) still pending in DB. Each sync_product/fetch job is usually one API round-trip, so a large backlog takes a long time.`,
    });
  }

  if (remaining_in_queue === 0 && remaining_in_db > 0) {
    reasons.push({
      code: "queue_empty_db_fallback",
      severity: "warning",
      message:
        "Redis queue is empty but Mongo still has pending rows. Worker falls back to DB one-by-one (slower than a primed queue). Run restart-all or queue-enqueue-all to refill Redis.",
    });
  }

  if (currentRun?.action === "sync_product" && remaining_in_db > 100) {
    reasons.push({
      code: "many_sync_product_jobs",
      severity: "info",
      message:
        "Many sync_product jobs: each product is a separate process row and store API call. Throughput ≈ 1 product per batch (+ delay).",
    });
  }

  if (batchDelay >= 1000 && remaining_in_db > 50) {
    reasons.push({
      code: "batch_delay",
      severity: "info",
      message: `PROCESS_QUEUE_WORKER_BATCH_DELAY_MS=${batchDelay} adds ~${batchDelay}ms between batches. With ${remaining_in_db} remaining, delay alone is ~${Math.round((remaining_in_db * batchDelay) / 60000)} min.`,
    });
  }

  if (currentBatchMs != null && currentBatchMs >= STUCK_BATCH_MS) {
    reasons.push({
      code: "current_batch_stuck",
      severity: "error",
      message: `Current execute-process batch has been running for ${formatRunningFor(timingStats.batch_started_at)?.human}. Likely waiting on a slow/hanging store API (Shopify/WooCommerce) or network.`,
    });
  } else if (currentBatchMs != null && currentBatchMs >= SLOW_BATCH_MS) {
    reasons.push({
      code: "current_batch_slow",
      severity: "warning",
      message: `Current batch already ${formatRunningFor(timingStats.batch_started_at)?.human} — store API or DB work is slow.`,
    });
  }

  if (avgMs != null && avgMs >= SLOW_BATCH_MS) {
    reasons.push({
      code: "avg_batch_slow",
      severity: "warning",
      message: `Average batch duration is ${Math.round(avgMs / 1000)}s. Store API latency or heavy sync logic is the bottleneck.`,
    });
  }

  if (timingStats.same_process_batches >= 5) {
    reasons.push({
      code: "same_process_repeated",
      severity: "warning",
      message: `Same process_id has run for ${timingStats.same_process_batches} batches in a row (multi-page fetch or stuck job).`,
    });
  }

  if (timingStats.page_unchanged_batches >= 3) {
    reasons.push({
      code: "page_not_advancing",
      severity: "error",
      message: `Process page stayed at ${timingStats.last_page} for ${timingStats.page_unchanged_batches} batches — job may be stuck or not updating progress.`,
    });
  }

  if (currentRun?.remarks) {
    const remarks = String(currentRun.remarks);
    if (/fail|error|timeout|429|rate.?limit|ECONN|ENOTFOUND/i.test(remarks)) {
      reasons.push({
        code: "process_remarks_error",
        severity: "error",
        message: `Process remarks suggest a problem: ${remarks.slice(0, 300)}`,
      });
    }
  }

  if (
    timingStats.last_batch_success === false &&
    timingStats.last_batch_message
  ) {
    reasons.push({
      code: "last_batch_failed",
      severity: "error",
      message: `Last batch failed: ${String(timingStats.last_batch_message).slice(0, 300)}`,
    });
  }

  let eta = null;
  if (remaining_in_db > 0 && avgMs != null) {
    const perJobMs = avgMs + batchDelay;
    const etaMs = remaining_in_db * perJobMs;
    eta = {
      ms: etaMs,
      seconds: Math.floor(etaMs / 1000),
      human: formatRunningFor(Date.now() - etaMs)?.human || null,
      based_on: "avg_batch_ms + batch_delay",
      avg_batch_ms: avgMs,
      batch_delay_ms: batchDelay,
      remaining: remaining_in_db,
    };
  } else if (remaining_in_db > 0 && !avgMs) {
    const perJobMs = 2000 + batchDelay;
    const etaMs = remaining_in_db * perJobMs;
    eta = {
      ms: etaMs,
      seconds: Math.floor(etaMs / 1000),
      human: formatRunningFor(Date.now() - etaMs)?.human || null,
      based_on: "estimate_2s_per_job + batch_delay",
      avg_batch_ms: null,
      batch_delay_ms: batchDelay,
      remaining: remaining_in_db,
    };
    reasons.push({
      code: "eta_rough",
      severity: "info",
      message: `Rough ETA ~${eta.human} assuming ~2s/job + ${batchDelay}ms delay (no completed batches yet to measure).`,
    });
  }

  if (!reasons.length && draining) {
    reasons.push({
      code: "normal",
      severity: "info",
      message: "No obvious stall detected; work is progressing.",
    });
  }

  const severityRank = { error: 3, warning: 2, info: 1 };
  reasons.sort(
    (a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0),
  );

  return {
    is_slow:
      reasons.some((r) => r.severity === "warning" || r.severity === "error") ||
      remaining_in_db >= 500,
    primary_reason: reasons[0]?.message || null,
    reasons,
    eta,
    timing: {
      current_batch_ms: currentBatchMs,
      current_batch_running_for:
        timingStats.batch_started_at ?
          formatRunningFor(timingStats.batch_started_at)
        : null,
      last_batch_ms: timingStats.last_batch_ms,
      avg_batch_ms: avgMs,
      batches_timed: durations.length,
      same_process_batches: timingStats.same_process_batches,
      page_unchanged_batches: timingStats.page_unchanged_batches,
      batch_delay_ms: batchDelay,
      slow_batch_threshold_ms: SLOW_BATCH_MS,
      stuck_batch_threshold_ms: STUCK_BATCH_MS,
      last_batch_success: timingStats.last_batch_success,
      last_batch_message: timingStats.last_batch_message,
    },
  };
}

function serializeLaneStatus(lane) {
  const currentRun = lane?.currentRun || null;
  const running_for =
    currentRun?.started_at ? formatRunningFor(currentRun.started_at) : null;
  return {
    company_id: lane?.companyId || currentRun?.company_id || null,
    draining: Boolean(lane?.draining),
    current_process_id: currentRun?.process_id || null,
    current_company_id: currentRun?.company_id || lane?.companyId || null,
    current_action: currentRun?.action || null,
    current_progress: currentRun?.progress || null,
    current_status: currentRun?.status || null,
    current_product_id: currentRun?.product_id || null,
    current_product_name: currentRun?.product_name || null,
    current_category_id: currentRun?.category_id || null,
    current_category_name: currentRun?.category_name || null,
    current_brand_id: currentRun?.brand_id || null,
    current_brand_name: currentRun?.brand_name || null,
    current_integration_id: currentRun?.integration_id || null,
    current_page: currentRun?.page ?? null,
    current_hits: currentRun?.hits ?? null,
    current_remarks: currentRun?.remarks || null,
    started_at:
      currentRun?.started_at ?
        new Date(currentRun.started_at).toISOString()
      : null,
    running_for,
    batch_index: currentRun?.batch_index ?? null,
  };
}

async function resolveCompanyIdFromOptions(options = {}) {
  const direct = normalizeCompanyId(options.companyId);
  if (direct) return direct;

  const processId = options.processId ? String(options.processId) : null;
  if (!processId) return null;

  try {
    const ProcessModel = require("../models/process");
    const row = await ProcessModel.findById(processId)
      .select("company_id")
      .lean();
    return normalizeCompanyId(idFromRef(row?.company_id));
  } catch (err) {
    console.warn(
      "[process-queue-worker] resolve company from process failed:",
      err?.message || err,
    );
    return null;
  }
}

/**
 * Companies with Redis queue length > 0 and/or Mongo pending process rows.
 */
async function discoverCompaniesNeedingWork() {
  const companyIds = new Set();

  try {
    const tenants = await listQueueTenants(PROCESS_MODULE);
    for (const tenant of tenants) {
      const key = normalizeCompanyId(tenant);
      if (!key) continue;
      const length = await getQueueLength(key, PROCESS_MODULE);
      if (length > 0) companyIds.add(key);
    }
  } catch (err) {
    console.warn(
      "[process-queue-worker] queue tenant discovery failed:",
      err?.message || err,
    );
  }

  try {
    const ProcessModel = require("../models/process");
    const { activeNotDeletedCriteria } = require("./modelHelper");
    const rows = await ProcessModel.aggregate([
      {
        $match: {
          progress: { $in: ["not_started", "started"] },
          status: { $in: ["active", "pending"] },
          $and: [activeNotDeletedCriteria()],
        },
      },
      { $group: { _id: "$company_id" } },
      { $limit: 200 },
    ]);
    for (const row of rows) {
      const key = normalizeCompanyId(idFromRef(row._id));
      if (key) companyIds.add(key);
    }
  } catch (err) {
    console.warn(
      "[process-queue-worker] db company discovery failed:",
      err?.message || err,
    );
  }

  return [...companyIds];
}

async function getWorkerStatus(options = {}) {
  const drainingLanes = listDrainingLanes();
  const scopedCompanyId = normalizeCompanyId(options.companyId);
  const primaryLane =
    (scopedCompanyId && lanes.get(scopedCompanyId)) || drainingLanes[0] || null;
  const primaryStatus = serializeLaneStatus(primaryLane);
  const anyDraining = drainingLanes.length > 0;

  let remaining_in_queue = 0;
  let remaining_in_db = 0;
  let remaining_by_company = [];

  try {
    const queueRemaining = await getProcessQueueRemaining(
      options.companyId || null,
    );
    remaining_in_queue = queueRemaining.remaining;
  } catch (err) {
    console.warn(
      "[process-queue-worker] queue remaining count failed:",
      err?.message || err,
    );
  }

  try {
    const ProcessModel = require("../models/process");
    const {
      activeNotDeletedCriteria,
      coalesceObjectId,
    } = require("./modelHelper");
    const companyId = coalesceObjectId(options.companyId);

    const dbMatch = {
      progress: { $in: ["not_started", "started"] },
      status: { $in: ["active", "pending"] },
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      dbMatch.$and.push({
        $or: [{ company_id: companyId }, { company_id: String(companyId) }],
      });
    }

    const [total, byCompany] = await Promise.all([
      ProcessModel.countDocuments(dbMatch),
      ProcessModel.aggregate([
        { $match: dbMatch },
        { $group: { _id: "$company_id", remaining: { $sum: 1 } } },
        { $sort: { remaining: -1 } },
        { $limit: 50 },
      ]),
    ]);

    remaining_in_db = total;
    remaining_by_company = byCompany.map((row) => ({
      company_id: row._id != null ? String(row._id) : null,
      remaining: row.remaining,
    }));
  } catch (err) {
    console.warn(
      "[process-queue-worker] db remaining count failed:",
      err?.message || err,
    );
  }

  const why_slow = buildWhySlow(primaryLane, {
    remaining_in_db,
    remaining_in_queue,
  });

  return {
    enabled: isProcessQueueWorkerEnabled(),
    draining: anyDraining,
    parallel_companies_enabled: true,
    max_parallel_companies: getMaxParallelCompanies(),
    companies_draining: drainingLanes.map(serializeLaneStatus),
    queue_enabled: isQueueEnabled(),
    current_process_id: primaryStatus.current_process_id,
    current_company_id: primaryStatus.current_company_id,
    current_action: primaryStatus.current_action,
    current_progress: primaryStatus.current_progress,
    current_status: primaryStatus.current_status,
    current_product_id: primaryStatus.current_product_id,
    current_product_name: primaryStatus.current_product_name,
    current_category_id: primaryStatus.current_category_id,
    current_category_name: primaryStatus.current_category_name,
    current_brand_id: primaryStatus.current_brand_id,
    current_brand_name: primaryStatus.current_brand_name,
    current_integration_id: primaryStatus.current_integration_id,
    current_page: primaryStatus.current_page,
    current_hits: primaryStatus.current_hits,
    current_remarks: primaryStatus.current_remarks,
    started_at: primaryStatus.started_at,
    running_for: primaryStatus.running_for,
    batch_index: primaryStatus.batch_index,
    remaining_processes: remaining_in_db,
    remaining_in_db,
    remaining_in_queue,
    remaining_by_company,
    why_slow,
  };
}

function buildWorkerReq({ companyId, processId, user } = {}) {
  const req = {
    query: {},
    params: {},
    body: {},
    user: user || null,
  };
  if (companyId) req.query.company_id = String(companyId);
  if (processId) {
    req.params.id = String(processId);
    req.query.process_id = String(processId);
  }
  return req;
}

function summarizeBatchResult(result) {
  const data = result?.body?.data || {};
  return {
    success: result?.success,
    statusCode: result?.statusCode,
    process_id: data.process_id || result?.body?.process_id || null,
    company_id: data.company_id || null,
    action: data.action || null,
    progress: data.progress || null,
    status: data.status || null,
    product_id: data.product_id || null,
    category_id: data.category_id || null,
    brand_id: data.brand_id || null,
    message: result?.body?.message || result?.body?.error || null,
  };
}

function shouldStopDrain(result) {
  if (!result) return true;
  if (
    result.statusCode === 400 &&
    String(result.body?.message || "").includes("No active process")
  ) {
    return true;
  }
  return false;
}

/**
 * Drain one company lane until empty / finished / maxBatches.
 */
async function drainCompanyLane(companyId, options = {}) {
  const lane = getOrCreateLane(companyId);
  if (!lane) {
    return {
      status: "error",
      error: "Invalid companyId",
      company_id: null,
      batches_run: 0,
      results: [],
    };
  }

  if (lane.draining) {
    return {
      status: "busy",
      company_id: lane.companyId,
      ...(await getWorkerStatus({ companyId: lane.companyId })),
    };
  }

  lane.draining = true;
  resetTimingStats(lane);
  setCurrentRun(lane, {
    process_id: options.processId ? String(options.processId) : null,
    company_id: lane.companyId,
    started_at: Date.now(),
    batch_index: 0,
  });

  const results = [];
  const batchDelay = Number(
    process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000,
  );
  const maxBatches = Number(
    options.maxBatches || process.env.PROCESS_QUEUE_WORKER_MAX_BATCHES || 5000,
  );
  const scopedProcessId = options.processId || null;
  const scopedCompanyId = lane.companyId;

  try {
    const {
      runProcessExecution,
      loadActiveProcess,
    } = require("../controllers/process");

    for (let i = 0; i < maxBatches; i += 1) {
      setCurrentRun(lane, { batch_index: i + 1 });

      let processIdForBatch = scopedProcessId || null;
      try {
        const probeReq = buildWorkerReq({
          companyId: scopedCompanyId,
          processId: scopedProcessId,
          user: options.user,
        });
        const activeProcess = await loadActiveProcess(probeReq);
        if (activeProcess) {
          applyProcessToCurrentRun(lane, activeProcess);
          await hydrateCurrentRunNames(lane);
          processIdForBatch = idFromRef(activeProcess._id) || processIdForBatch;
        } else if (scopedProcessId) {
          setCurrentRun(lane, {
            process_id: String(scopedProcessId),
            company_id: scopedCompanyId,
          });
        }
      } catch (peekErr) {
        console.warn(
          "[process-queue-worker] pre-batch process resolve failed:",
          peekErr?.message || peekErr,
        );
      }

      const req = buildWorkerReq({
        companyId: scopedCompanyId,
        processId: processIdForBatch,
        user: options.user,
      });

      const batchStartedAt = Date.now();
      lane.timingStats.batch_started_at = batchStartedAt;

      try {
        const result = await runProcessExecution(req);
        const batchMs = Math.max(0, Date.now() - batchStartedAt);
        lane.timingStats.last_batch_ms = batchMs;
        lane.timingStats.batch_durations_ms.push(batchMs);
        if (lane.timingStats.batch_durations_ms.length > 50) {
          lane.timingStats.batch_durations_ms.shift();
        }
        lane.timingStats.batch_started_at = null;

        const summary = summarizeBatchResult(result);
        lane.timingStats.last_batch_success = summary.success !== false;
        lane.timingStats.last_batch_message = summary.message || null;
        results.push(summary);

        if (summary.process_id || summary.progress || summary.status) {
          setCurrentRun(lane, {
            process_id:
              summary.process_id != null ?
                String(summary.process_id)
              : lane.currentRun?.process_id || null,
            company_id:
              summary.company_id != null ?
                String(summary.company_id)
              : lane.currentRun?.company_id || scopedCompanyId,
            action: summary.action || lane.currentRun?.action || null,
            progress: summary.progress || lane.currentRun?.progress || null,
            status: summary.status || lane.currentRun?.status || null,
            product_id:
              summary.product_id != null ?
                String(summary.product_id)
              : lane.currentRun?.product_id || null,
            category_id:
              summary.category_id != null ?
                String(summary.category_id)
              : lane.currentRun?.category_id || null,
            brand_id:
              summary.brand_id != null ?
                String(summary.brand_id)
              : lane.currentRun?.brand_id || null,
          });
        }

        if (lane.currentRun?.process_id) {
          try {
            const ProcessModel = require("../models/process");
            const row = await ProcessModel.findById(lane.currentRun.process_id)
              .select(
                "action progress status company_id product_id category_id brand_id integration_id page hits remarks",
              )
              .populate([
                { path: "product_id", select: "product_name name sku" },
                { path: "category_id", select: "name category_name" },
                { path: "brand_id", select: "name brand_name" },
              ])
              .lean();
            if (row) {
              applyProcessToCurrentRun(lane, row);
              await hydrateCurrentRunNames(lane);
            }
          } catch (_) {
            /* ignore refresh errors */
          }
        }

        if (shouldStopDrain(result)) {
          break;
        }

        if (scopedProcessId) {
          const data = result.body?.data || {};
          if (
            data.status === "completed" ||
            data.status === "failed" ||
            data.progress === "completed" ||
            data.progress === "failed"
          ) {
            break;
          }
        }
      } catch (err) {
        const batchMs = Math.max(0, Date.now() - batchStartedAt);
        lane.timingStats.last_batch_ms = batchMs;
        lane.timingStats.batch_durations_ms.push(batchMs);
        if (lane.timingStats.batch_durations_ms.length > 50) {
          lane.timingStats.batch_durations_ms.shift();
        }
        lane.timingStats.batch_started_at = null;
        lane.timingStats.last_batch_success = false;
        lane.timingStats.last_batch_message =
          err?.response?.data?.message || err?.message || String(err);

        console.warn(
          "[process-queue-worker] batch failed:",
          lane.timingStats.last_batch_message,
        );
        results.push({
          success: false,
          statusCode: err?.response?.status || 500,
          process_id: lane.currentRun?.process_id || null,
          company_id: lane.currentRun?.company_id || scopedCompanyId,
          action: lane.currentRun?.action || null,
          progress: null,
          status: null,
          message: lane.timingStats.last_batch_message,
        });
      }

      if (batchDelay > 0) {
        await sleep(batchDelay);
      }
    }
  } catch (err) {
    console.warn("[process-queue-worker] drain failed:", err?.message || err);
    lane.draining = false;
    clearCurrentRun(lane);
    return {
      status: "error",
      error: err?.message || String(err),
      company_id: scopedCompanyId,
      batches_run: results.length,
      results,
      ...(await getWorkerStatus({ companyId: scopedCompanyId })),
    };
  } finally {
    lane.draining = false;
    clearCurrentRun(lane);
  }

  return {
    status: "done",
    company_id: scopedCompanyId,
    batches_run: results.length,
    results,
    ...(await getWorkerStatus({ companyId: scopedCompanyId })),
  };
}

/**
 * Run process batches until the queue is empty, the job finishes, or maxBatches is hit.
 * With companyId/processId: drain that company only.
 * Without: discover companies needing work and drain up to max parallel in parallel.
 */
async function drainProcessQueue(options = {}) {
  let companyId = normalizeCompanyId(options.companyId);
  if (!companyId && options.processId) {
    companyId = await resolveCompanyIdFromOptions(options);
  }

  if (companyId || options.processId) {
    if (!companyId) {
      return {
        status: "error",
        error: "Could not resolve companyId for process",
        batches_run: 0,
        results: [],
        ...(await getWorkerStatus()),
      };
    }
    return drainCompanyLane(companyId, {
      ...options,
      companyId,
    });
  }

  const maxParallel = getMaxParallelCompanies();
  const companies = await discoverCompaniesNeedingWork();
  const slots = Math.max(0, maxParallel - countDrainingCompanies());
  const toStart = companies
    .filter((id) => !isCompanyDraining(id))
    .slice(0, slots);

  if (!toStart.length) {
    if (countDrainingCompanies() >= maxParallel) {
      return {
        status: "busy",
        message: `At max parallel company capacity (${maxParallel}).`,
        ...(await getWorkerStatus()),
      };
    }
    return {
      status: "done",
      batches_run: 0,
      results: [],
      companies: [],
      ...(await getWorkerStatus()),
    };
  }

  const settled = await Promise.all(
    toStart.map((id) =>
      drainCompanyLane(id, {
        ...options,
        companyId: id,
        processId: undefined,
      }),
    ),
  );

  const batches_run = settled.reduce(
    (sum, row) => sum + (row.batches_run || 0),
    0,
  );
  const results = settled.flatMap((row) => row.results || []);
  const anyError = settled.some((row) => row.status === "error");

  return {
    status: anyError ? "error" : "done",
    companies: toStart,
    company_results: settled,
    batches_run,
    results,
    ...(await getWorkerStatus()),
  };
}

function scheduleProcessQueueDrain(options = {}) {
  if (!isProcessQueueWorkerEnabled()) return;

  const debounceMs = Number(
    process.env.PROCESS_QUEUE_WORKER_DEBOUNCE_MS || 500,
  );
  const companyId = normalizeCompanyId(options.companyId);

  if (companyId) {
    const existing = debounceTimers.get(companyId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      debounceTimers.delete(companyId);
      if (isCompanyDraining(companyId)) return;
      if (countDrainingCompanies() >= getMaxParallelCompanies()) return;

      drainProcessQueue({ ...options, companyId }).catch((err) => {
        console.warn(
          "[process-queue-worker] scheduled drain failed:",
          err?.message || err,
        );
      });
    }, debounceMs);

    debounceTimers.set(companyId, timer);
    return;
  }

  // No companyId: discover and schedule each company separately.
  discoverCompaniesNeedingWork()
    .then((companies) => {
      for (const id of companies) {
        scheduleProcessQueueDrain({ ...options, companyId: id });
      }
    })
    .catch((err) => {
      console.warn(
        "[process-queue-worker] schedule discovery failed:",
        err?.message || err,
      );
    });
}

function startProcessQueueWorker() {
  if (!isProcessQueueWorkerEnabled()) {
    console.log(
      "[process-queue-worker] Auto drain disabled (PROCESS_QUEUE_WORKER_ENABLED=false or Redis queue off).",
    );
    return;
  }

  const pollMs = Number(process.env.PROCESS_QUEUE_WORKER_POLL_MS || 10000);
  const maxParallel = getMaxParallelCompanies();
  console.log(
    `[process-queue-worker] Auto drain enabled — per-company parallel (max ${maxParallel}), poll ${pollMs}ms, batch delay ${process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000}ms`,
  );

  setTimeout(() => scheduleProcessQueueDrain(), 2000);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const max = getMaxParallelCompanies();
      if (countDrainingCompanies() >= max) return;

      const companies = await discoverCompaniesNeedingWork();
      for (const companyId of companies) {
        if (countDrainingCompanies() >= max) break;
        if (isCompanyDraining(companyId)) continue;
        scheduleProcessQueueDrain({ companyId });
      }
    } catch (err) {
      console.warn("[process-queue-worker] poll failed:", err?.message || err);
    }
  }, pollMs);
}

function stopProcessQueueWorker() {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  isProcessQueueWorkerEnabled,
  isCompanyDraining,
  getWorkerStatus,
  drainProcessQueue,
  scheduleProcessQueueDrain,
  startProcessQueueWorker,
  stopProcessQueueWorker,
};

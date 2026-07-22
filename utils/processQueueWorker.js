const { peekNextProcessJob, isQueueEnabled, getProcessQueueRemaining } = require("./processQueue");

let draining = false;
let debounceTimer = null;
let pollTimer = null;

/** Currently executing batch (cleared when drain finishes). */
let currentRun = null;

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

function clearCurrentRun() {
  currentRun = null;
}

function setCurrentRun(partial = {}) {
  const now = Date.now();
  if (!currentRun) {
    currentRun = {
      process_id: null,
      company_id: null,
      action: null,
      progress: null,
      status: null,
      product_id: null,
      category_id: null,
      brand_id: null,
      integration_id: null,
      page: null,
      hits: null,
      started_at: now,
      batch_index: 0,
      ...partial,
    };
    return;
  }
  currentRun = { ...currentRun, ...partial };
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

function applyProcessToCurrentRun(process) {
  if (!process) return;
  setCurrentRun({
    process_id: idFromRef(process._id) || currentRun?.process_id || null,
    company_id: idFromRef(process.company_id) || currentRun?.company_id || null,
    action: process.action || currentRun?.action || null,
    progress: process.progress || currentRun?.progress || null,
    status: process.status || currentRun?.status || null,
    product_id: idFromRef(process.product_id),
    category_id: idFromRef(process.category_id),
    brand_id: idFromRef(process.brand_id),
    integration_id: idFromRef(process.integration_id),
    page: process.page ?? currentRun?.page ?? null,
    hits: process.hits ?? currentRun?.hits ?? null,
  });
}

function formatRunningFor(startedAt) {
  if (!startedAt) return null;
  const ms = Math.max(0, Date.now() - startedAt);
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const human =
    hours > 0 ?
      `${hours}h ${minutes}m ${seconds}s`
    : minutes > 0 ? `${minutes}m ${seconds}s`
    : `${seconds}s`;
  return { ms, seconds: totalSec, human };
}

async function getWorkerStatus(options = {}) {
  const running_for =
    currentRun?.started_at ? formatRunningFor(currentRun.started_at) : null;

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
    const { activeNotDeletedCriteria, coalesceObjectId } = require("./modelHelper");
    const companyId = coalesceObjectId(options.companyId);

    // Match admin "remaining work": not completed/failed in DB (queue may be empty
    // while thousands of not_started rows still exist — worker falls back to Mongo).
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

  return {
    enabled: isProcessQueueWorkerEnabled(),
    draining,
    queue_enabled: isQueueEnabled(),
    current_process_id: currentRun?.process_id || null,
    current_company_id: currentRun?.company_id || null,
    current_action: currentRun?.action || null,
    current_progress: currentRun?.progress || null,
    current_status: currentRun?.status || null,
    current_product_id: currentRun?.product_id || null,
    current_category_id: currentRun?.category_id || null,
    current_brand_id: currentRun?.brand_id || null,
    current_integration_id: currentRun?.integration_id || null,
    current_page: currentRun?.page ?? null,
    current_hits: currentRun?.hits ?? null,
    started_at:
      currentRun?.started_at ?
        new Date(currentRun.started_at).toISOString()
      : null,
    running_for,
    batch_index: currentRun?.batch_index ?? null,
    // Primary: Mongo remaining (matches Processes admin list, e.g. 5209 not_started)
    remaining_processes: remaining_in_db,
    remaining_in_db,
    remaining_in_queue,
    remaining_by_company,
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
 * Run process batches until the queue is empty, the job finishes, or maxBatches is hit.
 * Each batch calls execute-process, which reads Redis first then falls back to MongoDB.
 */
async function drainProcessQueue(options = {}) {
  if (draining) {
    return { status: "busy", ...(await getWorkerStatus()) };
  }

  draining = true;
  setCurrentRun({
    process_id: options.processId ? String(options.processId) : null,
    company_id: options.companyId ? String(options.companyId) : null,
    started_at: Date.now(),
    batch_index: 0,
  });

  const results = [];
  const batchDelay = Number(
    process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000,
  );
  const maxBatches = Number(
    options.maxBatches ||
      process.env.PROCESS_QUEUE_WORKER_MAX_BATCHES ||
      5000,
  );
  const scopedProcessId = options.processId || null;
  const scopedCompanyId = options.companyId || null;

  try {
    const {
      runProcessExecution,
      loadActiveProcess,
    } = require("../controllers/process");

    for (let i = 0; i < maxBatches; i += 1) {
      setCurrentRun({ batch_index: i + 1 });

      // Resolve the same process execute-process will run (queue OR Mongo fallback)
      // BEFORE awaiting the batch, so status shows ids while a long batch runs.
      let processIdForBatch = scopedProcessId || null;
      try {
        const probeReq = buildWorkerReq({
          companyId: scopedCompanyId,
          processId: scopedProcessId,
          user: options.user,
        });
        const activeProcess = await loadActiveProcess(probeReq);
        if (activeProcess) {
          applyProcessToCurrentRun(activeProcess);
          processIdForBatch =
            idFromRef(activeProcess._id) || processIdForBatch;
        } else if (scopedProcessId) {
          setCurrentRun({
            process_id: String(scopedProcessId),
            company_id:
              scopedCompanyId ?
                String(scopedCompanyId)
              : currentRun?.company_id || null,
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

      try {
        const result = await runProcessExecution(req);
        const summary = summarizeBatchResult(result);
        results.push(summary);

        if (summary.process_id || summary.progress || summary.status) {
          setCurrentRun({
            process_id:
              summary.process_id != null ?
                String(summary.process_id)
              : currentRun?.process_id || null,
            company_id:
              summary.company_id != null ?
                String(summary.company_id)
              : currentRun?.company_id || null,
            action: summary.action || currentRun?.action || null,
            progress: summary.progress || currentRun?.progress || null,
            status: summary.status || currentRun?.status || null,
            product_id:
              summary.product_id != null ?
                String(summary.product_id)
              : currentRun?.product_id || null,
            category_id:
              summary.category_id != null ?
                String(summary.category_id)
              : currentRun?.category_id || null,
            brand_id:
              summary.brand_id != null ?
                String(summary.brand_id)
              : currentRun?.brand_id || null,
          });
        }

        // Refresh from DB after batch so page/hits/progress stay current
        if (currentRun?.process_id) {
          try {
            const ProcessModel = require("../models/process");
            const row = await ProcessModel.findById(currentRun.process_id)
              .select(
                "action progress status company_id product_id category_id brand_id integration_id page hits",
              )
              .lean();
            if (row) applyProcessToCurrentRun(row);
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
        console.warn(
          "[process-queue-worker] batch failed:",
          err?.response?.data?.message || err?.message || err,
        );
        results.push({
          success: false,
          statusCode: err?.response?.status || 500,
          process_id: currentRun?.process_id || null,
          company_id: currentRun?.company_id || null,
          action: currentRun?.action || null,
          progress: null,
          status: null,
          message: err?.response?.data?.message || err?.message || String(err),
        });
      }

      if (batchDelay > 0) {
        await sleep(batchDelay);
      }
    }
  } catch (err) {
    console.warn("[process-queue-worker] drain failed:", err?.message || err);
    draining = false;
    clearCurrentRun();
    return {
      status: "error",
      error: err?.message || String(err),
      batches_run: results.length,
      results,
      ...(await getWorkerStatus()),
    };
  } finally {
    draining = false;
    clearCurrentRun();
  }

  return {
    status: "done",
    batches_run: results.length,
    results,
    ...(await getWorkerStatus()),
  };
}

function scheduleProcessQueueDrain(options = {}) {
  if (!isProcessQueueWorkerEnabled()) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  const debounceMs = Number(process.env.PROCESS_QUEUE_WORKER_DEBOUNCE_MS || 500);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    drainProcessQueue(options).catch((err) => {
      console.warn(
        "[process-queue-worker] scheduled drain failed:",
        err?.message || err,
      );
    });
  }, debounceMs);
}

function startProcessQueueWorker() {
  if (!isProcessQueueWorkerEnabled()) {
    console.log(
      "[process-queue-worker] Auto drain disabled (PROCESS_QUEUE_WORKER_ENABLED=false or Redis queue off).",
    );
    return;
  }

  const pollMs = Number(process.env.PROCESS_QUEUE_WORKER_POLL_MS || 10000);
  console.log(
    `[process-queue-worker] Auto drain enabled — poll ${pollMs}ms, batch delay ${process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000}ms`,
  );

  setTimeout(() => scheduleProcessQueueDrain(), 2000);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (draining) return;
    try {
      const next = await peekNextProcessJob();
      if (next?.jobId) scheduleProcessQueueDrain();
    } catch (err) {
      console.warn("[process-queue-worker] poll failed:", err?.message || err);
    }
  }, pollMs);
}

function stopProcessQueueWorker() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  isProcessQueueWorkerEnabled,
  getWorkerStatus,
  drainProcessQueue,
  scheduleProcessQueueDrain,
  startProcessQueueWorker,
  stopProcessQueueWorker,
};

const { peekNextProcessJob, isQueueEnabled } = require("./processQueue");

let draining = false;
let debounceTimer = null;
let pollTimer = null;

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

function getWorkerStatus() {
  return {
    enabled: isProcessQueueWorkerEnabled(),
    draining,
    queue_enabled: isQueueEnabled(),
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
    process_id: data.process_id || null,
    progress: data.progress || null,
    status: data.status || null,
    message: result?.body?.message || result?.body?.error || null,
  };
}

function shouldStopDrain(result) {
  if (!result) return true;
  if (result.statusCode >= 500) return true;
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
 */
async function drainProcessQueue(options = {}) {
  if (draining) {
    return { status: "busy", ...getWorkerStatus() };
  }

  draining = true;
  const results = [];
  const batchDelay = Number(process.env.PROCESS_QUEUE_WORKER_BATCH_DELAY_MS || 1000);
  const maxBatches = Number(
    options.maxBatches ||
      process.env.PROCESS_QUEUE_WORKER_MAX_BATCHES ||
      5000,
  );
  const scopedProcessId = options.processId || null;
  const scopedCompanyId = options.companyId || null;

  try {
    const { runProcessExecution } = require("../controllers/process");

    for (let i = 0; i < maxBatches; i += 1) {
      const nextJob = await peekNextProcessJob(scopedCompanyId);
      if (!nextJob?.jobId && !scopedProcessId) {
        break;
      }

      const req = buildWorkerReq({
        companyId: scopedCompanyId || nextJob?.companyId,
        processId: scopedProcessId,
        user: options.user,
      });

      const result = await runProcessExecution(req);
      results.push(summarizeBatchResult(result));

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

      if (batchDelay > 0) {
        await sleep(batchDelay);
      }
    }
  } catch (err) {
    console.warn("[process-queue-worker] drain failed:", err?.message || err);
    return {
      status: "error",
      error: err?.message || String(err),
      batches_run: results.length,
      results,
      ...getWorkerStatus(),
    };
  } finally {
    draining = false;
  }

  return {
    status: "done",
    batches_run: results.length,
    results,
    ...getWorkerStatus(),
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

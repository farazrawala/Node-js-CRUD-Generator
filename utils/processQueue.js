const { coalesceObjectId } = require("./modelHelper");
const {
  enqueueJob,
  removeJob,
  peekNextJob,
  isQueueEnabled,
  normalizeCompanyId,
} = require("./redisQueue");

const PROCESS_MODULE = "process";

function resolveProcessCompanyId(process) {
  return normalizeCompanyId(
    coalesceObjectId(process?.company_id?._id || process?.company_id),
  );
}

function shouldQueueProcess(process) {
  if (!process) return false;
  if (process.deletedAt) return false;
  if (process.status !== "active") return false;
  if (["completed", "failed"].includes(String(process.progress || ""))) {
    return false;
  }
  return true;
}

function shouldReleaseProcess(process) {
  if (!process) return false;
  if (["completed", "failed", "inactive"].includes(String(process.status || ""))) {
    return true;
  }
  if (["completed", "failed"].includes(String(process.progress || ""))) {
    return true;
  }
  return false;
}

async function enqueueProcess(process) {
  if (!shouldQueueProcess(process)) {
    return { queued: false, backend: "none" };
  }

  const companyId = resolveProcessCompanyId(process);
  const processId = coalesceObjectId(process._id);
  if (!companyId || !processId) {
    return { queued: false, backend: "none" };
  }

  const enqueuedAt =
    process.createdAt ? new Date(process.createdAt).getTime() : Date.now();

  const queueResult = await enqueueJob(companyId, PROCESS_MODULE, String(processId), {
    priority: Number(process.priority) || 100,
    enqueuedAt,
  });

  if (queueResult.queued) {
    try {
      const { scheduleProcessQueueDrain } = require("./processQueueWorker");
      scheduleProcessQueueDrain();
    } catch (err) {
      console.warn("[process-queue] schedule worker:", err?.message || err);
    }
  }

  return queueResult;
}

async function releaseProcessFromQueue(processOrCompanyId, processId) {
  let companyId;
  let jobId;

  if (processOrCompanyId && typeof processOrCompanyId === "object") {
    companyId = resolveProcessCompanyId(processOrCompanyId);
    jobId = coalesceObjectId(processOrCompanyId._id);
  } else {
    companyId = normalizeCompanyId(processOrCompanyId);
    jobId = coalesceObjectId(processId);
  }

  if (!companyId || !jobId) return false;
  return removeJob(companyId, PROCESS_MODULE, String(jobId));
}

async function peekNextProcessJob(companyId) {
  return peekNextJob(PROCESS_MODULE, { companyId: companyId || undefined });
}

async function syncProcessQueueOnSave(doc) {
  if (shouldReleaseProcess(doc)) {
    await releaseProcessFromQueue(doc);
    return { action: "released" };
  }
  if (shouldQueueProcess(doc)) {
    const result = await enqueueProcess(doc);
    return { action: "enqueued", ...result };
  }
  return { action: "ignored" };
}

module.exports = {
  PROCESS_MODULE,
  isQueueEnabled,
  enqueueProcess,
  releaseProcessFromQueue,
  peekNextProcessJob,
  syncProcessQueueOnSave,
  shouldQueueProcess,
  shouldReleaseProcess,
};

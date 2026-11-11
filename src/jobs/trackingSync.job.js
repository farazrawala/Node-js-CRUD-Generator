/**
 * Background tracking sync — every hour by default.
 * Stops syncing terminal statuses (Delivered / Returned / Cancelled / Failed).
 * @module src/jobs/trackingSync.job
 */

const CourierService = require("../services/CourierService");
const courierLogger = require("../utils/courierLogger");
const { emailTrackingSyncSummary } = require("../utils/trackingSyncSummaryMail");

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SYNC_BATCH_SIZE = 25;

let timer = null;
let running = false;

function isEnabled() {
  const flag = String(process.env.COURIER_TRACKING_SYNC_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "no";
}

function getIntervalMs() {
  const n = Number(process.env.COURIER_TRACKING_SYNC_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
}

function getSyncBatchSize() {
  const configured = Number(process.env.COURIER_TRACKING_SYNC_LIMIT);
  if (!Number.isFinite(configured) || configured <= 0) return MAX_SYNC_BATCH_SIZE;
  return Math.max(1, Math.min(Math.floor(configured), MAX_SYNC_BATCH_SIZE));
}

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  const started = Date.now();
  let summary;
  try {
    courierLogger.syncJob({ phase: "start" });
    summary = await CourierService.syncOpenShipments({
      limit: getSyncBatchSize(),
    });
    const { changes, failures, ...counts } = summary;
    courierLogger.syncJob({
      phase: "done",
      durationMs: Date.now() - started,
      ...counts,
    });
  } catch (err) {
    courierLogger.apiError({
      event: "sync_job_failed",
      error: err.message,
      stack: err.stack,
    });
    summary = { error: err.message };
  } finally {
    running = false;
  }

  const mail = await emailTrackingSyncSummary(summary, {
    startedAt: new Date(started),
    durationMs: Date.now() - started,
  });
  if (!mail.sent && mail.reason !== "disabled") {
    courierLogger.apiError({
      event: "sync_summary_email_failed",
      reason: mail.reason,
      error: mail.error,
    });
  }
  return summary;
}

/**
 * Start the interval job (idempotent).
 */
function startTrackingSyncJob() {
  if (!isEnabled()) {
    courierLogger.syncJob({ phase: "disabled" });
    return { started: false, reason: "disabled" };
  }
  if (timer) return { started: true, already: true };

  const intervalMs = getIntervalMs();
  // Initial delay so boot is not blocked by outbound courier calls.
  const initialDelay = Math.min(15_000, intervalMs);
  setTimeout(() => {
    void runOnce();
  }, initialDelay);

  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  courierLogger.syncJob({ phase: "scheduled", intervalMs });
  return { started: true, intervalMs };
}

function stopTrackingSyncJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function getTrackingSyncStatus() {
  return {
    enabled: isEnabled(),
    running,
    scheduled: Boolean(timer),
    intervalMs: getIntervalMs(),
  };
}

module.exports = {
  startTrackingSyncJob,
  stopTrackingSyncJob,
  runOnce,
  getTrackingSyncStatus,
  getIntervalMs,
  getSyncBatchSize,
};

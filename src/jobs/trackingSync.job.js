/**
 * Background tracking sync — every 30 minutes by default.
 * Stops syncing terminal statuses (Delivered / Returned / Cancelled / Failed).
 * @module src/jobs/trackingSync.job
 */

const CourierService = require("../services/CourierService");
const courierLogger = require("../utils/courierLogger");

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

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

async function runOnce() {
  if (running) return { skipped: true };
  running = true;
  const started = Date.now();
  try {
    courierLogger.syncJob({ phase: "start" });
    const summary = await CourierService.syncOpenShipments({
      limit: Number(process.env.COURIER_TRACKING_SYNC_LIMIT) || 100,
    });
    courierLogger.syncJob({
      phase: "done",
      durationMs: Date.now() - started,
      ...summary,
    });
    return summary;
  } catch (err) {
    courierLogger.apiError({
      event: "sync_job_failed",
      error: err.message,
      stack: err.stack,
    });
    return { error: err.message };
  } finally {
    running = false;
  }
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
};

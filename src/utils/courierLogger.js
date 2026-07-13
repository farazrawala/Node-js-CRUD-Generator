/**
 * Structured courier logging (request/response/errors/sync) with secret masking.
 * Writes to app/error logs and a dedicated `logs/courier-YYYY-MM-DD.log`.
 * @module src/utils/courierLogger
 */

const fs = require("fs");
const path = require("path");
const fileLogger = require("../../utils/fileLogger");
const { maskSensitive } = require("./encryptCredentials");

const LOG_DIR = path.join(__dirname, "..", "..", "logs");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendCourierFile(line) {
  try {
    ensureLogDir();
    const filePath = path.join(LOG_DIR, `courier-${todayKey()}.log`);
    fs.appendFileSync(filePath, line, "utf8");
  } catch (err) {
    process.stderr.write(`[courierLogger] write failed: ${err.message}\n`);
  }
}

function safeStringify(value, maxLen = 12000) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      0,
    );
    if (json.length <= maxLen) return json;
    return `${json.slice(0, maxLen - 20)}…[truncated]`;
  } catch {
    return String(value);
  }
}

function log(level, event, meta = {}) {
  const payload = maskSensitive({
    module: "courier",
    event,
    ...meta,
  });
  const message = `[courier] ${event}`;
  if (typeof fileLogger[level] === "function") {
    fileLogger[level](message, payload);
  } else {
    fileLogger.info(message, payload);
  }

  const ts = new Date().toISOString();
  appendCourierFile(
    `[${ts}] [${String(level).toUpperCase()}] ${message} ${safeStringify(payload)}\n`,
  );
}

function shipmentRequest(meta) {
  log("info", "shipment_request", meta);
}

function shipmentResponse(meta) {
  log("info", "shipment_response", meta);
}

function trackingRequest(meta) {
  log("info", "tracking_request", meta);
}

function trackingResponse(meta) {
  log("info", "tracking_response", meta);
}

function apiError(meta) {
  log("error", "api_error", meta);
}

function bookingFailed(meta) {
  log("error", "booking_failed", meta);
}

function retry(meta) {
  log("warn", "retry", meta);
}

function syncJob(meta) {
  log("info", "sync_job", meta);
}

/**
 * Build a human-readable summary of a provider error for DB / UI logs.
 * @param {Error} err
 * @param {object} [extra]
 * @returns {string}
 */
function formatBookingFailureDescription(err, extra = {}) {
  const parts = [
    err?.message || "Courier booking failed",
    err?.code ? `code=${err.code}` : null,
    extra.provider ? `provider=${extra.provider}` : null,
    extra.orderId ? `orderId=${extra.orderId}` : null,
    extra.orderNo ? `orderNo=${extra.orderNo}` : null,
  ].filter(Boolean);

  const details = err?.details ?? extra.details;
  if (details != null) {
    parts.push(`details=${safeStringify(maskSensitive(details), 4000)}`);
  }
  return parts.join(" | ");
}

module.exports = {
  log,
  shipmentRequest,
  shipmentResponse,
  trackingRequest,
  trackingResponse,
  apiError,
  bookingFailed,
  retry,
  syncJob,
  formatBookingFailureDescription,
  LOG_DIR,
};

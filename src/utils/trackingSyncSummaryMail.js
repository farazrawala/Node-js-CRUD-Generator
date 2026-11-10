/**
 * Email a summary after each background tracking sync run:
 * how many shipments were checked and how many orders changed status.
 *
 * Env:
 *   TRACKING_SYNC_SUMMARY_EMAIL  "false" turns the email off (default on)
 *   TRACKING_SYNC_SUMMARY_TO     comma-separated recipients
 *   TRACKING_SYNC_SUMMARY_TZ     time zone for the timestamp (default Asia/Karachi)
 * SMTP account: ORDER_UPDATE_SMTP_* (see utils/orderUpdateMail.js).
 *
 * @module src/utils/trackingSyncSummaryMail
 */

const { sendEmail } = require("../../utils/orderUpdateMail");

const DEFAULT_TO = "johndavid78663@gmail.com";
const DEFAULT_TZ = "Asia/Karachi";

function isSummaryEmailEnabled() {
  const flag = String(process.env.TRACKING_SYNC_SUMMARY_EMAIL ?? "true")
    .trim()
    .toLowerCase();
  return flag !== "false" && flag !== "0" && flag !== "no";
}

function summaryRecipients() {
  const raw = String(process.env.TRACKING_SYNC_SUMMARY_TO || "").trim();
  return raw || DEFAULT_TO;
}

function formatTime(date) {
  const timeZone = String(process.env.TRACKING_SYNC_SUMMARY_TZ || "").trim() || DEFAULT_TZ;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Store order number (Shopify/Woo e.g. 1132) first, then POS ORD-####. */
function orderLabel(change) {
  const storeNo = String(change.integration_order_id || "").trim().replace(/^#/, "");
  const orderNo = String(change.order_no || "").trim();
  return storeNo || orderNo || change.order_id || "-";
}

/** Status text for the email: courier status ("Out For Delivery"), else order status. */
function statusChangeOf(change) {
  return change.tracking_status_change || change.order_status_change || null;
}

function prettyStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  // order_status values are snake_case ("in_transit"); courier ones are already readable.
  if (/^[a-z_]+$/.test(text)) {
    return text
      .split("_")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }
  return text;
}

function changeLine(change) {
  const status = statusChangeOf(change) || {};
  const from = prettyStatus(status.from);
  const to = prettyStatus(status.to) || "-";
  const label = `Order No ${orderLabel(change)}`;
  return from ? `${label} from ${from} to ${to}` : `${label} set to ${to}`;
}

const MAX_ORDERS_PER_REASON = 60;

/**
 * Group failed shipments by error message, biggest group first:
 *   "Invalid API credentials for Flagship" - 35 orders
 *     Order No 1132, 1133, ORD-2041
 */
function failureLines(failures) {
  const rows = Array.isArray(failures) ? failures : [];
  const groups = new Map();
  for (const row of rows) {
    const reason = String(row.reason || "Unknown error").trim() || "Unknown error";
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(row);
  }

  const lines = [];
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, group] of sorted) {
    const labels = group.map(orderLabel);
    const shown = labels.slice(0, MAX_ORDERS_PER_REASON).join(", ");
    const more = labels.length > MAX_ORDERS_PER_REASON
      ? ` +${labels.length - MAX_ORDERS_PER_REASON} more`
      : "";
    lines.push(
      "",
      `Reason: ${reason} (${group.length} order${group.length === 1 ? "" : "s"})`,
      `  Order No ${shown}${more}`,
    );
  }
  return lines;
}

/**
 * @param {object} summary  result of CourierService.syncOpenShipments (or { error })
 * @param {object} [meta]
 * @param {Date} [meta.startedAt]
 * @param {number} [meta.durationMs]
 * @returns {{ subject: string, text: string }}
 */
function buildTrackingSyncSummaryEmail(summary = {}, meta = {}) {
  const when = formatTime(meta.startedAt || new Date());

  if (summary.error) {
    return {
      subject: "Tracking sync failed",
      text: [
        `Courier tracking sync - ${when}`,
        "",
        "The sync did not finish:",
        `  ${summary.error}`,
      ].join("\n"),
    };
  }

  const total = Number(summary.total || 0);
  const errors = Number(summary.errors || 0);
  const changes = (Array.isArray(summary.changes) ? summary.changes : []).filter(
    statusChangeOf,
  );
  const count = changes.length;

  const headline =
    count === 0
      ? "No order status has changed."
      : `${count} order status${count === 1 ? " has" : "es have"} been changed.`;

  const lines = [headline];
  if (count) {
    lines.push("");
    for (const c of changes) lines.push(changeLine(c));
  }
  lines.push(
    "",
    "--",
    `Checked ${total} shipment${total === 1 ? "" : "s"} at ${when}` +
      ` (took ${formatDuration(meta.durationMs)}).`,
  );
  if (errors) {
    lines.push(
      "",
      `${errors} shipment${errors === 1 ? "" : "s"} could not be checked this time:`,
    );
    lines.push(...failureLines(summary.failures));
  }

  return {
    subject: `Tracking update: ${count} order status${count === 1 ? "" : "es"} changed`,
    text: lines.join("\n"),
  };
}

/**
 * Send the summary email. Never throws.
 */
async function emailTrackingSyncSummary(summary, meta = {}) {
  if (!isSummaryEmailEnabled()) return { sent: false, reason: "disabled" };
  try {
    const { subject, text } = buildTrackingSyncSummaryEmail(summary, meta);
    return await sendEmail({ to: summaryRecipients(), subject, text });
  } catch (err) {
    return { sent: false, reason: "send_failed", error: err.message };
  }
}

module.exports = {
  buildTrackingSyncSummaryEmail,
  emailTrackingSyncSummary,
};

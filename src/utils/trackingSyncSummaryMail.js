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
const { mapGenericStatus } = require("../couriers/statusMap");

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

/** Prefer POS order id (ORD-####), then store/integration number. */
function orderLabel(change) {
  const orderNo = String(change.order_no || "").trim();
  const storeNo = String(change.integration_order_id || "").trim().replace(/^#/, "");
  return orderNo || storeNo || change.order_id || "-";
}

/** Status text for the email: courier status ("Out For Delivery"), else order status. */
function statusChangeOf(change) {
  return change.tracking_status_change || change.order_status_change || null;
}

function prettyStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  // Raw courier scans (TCS, Leopard, Trax, …) become the same POS statuses.
  const unified = mapGenericStatus(text);
  if (unified) return unified;
  if (/^[a-z_]+$/.test(text)) {
    return text
      .split("_")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }
  return text;
}

/** Age of the previous last_tracking_sync, e.g. "3hr 10 mins". */
function formatSyncAge(value) {
  if (!value) return "never synced";
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return "never synced";
  const totalMinutes = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourLabel = `${hours}hr`;
  const minuteLabel = `${minutes} min${minutes === 1 ? "" : "s"}`;
  if (hours === 0) return minuteLabel;
  if (minutes === 0) return hourLabel;
  return `${hourLabel} ${minuteLabel}`;
}

function changeLine(change) {
  const status = statusChangeOf(change) || {};
  const from = prettyStatus(status.from);
  const to = prettyStatus(status.to) || "-";
  if (from && from === to) return "";
  const courier = String(change.courier || "").trim();
  const label = `POS Order ${orderLabel(change)}`;
  const who = courier ? `${label} (${courier})` : label;
  const gap = `last_tracking_sync ${formatSyncAge(change.last_tracking_sync)}`;
  return from ? `${who} from ${from} to ${to} (${gap})` : `${who} set to ${to} (${gap})`;
}

const MAX_ORDERS_PER_REASON = 60;
const MAX_CHECKED_ORDERS = 80;

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
      `  POS Order ${shown}${more}`,
    );
  }
  return lines;
}

/** Compact list of every POS order id included in this sync run. */
function checkedOrderLines(checked) {
  const rows = Array.isArray(checked) ? checked : [];
  if (!rows.length) return [];
  const labels = [...new Set(rows.map(orderLabel).filter((label) => label && label !== "-"))];
  if (!labels.length) return [];
  const shown = labels.slice(0, MAX_CHECKED_ORDERS).join(", ");
  const more =
    labels.length > MAX_CHECKED_ORDERS
      ? ` +${labels.length - MAX_CHECKED_ORDERS} more`
      : "";
  return ["", `POS Order ${shown}${more}`];
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
  const detailLines = [];
  for (const c of changes) {
    const line = changeLine(c);
    if (line) detailLines.push(line);
  }
  const count = detailLines.length;

  const headline =
    count === 0
      ? "No order status has changed."
      : `${count} order status${count === 1 ? " has" : "es have"} been changed.`;

  const lines = [headline];
  if (count) {
    lines.push("");
    lines.push(...detailLines);
  }
  // Always list which orders were polled (including the 0-change email).
  lines.push(...checkedOrderLines(summary.checked));
  lines.push(
    "",
    "--",
    `Checked ${total} shipment${total === 1 ? "" : "s"}` +
      (Number(summary.pages) > 1
        ? ` in ${summary.pages} pages of ${summary.page_size || 25}`
        : "") +
      ` at ${when} (took ${formatDuration(meta.durationMs)}).`,
  );
  if (summary.has_more) {
    lines.push("More open shipments remain for the next run.");
  }
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
  const to = summaryRecipients();
  if (!isSummaryEmailEnabled()) {
    return {
      sent: false,
      to,
      reason: "disabled",
      message: "Tracking summary email is turned off.",
    };
  }
  try {
    const { subject, text } = buildTrackingSyncSummaryEmail(summary, meta);
    const result = await sendEmail({ to, subject, text });
    if (result.sent) {
      return { sent: true, to, message: `Tracking update email sent to ${to}.` };
    }
    const message =
      result.reason === "smtp_not_configured"
        ? "SMTP is not configured on the server."
        : result.error || result.reason || "Tracking check finished. No email was sent.";
    return { ...result, to, message };
  } catch (err) {
    return {
      sent: false,
      to,
      reason: "send_failed",
      error: err.message,
      message: err.message || "Tracking check finished. No email was sent.",
    };
  }
}

module.exports = {
  buildTrackingSyncSummaryEmail,
  emailTrackingSyncSummary,
};

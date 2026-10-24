/**
 * Helpers for company SMS-on-order settings.
 *
 * POS stores JSON on `company.local_sms` (same idea as `whatsapp_local_settings`):
 * {
 *   "send_sms_on_order": true,
 *   "send_sms_on_order_message": "Hi {name},\n\nThank you for your order.\nPhone: {phone}\nEmail: {email}\nAmount: {total_amount}\nTransaction #: {transaction_number}\nDate: {createdAt}",
 *   "send_sms_greater_than": false,
 *   "send_sms_greater_than_amount": 0
 * }
 *
 * Also accepts `sms_local_settings` and top-level `send_sms_*` fields.
 */

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function hasOwn(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

function pickSetting(sources, key) {
  for (const src of sources) {
    if (src && hasOwn(src, key) && src[key] !== undefined) return src[key];
  }
  return undefined;
}

function parseSmsLocalSettings(company) {
  if (!company || typeof company !== "object") return {};
  const fromLocalSms = parseJsonObject(
    company.local_sms ?? company.localSms ?? company.local_sms_settings,
  );
  const fromSmsLocal = parseJsonObject(company.sms_local_settings);
  // Top-level wins, then POS `local_sms`, then legacy `sms_local_settings`.
  return {
    send_sms_on_order: pickSetting(
      [company, fromLocalSms, fromSmsLocal],
      "send_sms_on_order",
    ),
    send_sms_on_order_message: pickSetting(
      [company, fromLocalSms, fromSmsLocal],
      "send_sms_on_order_message",
    ),
    send_sms_greater_than: pickSetting(
      [company, fromLocalSms, fromSmsLocal],
      "send_sms_greater_than",
    ),
    send_sms_greater_than_amount: pickSetting(
      [company, fromLocalSms, fromSmsLocal],
      "send_sms_greater_than_amount",
    ),
  };
}

function toBooleanFlag(value) {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatSmsDate(value) {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

/**
 * Enabled when `send_sms_on_order` is true.
 * If that flag is omitted, falls back to a non-empty `send_sms_on_order_message`.
 * Explicit `send_sms_on_order: false` disables sending.
 */
function sendSmsOnOrderEnabled(company) {
  const settings = parseSmsLocalSettings(company);
  if (
    settings.send_sms_on_order !== undefined &&
    settings.send_sms_on_order !== null
  ) {
    return toBooleanFlag(settings.send_sms_on_order);
  }
  const msg = settings.send_sms_on_order_message;
  return typeof msg === "string" && msg.trim() !== "";
}

/**
 * When `send_sms_greater_than` is true, only queue if
 * order.total_amount > send_sms_greater_than_amount.
 * When false, amount gate is skipped.
 */
function passesSmsAmountGate(settings, order) {
  if (!toBooleanFlag(settings?.send_sms_greater_than)) {
    return true;
  }
  const total = toNumber(order?.total_amount, 0);
  const minAmount = toNumber(settings?.send_sms_greater_than_amount, 0);
  return total > minAmount;
}

/**
 * True when SMS should be queued for this company + order.
 */
function shouldQueueSmsForOrder(company, order) {
  if (!sendSmsOnOrderEnabled(company)) return false;
  const settings = parseSmsLocalSettings(company);
  return passesSmsAmountGate(settings, order);
}

/**
 * Build text from `send_sms_on_order_message`.
 * Placeholders: {name}, {phone}, {email}, {total_amount}, {transaction_number}, {createdAt}, {order_no}
 */
function buildSmsOrderMessage(settings, order) {
  const template =
    (settings &&
      (settings.send_sms_on_order_message ||
        settings.message ||
        settings.order_message ||
        settings.template)) ||
    "Hi {name},\n\nThank you for your order.\nPhone: {phone}\nEmail: {email}\nAmount: {total_amount}\nTransaction #: {transaction_number}\nDate: {createdAt}";

  const replacements = {
    name:
      order?.name != null ? String(order.name)
      : order?.customer_name != null ? String(order.customer_name)
      : "",
    phone: order?.phone != null ? String(order.phone) : "",
    email: order?.email != null ? String(order.email) : "",
    total_amount:
      order?.total_amount != null ? String(order.total_amount) : "0",
    transaction_number:
      order?.transaction_number != null ? String(order.transaction_number) : "",
    createdAt: formatSmsDate(order?.createdAt),
    order_no: order?.order_no != null ? String(order.order_no) : "",
  };

  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ?
      replacements[key]
    : `{${key}}`,
  );
}

module.exports = {
  parseSmsLocalSettings,
  parseSmsSettings: parseSmsLocalSettings,
  sendSmsOnOrderEnabled,
  passesSmsAmountGate,
  shouldQueueSmsForOrder,
  buildSmsOrderMessage,
};

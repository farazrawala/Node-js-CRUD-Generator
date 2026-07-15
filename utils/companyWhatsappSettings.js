/**
 * Helpers for `company.whatsapp_local_settings`.
 *
 * Example:
 * {
 *   "send_whatsapp_on_order": true,
 *   "send_whatsapp_on_order_message": "Hi {name},\n\nThank you for your order.\nPhone: {phone}\nEmail: {email}\nAmount: {total_amount}\nTransaction #: {transaction_number}\nDate: {createdAt}",
 *   "send_whatsapp_greater_than": false,
 *   "send_whatsapp_greater_than_amount": 0
 * }
 */

function parseWhatsappLocalSettings(company) {
  const raw =
    company && typeof company === "object" ?
      company.whatsapp_local_settings
    : company;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
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

function formatWhatsappDate(value) {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

/**
 * Enabled when `send_whatsapp_on_order` is true.
 * If that flag is omitted, falls back to a non-empty `send_whatsapp_on_order_message`.
 * Explicit `send_whatsapp_on_order: false` disables sending.
 */
function sendWhatsappOnOrderEnabled(company) {
  const settings = parseWhatsappLocalSettings(company);
  if (Object.prototype.hasOwnProperty.call(settings, "send_whatsapp_on_order")) {
    return toBooleanFlag(settings.send_whatsapp_on_order);
  }
  const msg = settings.send_whatsapp_on_order_message;
  return typeof msg === "string" && msg.trim() !== "";
}

/**
 * When `send_whatsapp_greater_than` is true, only queue if
 * order.total_amount > send_whatsapp_greater_than_amount.
 * When false, amount gate is skipped.
 */
function passesWhatsappAmountGate(settings, order) {
  if (!toBooleanFlag(settings?.send_whatsapp_greater_than)) {
    return true;
  }
  const total = toNumber(order?.total_amount, 0);
  const minAmount = toNumber(settings?.send_whatsapp_greater_than_amount, 0);
  return total > minAmount;
}

/**
 * True when WhatsApp should be queued for this company + order.
 */
function shouldQueueWhatsappForOrder(company, order) {
  if (!sendWhatsappOnOrderEnabled(company)) return false;
  const settings = parseWhatsappLocalSettings(company);
  return passesWhatsappAmountGate(settings, order);
}

/**
 * Build text from `send_whatsapp_on_order_message`.
 * Placeholders: {name}, {phone}, {email}, {total_amount}, {transaction_number}, {createdAt}
 * Also supports {order_no} as a convenience.
 */
function buildWhatsappOrderMessage(settings, order) {
  const template =
    (settings &&
      (settings.send_whatsapp_on_order_message ||
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
    createdAt: formatWhatsappDate(order?.createdAt),
    order_no: order?.order_no != null ? String(order.order_no) : "",
  };

  return String(template).replace(/\{(\w+)\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ?
      replacements[key]
    : `{${key}}`,
  );
}

module.exports = {
  parseWhatsappLocalSettings,
  sendWhatsappOnOrderEnabled,
  passesWhatsappAmountGate,
  shouldQueueWhatsappForOrder,
  buildWhatsappOrderMessage,
};

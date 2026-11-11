const { sendEmail } = require("../../utils/orderUpdateMail");
const { toPublicUploadUrl } = require("../../utils/basePath");

const RECIPIENT = "johndavid78663@gmail.com";

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function buildTrackingStatusUpdateEmail({
  orderNo,
  status,
  integrationImage,
  integrationName,
} = {}) {
  const orderLabel = String(orderNo || "").trim() || "-";
  const deliveryStatus = String(status || "").trim();
  if (!deliveryStatus) return null;

  const logoUrl = toPublicUploadUrl(String(integrationImage || "").trim());
  const message = `Your order NO: ${orderLabel} delivery status has been updated to: ${deliveryStatus}`;
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(integrationName || "Store")}" style="display:block;max-width:180px;max-height:72px;margin:0 0 20px;object-fit:contain">`
    : "";

  return {
    subject: `Delivery status updated for order ${orderLabel}`,
    text: message,
    html: `<div style="font-family:Arial,sans-serif;color:#172b4d">${logo}<p>${escapeHtml(message)}</p></div>`,
  };
}

async function emailTrackingStatusUpdate(details) {
  const email = buildTrackingStatusUpdateEmail(details);
  if (!email) return { sent: false, reason: "missing_status" };
  return sendEmail({ to: RECIPIENT, ...email });
}

module.exports = {
  RECIPIENT,
  buildTrackingStatusUpdateEmail,
  emailTrackingStatusUpdate,
};

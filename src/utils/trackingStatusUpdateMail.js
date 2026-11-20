const { sendEmail } = require("../../utils/orderUpdateMail");
const { toPublicUploadUrl } = require("../../utils/basePath");

const RECIPIENT = "johndavid78663@gmail.com";

const STATUS_THEMES = {
  pending: {
    label: "Pending",
    message: "Your order is awaiting confirmation.",
    color: "#c2410c",
    background: "#fff7ed",
    border: "#fdba74",
  },
  confirmed: {
    label: "Confirmed",
    message: "Great news! Your order has been confirmed.",
    color: "#1d4ed8",
    background: "#eff6ff",
    border: "#93c5fd",
  },
  processing: {
    label: "Processing",
    message: "We're preparing your order.",
    color: "#6d28d9",
    background: "#f5f3ff",
    border: "#c4b5fd",
  },
  packed: {
    label: "Packed",
    message: "Your order has been packed and is ready to leave our warehouse.",
    color: "#0f766e",
    background: "#f0fdfa",
    border: "#5eead4",
  },
  shipped: {
    label: "Shipped",
    message: "Your order is on its way!",
    color: "#3730a3",
    background: "#eef2ff",
    border: "#a5b4fc",
  },
  out_for_delivery: {
    label: "Out for Delivery",
    message: "Your package is expected to arrive soon.",
    color: "#b45309",
    background: "#fffbeb",
    border: "#fcd34d",
  },
  delivered: {
    label: "Delivered",
    message: "Your order has been successfully delivered. Enjoy your purchase!",
    color: "#15803d",
    background: "#f0fdf4",
    border: "#86efac",
  },
  cancelled: {
    label: "Cancelled",
    message: "This order has been cancelled. Contact us if you need any help.",
    color: "#b91c1c",
    background: "#fef2f2",
    border: "#fca5a5",
  },
  returned: {
    label: "Returned",
    message: "This order is being returned. Our team can help if you have questions.",
    color: "#9f1239",
    background: "#fff1f2",
    border: "#fda4af",
  },
};

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

function classifyStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (!value) return null;
  if (/cancel/.test(value)) return "cancelled";
  if (/return|rto|undeliver/.test(value)) return "returned";
  if (/out\s*for\s*delivery|out_for_delivery/.test(value)) return "out_for_delivery";
  if (/deliver/.test(value)) return "delivered";
  if (/ship|in[\s_-]*transit|dispatch|depart|arrived|origin|hub/.test(value)) return "shipped";
  if (/pack/.test(value)) return "packed";
  if (/process|prepar|pick/.test(value)) return "processing";
  if (/confirm/.test(value)) return "confirmed";
  if (/pend|book|await/.test(value)) return "pending";
  return null;
}

function formatOrderDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).trim();
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function safeHttpUrl(value) {
  const url = String(value || "").trim();
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function buildTrackingStatusUpdateEmail({
  orderNo,
  status,
  integrationImage,
  integrationName,
  customerName,
  orderDate,
  trackingUrl,
  trackingNumber,
  supportEmail,
  websiteUrl,
  supportPhone,
} = {}) {
  const orderLabel = String(orderNo || "").trim() || "-";
  const deliveryStatus = String(status || "").trim();
  if (!deliveryStatus) return null;

  const storeName = String(integrationName || "").trim() || "Store";
  const logoUrl = toPublicUploadUrl(String(integrationImage || "").trim());
  const message = `Your order NO: ${orderLabel} delivery status has been updated to: ${deliveryStatus}`;
  const theme = STATUS_THEMES[classifyStatus(deliveryStatus)] || {
    label: deliveryStatus,
    message: "There's an update regarding your delivery.",
    color: "#334155",
    background: "#f8fafc",
    border: "#cbd5e1",
  };

  const safeOrder = escapeHtml(orderLabel);
  const safeStatus = escapeHtml(deliveryStatus);
  const safeStore = escapeHtml(storeName);
  const safeName = escapeHtml(String(customerName || "").trim());
  const safeDate = escapeHtml(formatOrderDate(orderDate));
  const safeTrackingNo = escapeHtml(String(trackingNumber || "").trim());
  const trackHref = escapeHtml(safeHttpUrl(trackingUrl));
  const siteHref = escapeHtml(safeHttpUrl(websiteUrl));
  const safeSupport = escapeHtml(String(supportEmail || "").trim());
  const safePhone = escapeHtml(String(supportPhone || "").trim());
  const year = new Date().getFullYear();

  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${safeStore}" width="160" style="display:block;width:160px;max-width:180px;height:auto;margin:0 auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-size:22px;line-height:28px;font-weight:700;color:#111827;text-align:center;">${safeStore}</div>`;

  const greeting = safeName ? `Hello ${safeName},` : "Hello,";
  const dateRow = safeDate
    ? `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eef2f6;font-size:13px;line-height:20px;color:#64748b;width:42%;">Order date</td>
        <td style="padding:10px 0;border-bottom:1px solid #eef2f6;font-size:14px;line-height:20px;color:#0f172a;font-weight:600;text-align:right;">${safeDate}</td>
      </tr>`
    : "";
  const trackingRow = safeTrackingNo
    ? `<tr>
        <td style="padding:10px 0;font-size:13px;line-height:20px;color:#64748b;">Tracking number</td>
        <td style="padding:10px 0;font-size:14px;line-height:20px;color:#0f172a;font-weight:600;text-align:right;">${safeTrackingNo}</td>
      </tr>`
    : "";
  const button = trackHref
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr>
          <td align="center" bgcolor="#111827" style="border-radius:8px;background:#111827;">
            <a href="${trackHref}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:14px;line-height:20px;font-weight:700;letter-spacing:0.04em;color:#ffffff;text-decoration:none;">TRACK YOUR ORDER</a>
          </td>
        </tr>
      </table>`
    : "";
  const supportBits = [
    safeSupport ? `<a href="mailto:${safeSupport}" style="color:#334155;text-decoration:none;">${safeSupport}</a>` : "",
    safePhone,
    siteHref ? `<a href="${siteHref}" style="color:#334155;text-decoration:none;">${siteHref.replace(/^https?:\/\//i, "")}</a>` : "",
  ].filter(Boolean);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Delivery status updated</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;width:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;">
          <tr>
            <td align="center" style="padding:28px 32px 20px;border-bottom:1px solid #f1f5f9;text-align:center;">
              ${logo}
              <div style="margin-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#64748b;text-align:center;">Your trusted shopping experience</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 8px;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:22px;line-height:30px;font-weight:700;color:#0f172a;">${greeting}</div>
              <div style="margin-top:8px;font-size:15px;line-height:24px;color:#475569;">There's an update regarding your order!</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;">
                <tr>
                  <td style="padding:8px 20px 4px;font-family:Arial,Helvetica,sans-serif;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                      <tr>
                        <td style="padding:12px 0;border-bottom:1px solid #eef2f6;font-size:13px;line-height:20px;color:#64748b;font-family:Arial,Helvetica,sans-serif;">Order number</td>
                        <td style="padding:12px 0;border-bottom:1px solid #eef2f6;font-size:16px;line-height:22px;color:#0f172a;font-weight:700;text-align:right;font-family:Arial,Helvetica,sans-serif;">${safeOrder}</td>
                      </tr>
                      ${dateRow}
                      <tr>
                        <td style="padding:12px 0;${trackingRow ? "border-bottom:1px solid #eef2f6;" : ""}font-size:13px;line-height:20px;color:#64748b;font-family:Arial,Helvetica,sans-serif;">Current status</td>
                        <td style="padding:12px 0;${trackingRow ? "border-bottom:1px solid #eef2f6;" : ""}font-size:14px;line-height:20px;color:${theme.color};font-weight:700;text-align:right;font-family:Arial,Helvetica,sans-serif;">${safeStatus}</td>
                      </tr>
                      ${trackingRow}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${theme.background};border:1px solid ${theme.border};border-radius:12px;">
                <tr>
                  <td style="padding:22px 20px;font-family:Arial,Helvetica,sans-serif;">
                    <div style="font-size:12px;line-height:16px;letter-spacing:0.08em;font-weight:700;color:${theme.color};text-transform:uppercase;">Delivery status</div>
                    <div style="margin-top:8px;font-size:20px;line-height:28px;font-weight:700;color:#0f172a;">${escapeHtml(theme.label)}</div>
                    <div style="margin-top:8px;font-size:15px;line-height:24px;color:#334155;">${escapeHtml(theme.message)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${
            button
              ? `<tr><td align="center" style="padding:20px 32px 8px;font-family:Arial,Helvetica,sans-serif;">${button}</td></tr>`
              : ""
          }
          <tr>
            <td style="padding:20px 32px 8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#64748b;">
              ${escapeHtml(message)}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#475569;">
              Thank you for shopping with ${safeStore}.
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;border-radius:0 0 16px 16px;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:13px;line-height:20px;color:#64748b;">Questions about this order? Our support team is here to help.</div>
              ${
                supportBits.length
                  ? `<div style="margin-top:8px;font-size:13px;line-height:22px;color:#334155;">${supportBits.join(" &nbsp;&middot;&nbsp; ")}</div>`
                  : ""
              }
              <div style="margin-top:14px;font-size:12px;line-height:18px;color:#94a3b8;">&copy; ${year} ${safeStore}. All rights reserved.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    subject: `Delivery status updated for order ${orderLabel}`,
    text: message,
    html,
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
  classifyStatus,
};

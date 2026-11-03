/**
 * Email the order-update webhook response.
 * Credentials come from the environment, not from source control.
 */
const nodemailer = require("nodemailer");

function smtpSettings() {
  const user = String(process.env.ORDER_UPDATE_SMTP_USER || "").trim();
  const pass = String(process.env.ORDER_UPDATE_SMTP_PASS || "").replace(/\s+/g, "");
  const to = String(process.env.ORDER_UPDATE_SMTP_TO || user).trim();
  const host = String(process.env.ORDER_UPDATE_SMTP_HOST || "smtp.gmail.com").trim();
  const port = Number(process.env.ORDER_UPDATE_SMTP_PORT || 465);
  if (!user || !pass || !to || !host || !Number.isFinite(port)) return null;
  return {
    user,
    pass,
    to,
    host,
    port,
    secure: port === 465,
  };
}

async function sendWebhookEmail(payload, subject) {
  const settings = smtpSettings();
  if (!settings) return { sent: false, reason: "smtp_not_configured" };

  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  await transporter.sendMail({
    from: settings.user,
    to: settings.to,
    subject: String(subject || "Shopify order webhook").slice(0, 180),
    text: JSON.stringify(payload, null, 2).slice(0, 400000),
  });

  return { sent: true };
}

async function emailOrderUpdateResponse(payload) {
  const status = payload?.httpStatus ?? "";
  const message = String(payload?.response?.message || "Shopify order update").slice(0, 120);
  return sendWebhookEmail(
    payload,
    `Shopify order update webhook ${status}: ${message}`,
  );
}

/**
 * Email the query string and POST body from a webhook hit.
 */
async function emailWebhookParameters(req) {
  const topic = String(
    req.get?.("x-shopify-topic") || req.headers?.["x-shopify-topic"] || "",
  ).trim();
  const shop = String(
    req.get?.("x-shopify-shop-domain") || req.headers?.["x-shopify-shop-domain"] || "",
  ).trim();
  const method = String(req.method || "").toUpperCase();
  return sendWebhookEmail(
    {
      method,
      url: req.originalUrl || req.url || "",
      topic: topic || null,
      shop: shop || null,
      get: req.query || {},
      post: req.body ?? null,
    },
    `Shopify order webhook ${method}${topic ? ` ${topic}` : ""} parameters`,
  );
}

module.exports = {
  emailOrderUpdateResponse,
  emailWebhookParameters,
};

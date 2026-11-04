/**
 * Email the order-update webhook response.
 * Credentials come from the environment, not from source control.
 */
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function smtpSettings() {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
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

const TOPIC_ACTION = {
  "orders/updated": "updated",
  "orders/edited": "updated",
  "orders/paid": "paid",
  "orders/fulfilled": "fulfilled",
  "orders/partially_fulfilled": "partially fulfilled",
  "orders/cancelled": "cancel",
};

function orderNumberFromBody(body) {
  const source = body && typeof body === "object" ? body : {};
  const nested = [source, source.order, source.json];
  for (const item of nested) {
    if (!item || typeof item !== "object") continue;
    const value = item.order_number;
    if (value == null || String(value).trim() === "") continue;
    return String(value).replace(/^#/, "").trim();
  }
  return "";
}

function webhookEmailSubject(topic, body) {
  const normalized = String(topic || "").trim().toLowerCase();
  if (normalized === "orders/create") return "New Order arrived.";
  const action = TOPIC_ACTION[normalized] || "updated";
  const number = orderNumberFromBody(body);
  if (!number) return `Order is ${action}`;
  return `Order Number : ${number} is ${action}`;
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
    webhookEmailSubject(topic, req.body),
  );
}

module.exports = {
  emailOrderUpdateResponse,
  emailWebhookParameters,
  webhookEmailSubject,
};

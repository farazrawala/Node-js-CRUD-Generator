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

async function emailOrderUpdateResponse(payload) {
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

  const text = JSON.stringify(payload, null, 2).slice(0, 100000);
  const status = payload?.httpStatus ?? "";
  const message = String(payload?.response?.message || "Shopify order update").slice(0, 120);

  await transporter.sendMail({
    from: settings.user,
    to: settings.to,
    subject: `Shopify order update webhook ${status}: ${message}`.slice(0, 180),
    text,
  });

  return { sent: true };
}

module.exports = {
  emailOrderUpdateResponse,
};

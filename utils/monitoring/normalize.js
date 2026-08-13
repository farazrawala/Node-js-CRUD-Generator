const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

const REDACT_KEYS = /password|passwd|token|secret|authorization|cookie|jwt|apikey|api_key|credit|card|cvv|ssn/i;

function createRequestId() {
  return `req_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function getRequestContext() {
  return requestContext.getStore() || null;
}

function runWithRequestContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

function normalizeRoute(rawPath, req) {
  if (req?.route?.path) {
    const base = req.baseUrl || "";
    return `${base}${req.route.path}`;
  }
  let pathOnly = String(rawPath || "/").split("?")[0];
  pathOnly = pathOnly.replace(/^\/pos_admin(?=\/|$)/, "") || "/";
  pathOnly = pathOnly.replace(/\/[0-9a-fA-F]{24}(?=\/|$)/g, "/:id");
  pathOnly = pathOnly.replace(
    /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g,
    "/:uuid",
  );
  pathOnly = pathOnly.replace(/\/\d+(?=\/|$)/g, "/:id");
  return pathOnly || "/";
}

function maskIp(ip) {
  if (!ip) return "";
  const value = String(ip).replace(/^::ffff:/, "");
  if (value.includes(":")) {
    const parts = value.split(":");
    return `${parts.slice(0, 3).join(":")}:xxxx`;
  }
  const parts = value.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  return "x.x.x.x";
}

function sanitizeMessage(value, maxLen = 240) {
  let text = String(value || "");
  text = text.replace(
    /(authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^,\s]+/gi,
    "$1=[REDACTED]",
  );
  if (text.length > maxLen) text = `${text.slice(0, maxLen)}…`;
  return text;
}

function sanitizeMeta(input, depth = 0) {
  if (input == null || depth > 3) return input;
  if (Array.isArray(input)) return input.slice(0, 20).map((v) => sanitizeMeta(v, depth + 1));
  if (typeof input !== "object") return input;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (REDACT_KEYS.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeMeta(value, depth + 1);
    }
  }
  return out;
}

function classifyError(err, status) {
  if (err?.name) return err.name;
  if (status === 401 || status === 403) return "AuthenticationError";
  if (status === 404) return "NotFoundError";
  if (status === 409) return "ConflictError";
  if (status === 422 || status === 400) return "ValidationError";
  if (status === 429) return "RateLimitError";
  if (status >= 500) return "ServerError";
  return "HttpError";
}

module.exports = {
  createRequestId,
  getRequestContext,
  runWithRequestContext,
  normalizeRoute,
  maskIp,
  sanitizeMessage,
  sanitizeMeta,
  classifyError,
};

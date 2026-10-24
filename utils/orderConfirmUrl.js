/**
 * Build the customer order confirmation / thank-you page URL:
 *   {POS_FRONTEND}/thank-you/iorder/{orderObjectId}
 *
 * Example:
 *   https://testv3.websitedemolynk.com/pos/thank-you/iorder/671...
 */

function stripTrailingSlashes(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/**
 * Normalize a configured base to the POS frontend root (.../pos).
 */
function normalizePosFrontendBase(raw) {
  let base = stripTrailingSlashes(raw);
  if (!base) return "";

  base = base
    .replace(/\/pos_admin(?:\/api)?$/i, "/pos")
    .replace(/\/api$/i, "");

  // Bare origin → append /pos
  try {
    const u = new URL(base);
    const path = (u.pathname || "/").replace(/\/+$/, "") || "";
    if (!path || path === "/") {
      return `${u.origin}/pos`;
    }
    if (!/\/pos$/i.test(path) && !/\/thank-you/i.test(path)) {
      // keep explicit paths like /pos or custom mounts
      if (!path.toLowerCase().includes("/pos")) {
        return `${u.origin}/pos`;
      }
    }
    return `${u.origin}${path}`;
  } catch (_) {
    return base;
  }
}

function baseFromRequest(req) {
  if (!req || typeof req.get !== "function") return "";
  const host = String(
    req.get("x-forwarded-host") || req.get("host") || "",
  ).trim();
  if (!host) return "";
  const proto = String(
    req.get("x-forwarded-proto") || req.protocol || "https",
  )
    .split(",")[0]
    .trim() || "https";
  return normalizePosFrontendBase(`${proto}://${host}/pos`);
}

/**
 * Resolve POS frontend base URL.
 * Priority: options.baseUrl → env → request host.
 */
function resolvePosFrontendBase(options = {}) {
  const fromOpt = normalizePosFrontendBase(options.baseUrl);
  if (fromOpt) return fromOpt;

  const fromEnv = normalizePosFrontendBase(
    process.env.POS_FRONTEND_URL ||
      process.env.FRONTEND_URL ||
      process.env.POS_URL ||
      process.env.ASSET_BASE_URL ||
      process.env.BASE_URL ||
      "",
  );
  if (fromEnv) return fromEnv;

  return baseFromRequest(options.req);
}

/**
 * Full confirmation URL for SMS/WhatsApp `{integration_url}` placeholder.
 */
function buildOrderIntegrationUrl(order, options = {}) {
  const orderId = order?._id != null ? String(order._id).trim() : "";
  if (!orderId) return "";

  const base = resolvePosFrontendBase(options);
  if (!base) return "";

  return `${stripTrailingSlashes(base)}/thank-you/iorder/${orderId}`;
}

module.exports = {
  normalizePosFrontendBase,
  resolvePosFrontendBase,
  buildOrderIntegrationUrl,
};

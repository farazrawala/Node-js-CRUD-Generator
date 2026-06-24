/** Subdirectory mount, e.g. BASE_PATH=/pos_admin → public URLs under /pos_admin/... */
function normalizeBasePath(raw) {
  if (raw == null || raw === "" || raw === "/") return "";
  let p = String(raw).trim();
  if (!p.startsWith("/")) p = `/${p}`;
  return p.replace(/\/$/, "");
}

function getBasePath() {
  return normalizeBasePath(process.env.BASE_PATH);
}

function withBasePath(path, base = getBasePath()) {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const b = normalizeBasePath(base);
  return `${b}${suffix}`;
}

/**
 * Apache/cPanel proxy often forwards the full URI (/pos_admin/login/admin).
 * Routers are mounted at /api, /login/admin, etc. — strip the public prefix first.
 * Falls back to /pos_admin when env is missing but the request path uses it.
 */
function createStripBasePathMiddleware() {
  const configured = getBasePath();

  return function stripBasePathMiddleware(req, res, next) {
    let prefix = configured;
    if (!prefix) {
      const pathOnly = (req.url || "/").split("?")[0];
      if (pathOnly === "/pos_admin" || pathOnly.startsWith("/pos_admin/")) {
        prefix = "/pos_admin";
      }
    }

    if (prefix) {
      const url = req.url || "/";
      if (
        url === prefix ||
        url.startsWith(`${prefix}/`) ||
        url.startsWith(`${prefix}?`)
      ) {
        req.url = url.slice(prefix.length) || "/";
      }
      res.locals.basePath = prefix;
    } else if (res.locals.basePath === undefined) {
      res.locals.basePath = "";
    }

    next();
  };
}

function getCookiePath() {
  // express-session only attaches req.session when the request path starts with
  // the cookie path. Local dev uses /login/admin; production uses /pos_admin/...
  // Path "/" works for both.
  return "/";
}

/** Secure cookies only on HTTPS (or when COOKIE_SECURE=true). */
function isSecureCookie(req) {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  return Boolean(req?.secure);
}

/**
 * Base URL for public static assets (uploads). BASE_URL often ends with /api for API calls;
 * uploads are served at /uploads, not /api/uploads.
 */
function getPublicAssetBaseUrl(req = null) {
  if (process.env.ASSET_BASE_URL) {
    return String(process.env.ASSET_BASE_URL).replace(/\/$/, "");
  }

  if (process.env.BASE_URL) {
    return String(process.env.BASE_URL)
      .replace(/\/api\/?$/i, "")
      .replace(/\/$/, "");
  }

  if (req) {
    const protocol = req.protocol || "http";
    const host =
      typeof req.get === "function"
        ? req.get("host") || ""
        : String(
            (req.headers && (req.headers.host || req.headers.Host)) || "",
          ).trim();
    const safeHost = host || "localhost:8000";
    const bp = getBasePath();
    return `${protocol}://${safeHost}${bp}`.replace(/\/$/, "");
  }

  const bp = getBasePath();
  return `http://localhost:8000${bp}`.replace(/\/$/, "");
}

/** Fix legacy full URLs that incorrectly include /api/uploads/. */
function normalizePublicUploadUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return url;
  return url.replace(/\/api\/uploads\//i, "/uploads/");
}

module.exports = {
  normalizeBasePath,
  getBasePath,
  withBasePath,
  createStripBasePathMiddleware,
  getCookiePath,
  isSecureCookie,
  getPublicAssetBaseUrl,
  normalizePublicUploadUrl,
};

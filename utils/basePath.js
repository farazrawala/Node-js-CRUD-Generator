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
  const base = getBasePath();
  return base || "/";
}

module.exports = {
  normalizeBasePath,
  getBasePath,
  withBasePath,
  createStripBasePathMiddleware,
  getCookiePath,
};

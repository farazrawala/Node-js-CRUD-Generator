const path = require("path");
const fs = require("fs");
const { getBasePath } = require("./basePath");

/** Strip BASE_PATH and common /pos_admin proxy prefix from URL paths. */
function stripBasePath(urlPath) {
  let p = String(urlPath || "").split("?")[0];
  if (!p) return p;

  const configured = getBasePath();
  if (configured) {
    if (p === configured) return "/";
    if (p.startsWith(`${configured}/`)) {
      p = p.slice(configured.length);
    }
  }

  // PM2/cPanel sometimes omits BASE_PATH — still strip known public prefix
  if (p.startsWith("/pos_admin/")) {
    p = p.slice("/pos_admin".length);
  } else if (p === "/pos_admin") {
    p = "/";
  }

  return p;
}

function resolveUploadRelativePath(urlPath) {
  const normalized = stripBasePath(urlPath);
  if (!normalized) return null;

  if (normalized.startsWith("/api/uploads/")) {
    return normalized.slice("/api/uploads/".length);
  }
  if (normalized.startsWith("/uploads/")) {
    return normalized.slice("/uploads/".length);
  }
  return null;
}

function resolveUploadRelativePathFromRequest(req) {
  const candidates = [
    req.url,
    req.path,
    req.originalUrl,
    `${req.baseUrl || ""}${req.path || ""}`,
  ];
  const seen = new Set();

  for (const raw of candidates) {
    const p = String(raw || "").split("?")[0];
    if (!p || seen.has(p)) continue;
    seen.add(p);

    const relative = resolveUploadRelativePath(p);
    if (relative != null) {
      return relative;
    }
  }

  return null;
}

function isSafeRelativeUploadPath(relative) {
  if (!relative || relative.includes("..")) return false;
  const segments = relative.split(/[/\\]/);
  return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Public GET/HEAD for /uploads/* and /api/uploads/* (no auth).
 * Returns 404 plain text when missing — never falls through to API auth.
 */
function createServePublicUploadsMiddleware(uploadsRoot) {
  const root = path.resolve(uploadsRoot);

  return function servePublicUploads(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return next();
    }

    const relative = resolveUploadRelativePathFromRequest(req);
    if (relative == null) {
      return next();
    }

    if (!isSafeRelativeUploadPath(relative)) {
      return res.status(403).type("text/plain").send("Forbidden");
    }

    const filePath = path.join(root, relative);
    const resolved = path.resolve(filePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return res.status(403).type("text/plain").send("Forbidden");
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return res.status(404).type("text/plain").send("Not found");
    }

    res.setHeader("Cache-Control", "public, max-age=604800");
    return res.sendFile(resolved, (err) => {
      if (err && !res.headersSent) {
        res.status(404).type("text/plain").send("Not found");
      }
    });
  };
}

function isPublicUploadRequest(req) {
  return resolveUploadRelativePathFromRequest(req) != null;
}

module.exports = {
  createServePublicUploadsMiddleware,
  isPublicUploadRequest,
  resolveUploadRelativePath,
  resolveUploadRelativePathFromRequest,
};

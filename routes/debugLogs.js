const express = require("express");
const path = require("path");
const router = express.Router();
const { getUserToken } = require("../service/auth");
const { withBasePath } = require("../utils/basePath");
const fileLogger = require("../utils/fileLogger");

function userIsAdmin(user) {
  if (!user?.role) return false;
  const roles = Array.isArray(user.role) ? user.role : [user.role];
  return roles.includes("ADMIN");
}

function hasValidLogKey(req) {
  const expected = process.env.DEBUG_LOG_KEY;
  if (!expected || String(expected).trim() === "") return false;
  const key = req.query.key || req.get("x-debug-log-key");
  return key === expected;
}

/** Cookie session, Bearer JWT, or DEBUG_LOG_KEY (for server troubleshooting). */
function allowDebugLogsAccess(req, res, next) {
  if (hasValidLogKey(req)) {
    return next();
  }

  let user = req.user;
  if (!user) {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;
      user = getUserToken(token);
    }
  }

  if (!user) {
    return res.status(401).json({
      success: false,
      message:
        "Authentication required. Log in as admin, send Authorization: Bearer <token>, or use ?key=DEBUG_LOG_KEY.",
    });
  }

  if (!userIsAdmin(user)) {
    return res.status(403).json({
      success: false,
      message: "Admin access required",
    });
  }

  req.user = user;
  return next();
}

router.use(allowDebugLogsAccess);

function buildDownloadUrl(req, filename) {
  const base = req.baseUrl || "/admin/debug";
  const prefix = withBasePath(base);
  let url = `${prefix}/logs/download?file=${encodeURIComponent(filename)}`;
  if (hasValidLogKey(req) && req.query.key) {
    url += `&key=${encodeURIComponent(req.query.key)}`;
  }
  return url;
}

/** HTML page — open in browser while logged in as admin (or ?key=...) */
router.get("/logs/page", (req, res) => {
  try {
    const files = fileLogger.listLogFiles();
    const basePath = withBasePath("");
    const rows =
      files.length === 0
        ? "<p>No log files yet. Restart the app and reproduce the issue.</p>"
        : `<ul>${files
            .map(
              (f) =>
                `<li><strong>${f.name}</strong> (${f.size} bytes, ${f.modified})<br>` +
                `<a href="${buildDownloadUrl(req, f.name)}" download>Download</a></li>`,
            )
            .join("")}</ul>`;

    res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Debug logs</title>
<style>body{font-family:sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem} a{color:#4a56e2}</style>
</head><body>
<h1>Server debug logs</h1>
<p>Base path: <code>${basePath || "/"}</code></p>
${rows}
<p><small>JSON list: <code>${withBasePath(req.baseUrl || "/admin/debug")}/logs</code></small></p>
</body></html>`);
  } catch (err) {
    fileLogger.error("debug logs page failed", { message: err.message });
    return res.status(500).send("Failed to load log list");
  }
});

/** List log files (JSON) */
router.get("/logs", (req, res) => {
  try {
    const files = fileLogger.listLogFiles();
    const base = req.baseUrl || "/admin/debug";
    return res.json({
      success: true,
      logDir: fileLogger.LOG_DIR,
      files,
      page: withBasePath(`${base}/logs/page`),
      downloadExample: withBasePath(
        `${base}/logs/download?file=app-${new Date().toISOString().slice(0, 10)}.log`,
      ),
    });
  } catch (err) {
    fileLogger.error("debug logs list failed", { message: err.message });
    return res.status(500).json({
      success: false,
      message: "Failed to list log files",
    });
  }
});

/** Download one log file */
router.get("/logs/download", (req, res) => {
  try {
    const filePath = fileLogger.resolveSafeLogFile(req.query.file);
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing file parameter",
        hint: "Use ?file=app-YYYY-MM-DD.log",
      });
    }

    const filename = path.basename(filePath);
    return res.download(filePath, filename, (err) => {
      if (err && !res.headersSent) {
        fileLogger.error("debug logs download failed", {
          file: req.query.file,
          message: err.message,
        });
        res.status(500).json({
          success: false,
          message: "Failed to download log file",
        });
      }
    });
  } catch (err) {
    fileLogger.error("debug logs download failed", {
      file: req.query.file,
      message: err.message,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to download log file",
    });
  }
});

module.exports = router;

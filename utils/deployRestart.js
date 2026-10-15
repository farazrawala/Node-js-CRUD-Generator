/**
 * POST /api/deploy/restart — lets the GitHub Actions deploy restart this API over HTTPS
 * (runners can't reach SSH on the live box, but HTTPS through Cloudflare works).
 *
 * Auth: `Authorization: Bearer <DEPLOY_RESTART_TOKEN>`. With no token in `.env` the route
 * answers 404, so it is off unless configured.
 *
 * It runs deploy/restart-pos-admin.sh (npm ci + pm2 restart) fully detached, so the script
 * survives pm2 killing this process mid-restart.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const fileLogger = require("./fileLogger");

const APP_DIR = path.join(__dirname, "..");
const RESTART_SCRIPT = path.join(APP_DIR, "deploy", "restart-pos-admin.sh");
const LOG_FILE = path.join(APP_DIR, "logs", "deploy-restart.log");
/** A second call inside this window (e.g. a re-run job) would race the first `npm ci`. */
const COOLDOWN_MS = 3 * 60 * 1000;

let lastRestartAt = 0;

function tokenMatches(given, expected) {
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function launchRestartScript() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // `setsid … &` inside `sh -c` double-forks: the script is re-parented away from this
  // process, so pm2's tree-kill on restart doesn't take it down with us.
  const child = spawn(
    "sh",
    ["-c", 'setsid sh "$0" >> "$1" 2>&1 < /dev/null &', RESTART_SCRIPT, LOG_FILE],
    {
      cwd: APP_DIR,
      detached: true,
      stdio: "ignore",
      // Cron-like env: no pm2-injected vars leak into `pm2 restart --update-env`.
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: os.homedir(),
        SHELL: "/bin/sh",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
    },
  );
  child.unref();
}

function deployRestartHandler(req, res) {
  const expected = String(process.env.DEPLOY_RESTART_TOKEN || "").trim();
  if (!expected) {
    return res.status(404).json({ success: false, status: 404, error: "Not found" });
  }
  if (!tokenMatches(bearerToken(req), expected)) {
    fileLogger.warn("deploy restart: rejected token", { ip: req.ip });
    return res.status(401).json({ success: false, status: 401, error: "Unauthorized" });
  }
  if (process.platform === "win32") {
    return res
      .status(501)
      .json({ success: false, status: 501, error: "Restart runs only on the Linux server" });
  }
  if (!fs.existsSync(RESTART_SCRIPT)) {
    return res
      .status(500)
      .json({ success: false, status: 500, error: "deploy/restart-pos-admin.sh is missing" });
  }

  const now = Date.now();
  if (now - lastRestartAt < COOLDOWN_MS) {
    return res.status(202).json({
      success: true,
      status: 202,
      message: "Restart already in progress",
      requestedAt: new Date(lastRestartAt).toISOString(),
    });
  }
  lastRestartAt = now;

  fileLogger.info("deploy restart: requested", {
    ip: req.ip,
    commit: req.body?.commit || null,
    run: req.body?.run || null,
  });
  // Answer first; the script restarts this process a few seconds later.
  res.on("finish", () => {
    try {
      launchRestartScript();
    } catch (err) {
      lastRestartAt = 0;
      fileLogger.error("deploy restart: could not launch script", { message: err?.message });
    }
  });
  return res.status(202).json({
    success: true,
    status: 202,
    message: "Restart started",
    requestedAt: new Date(now).toISOString(),
    pid: process.pid,
  });
}

module.exports = { deployRestartHandler };

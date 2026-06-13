const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
const MAX_DAILY_BYTES = 5 * 1024 * 1024;
const RETAIN_DAYS = 14;

const REDACT_KEYS = new Set([
  "password",
  "confirm_password",
  "current_password",
  "new_password",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
]);

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function redactValue(key, value) {
  if (REDACT_KEYS.has(String(key).toLowerCase())) {
    return "[REDACTED]";
  }
  return value;
}

function safeStringify(value, maxLen = 8000) {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      value,
      (key, val) => {
        if (key) val = redactValue(key, val);
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      0,
    );
    if (json.length <= maxLen) return json;
    return `${json.slice(0, maxLen - 20)}…[truncated]`;
  } catch {
    return String(value);
  }
}

function formatLine(level, message, meta) {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (meta == null) return `${base}\n`;
  return `${base} ${safeStringify(meta)}\n`;
}

function resolveDailyPath(kind) {
  return path.join(LOG_DIR, `${kind}-${todayKey()}.log`);
}

function appendToFile(filePath, line) {
  ensureLogDir();
  try {
    if (
      fs.existsSync(filePath) &&
      fs.statSync(filePath).size + line.length > MAX_DAILY_BYTES
    ) {
      const rotated = `${filePath}.${Date.now()}.bak`;
      fs.renameSync(filePath, rotated);
    }
    fs.appendFileSync(filePath, line, "utf8");
  } catch (err) {
    process.stderr.write(
      `[fileLogger] write failed: ${err.message}\n${line}`,
    );
  }
}

function write(level, message, meta) {
  const line = formatLine(level, message, meta);
  appendToFile(resolveDailyPath("app"), line);
  if (level === "error" || level === "warn") {
    appendToFile(resolveDailyPath("error"), line);
  }
}

function cleanupOldLogs() {
  try {
    ensureLogDir();
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, name);
      if (!fs.statSync(full).isFile()) continue;
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    }
  } catch {
    // best-effort
  }
}

function installConsoleCapture() {
  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function capture(level, origFn, args) {
    origFn(...args);
    const message = args
      .map((a) =>
        typeof a === "string" ? a : safeStringify(a, 4000),
      )
      .join(" ");
    write(level, message);
  }

  console.log = (...args) => capture("info", orig.log, args);
  console.info = (...args) => capture("info", orig.info, args);
  console.warn = (...args) => capture("warn", orig.warn, args);
  console.error = (...args) => capture("error", orig.error, args);
}

function resolveSafeLogFile(filename) {
  if (!filename || typeof filename !== "string") return null;
  const base = path.basename(filename.trim());
  if (!base || base !== filename.trim()) return null;
  if (!/\.log(\.[0-9]+\.bak)?$/i.test(base)) return null;
  const full = path.join(LOG_DIR, base);
  if (!full.startsWith(LOG_DIR)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

function listLogFiles() {
  ensureLogDir();
  return fs
    .readdirSync(LOG_DIR)
    .filter((name) => name.endsWith(".log") || name.includes(".log."))
    .map((name) => {
      const full = path.join(LOG_DIR, name);
      const stat = fs.statSync(full);
      return {
        name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

function logRequestError(req, err, extra) {
  write("error", `${req.method} ${req.originalUrl || req.url}`, {
    message: err?.message || String(err),
    stack: err?.stack,
    ...extra,
  });
}

function logStartup(meta) {
  cleanupOldLogs();
  write("info", "Server starting", meta);
}

const fileLogger = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
  installConsoleCapture,
  listLogFiles,
  resolveSafeLogFile,
  logRequestError,
  logStartup,
  LOG_DIR,
};

module.exports = fileLogger;

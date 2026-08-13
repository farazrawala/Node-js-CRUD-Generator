const { getUserToken } = require("../../service/auth");
const { getThresholds } = require("./config");

function userIsAdmin(user) {
  if (!user?.role) return false;
  const roles = Array.isArray(user.role) ? user.role : [user.role];
  return roles.includes("ADMIN");
}

function hasMonitorKey(req) {
  const expected =
    process.env.MONITORING_KEY || process.env.DEBUG_LOG_KEY || "";
  if (!expected || String(expected).trim() === "") return false;
  const key = req.query.key || req.get("x-monitoring-key") || req.get("x-debug-log-key");
  return key === expected;
}

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60000;
  const max = 180;
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > max) {
    return res.status(429).json({ success: false, message: "Too many monitoring requests" });
  }
  return next();
}

function allowMonitoringAccess(req, res, next) {
  const thresholds = getThresholds();
  if (!thresholds.requireAuth) return next();
  if (hasMonitorKey(req)) return next();

  let user = req.user;
  if (!user) {
    const authHeader = req.headers.authorization;
    const cookieToken = req.cookies?.token;
    const token = authHeader
      ? authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader
      : cookieToken;
    if (token) user = getUserToken(token);
  }

  if (!user) {
    if (req.accepts("html") && !String(req.path).includes("/api/")) {
      return res.status(401).type("html").send(loginPage());
    }
    return res.status(401).json({
      success: false,
      message: "Admin login required to view monitoring.",
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

function loginPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Monitoring login</title>
<style>body{font-family:sans-serif;background:#0b1220;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#121a2b;border:1px solid #22304a;border-radius:12px;padding:24px;max-width:420px}
a{color:#5b8cff}</style></head><body><div class="card">
<h1>Monitoring is protected</h1>
<p>Log in as an admin, then open this page again.</p>
<p><a href="/pos_admin/login/admin">Go to admin login</a></p>
</div></body></html>`;
}

module.exports = {
  allowMonitoringAccess,
  rateLimit,
  userIsAdmin,
};

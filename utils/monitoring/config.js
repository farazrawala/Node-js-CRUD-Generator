/**
 * Monitoring is on by default. Set MONITORING_ENABLED=false to disable.
 */
function isMonitoringEnabled() {
  return process.env.MONITORING_ENABLED !== "false";
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function getThresholds() {
  return {
    lagWarnMs: num("MONITOR_LAG_WARN_MS", 50),
    lagCritMs: num("MONITOR_LAG_CRIT_MS", 100),
    eluWarn: num("MONITOR_ELU_WARN", 0.7),
    eluCrit: num("MONITOR_ELU_CRIT", 0.9),
    slowMs: num("MONITOR_SLOW_MS", 500),
    verySlowMs: num("MONITOR_VERY_SLOW_MS", 1000),
    criticalSlowMs: num("MONITOR_CRITICAL_SLOW_MS", 3000),
    mongoSlowMs: num("MONITOR_MONGO_SLOW_MS", 500),
    heapWarn: num("MONITOR_HEAP_WARN", 0.7),
    heapCrit: num("MONITOR_HEAP_CRIT", 0.85),
    errorRateWarn: num("MONITOR_ERROR_RATE_WARN", 2),
    errorRateCrit: num("MONITOR_ERROR_RATE_CRIT", 5),
    p95WarnMs: num("MONITOR_P95_WARN_MS", 500),
    p95CritMs: num("MONITOR_P95_CRIT_MS", 1000),
    p99WarnMs: num("MONITOR_P99_WARN_MS", 1000),
    p99CritMs: num("MONITOR_P99_CRIT_MS", 2000),
    cpuWarn: num("MONITOR_CPU_WARN", 70),
    cpuCrit: num("MONITOR_CPU_CRIT", 90),
    rpsWarn: num("MONITOR_RPS_WARN", 200),
    rpsCrit: num("MONITOR_RPS_CRIT", 500),
    mongoLatencyWarnMs: num("MONITOR_MONGO_LATENCY_WARN_MS", 200),
    mongoLatencyCritMs: num("MONITOR_MONGO_LATENCY_CRIT_MS", 500),
    alertConsecutive: num("MONITOR_ALERT_CONSECUTIVE", 2),
    slowQueryLimit: num("MONITOR_SLOW_QUERY_LIMIT", 500),
    requireAuth: bool("MONITORING_REQUIRE_AUTH", false),
    depCheckMs: num("MONITOR_DEP_CHECK_MS", 10000),
    systemSampleMs: num("MONITOR_SYSTEM_SAMPLE_MS", 30000),
  };
}

const SKIP_SUFFIXES = [
  "/metrics",
  "/api/metrics",
  "/api/health",
  "/api/version",
  "/monitor",
  "/api/monitor/live",
  "/api/monitoring",
];

function requestPath(req) {
  let pathOnly = String(req.originalUrl || req.url || req.path || "").split(
    "?",
  )[0];
  if (pathOnly.startsWith("http://") || pathOnly.startsWith("https://")) {
    try {
      pathOnly = new URL(pathOnly).pathname;
    } catch {
      // keep original
    }
  }
  pathOnly = pathOnly.replace(/^\/pos_admin(?=\/|$)/, "") || "/";
  return pathOnly;
}

function shouldSkipRequestLog(req) {
  const pathOnly = requestPath(req);
  if (SKIP_SUFFIXES.includes(pathOnly)) return true;
  if (pathOnly.startsWith("/uploads/") || pathOnly.startsWith("/api/uploads/")) {
    return true;
  }
  if (pathOnly === "/monitor" || pathOnly.startsWith("/monitor/")) return true;
  if (pathOnly.startsWith("/api/monitoring")) return true;
  return false;
}

module.exports = {
  isMonitoringEnabled,
  getThresholds,
  shouldSkipRequestLog,
  requestPath,
};

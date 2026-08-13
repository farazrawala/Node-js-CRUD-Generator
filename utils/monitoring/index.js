const path = require("path");
const { isMonitoringEnabled, getThresholds, shouldSkipRequestLog, requestPath } = require("./config");
const { createRequestLogger } = require("./logger");
const { createPrometheusMetrics } = require("./prometheus");
const { createStore } = require("./store");
const { createCollectors } = require("./collectors");
const { createMonitoringRouter, liveHandler } = require("./api");
const { allowMonitoringAccess, rateLimit } = require("./auth");
const { createRequestId, runWithRequestContext } = require("./normalize");
const {
  initSentry,
  captureException,
  setupExpressErrorHandler,
} = require("./sentry");

function initMonitoring() {
  const sentry = initSentry();
  const runtime = createStore();
  const prometheus = createPrometheusMetrics(runtime);
  const collectors = createCollectors(runtime);
  runtime.collectors = collectors;
  const { logger, middleware: pinoMiddleware } = createRequestLogger();
  runtime.logger = logger;

  function requestIdMiddleware(req, res, next) {
    const requestId = req.headers["x-request-id"] || createRequestId();
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);
    if (shouldSkipRequestLog(req)) return next();
    return runWithRequestContext(
      { requestId, method: req.method, route: requestPath(req) },
      () => next(),
    );
  }

  return {
    sentry,
    logger,
    pinoMiddleware,
    prometheus,
    runtime,
    requestIdMiddleware,
  };
}

function applyRequestMonitoring(app, monitoring) {
  app.use(monitoring.requestIdMiddleware);
  app.use(monitoring.pinoMiddleware);
  app.use(monitoring.prometheus.middleware);
}

function registerMetricsRoute(app, monitoring) {
  app.get("/metrics", monitoring.prometheus.metricsHandler);
  app.get("/api/metrics", monitoring.prometheus.metricsHandler);
  app.get(
    "/api/monitor/live",
    rateLimit,
    allowMonitoringAccess,
    liveHandler(monitoring.runtime),
  );
  app.use(
    "/api/monitoring",
    rateLimit,
    allowMonitoringAccess,
    createMonitoringRouter(monitoring.runtime),
  );
  app.get("/monitor", allowMonitoringAccess, (req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
  });
}

function setupMonitoringErrorHandling(app) {
  setupExpressErrorHandler(app);
}

function attachHttpServer(server, monitoring) {
  if (!server || !monitoring?.runtime) return;
  const http = monitoring.runtime.store.http;
  server.on("connection", (socket) => {
    http.opened += 1;
    http.active += 1;
    socket.on("close", () => {
      http.active = Math.max(0, http.active - 1);
      http.closed += 1;
    });
  });
}

function recordExpressError(monitoring, req, err) {
  if (!monitoring?.runtime) return;
  if (req) req.__monitorError = err;
  monitoring.runtime.pushLog("error", err?.message || "express_error", {
    requestId: req?.requestId,
    route: req ? require("./config").requestPath(req) : null,
  });
}

function logMonitoringStartup(monitoring, port) {
  const lines = [
    "📊 Monitoring enabled",
    "   • pino-http — request logs",
    `   • prom-client — GET /metrics, GET /api/metrics (port ${port})`,
    `   • live UI — http://localhost:${port}/monitor`,
    `   • APIs — GET /api/monitoring/*`,
  ];

  if (monitoring.sentry.enabled) {
    lines.push("   • Sentry — errors and stack traces");
  } else {
    lines.push(
      `   • Sentry — skipped (${monitoring.sentry.reason || "disabled"})`,
    );
  }

  console.log(lines.join("\n"));
}

module.exports = {
  isMonitoringEnabled,
  getThresholds,
  initMonitoring,
  applyRequestMonitoring,
  registerMetricsRoute,
  setupMonitoringErrorHandling,
  logMonitoringStartup,
  captureException,
  attachHttpServer,
  recordExpressError,
};

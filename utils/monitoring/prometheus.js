const client = require("prom-client");
const { shouldSkipRequestLog, requestPath } = require("./config");
const {
  createRequestId,
  normalizeRoute,
  maskIp,
  sanitizeMessage,
} = require("./normalize");

function createPrometheusMetrics(runtime) {
  const { store, recordRequest, thresholds } = runtime;
  const register = new client.Registry();
  register.setDefaultLabels({
    app: process.env.APP_NAME || "pos-api",
    env: process.env.APP_ENV || process.env.NODE_ENV || "development",
  });

  client.collectDefaultMetrics({ register });

  const httpRequestDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [register],
  });

  const httpRequestsTotal = new client.Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status_code"],
    registers: [register],
  });

  const httpRequestsInFlight = new client.Gauge({
    name: "http_requests_in_flight",
    help: "Number of HTTP requests currently being handled",
    registers: [register],
  });

  const applicationErrorsTotal = new client.Counter({
    name: "application_errors_total",
    help: "Application errors by type",
    labelNames: ["type"],
    registers: [register],
  });

  const processCpuUsage = new client.Gauge({
    name: "process_cpu_usage",
    help: "Process CPU usage percent",
    registers: [register],
  });

  const eventLoopLag = new client.Gauge({
    name: "nodejs_event_loop_lag_seconds",
    help: "Event loop lag in seconds",
    registers: [register],
  });

  const heapUsed = new client.Gauge({
    name: "nodejs_heap_used_bytes",
    help: "Heap used bytes",
    registers: [register],
  });

  const heapTotal = new client.Gauge({
    name: "nodejs_heap_total_bytes",
    help: "Heap total bytes",
    registers: [register],
  });

  function middleware(req, res, next) {
    if (shouldSkipRequestLog(req)) {
      return next();
    }

    const requestId = req.requestId || createRequestId();
    req.requestId = requestId;
    if (!res.getHeader("X-Request-ID")) res.setHeader("X-Request-ID", requestId);

    const started = process.hrtime.bigint();
    store.inFlight += 1;
    httpRequestsInFlight.inc();
    const endTimer = httpRequestDuration.startTimer();

    res.on("finish", () => {
      store.inFlight = Math.max(0, store.inFlight - 1);
      httpRequestsInFlight.dec();
      const route = normalizeRoute(requestPath(req), req);
      const statusCode = String(res.statusCode);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const labels = { method: req.method, route, status_code: statusCode };
      endTimer(labels);
      httpRequestsTotal.inc(labels);

      const sample = store.lastSample;
      if (sample) {
        processCpuUsage.set(sample.cpuPercent || 0);
        eventLoopLag.set((sample.lagMs || 0) / 1000);
        heapUsed.set(sample.memory?.heapUsed || 0);
        heapTotal.set(sample.memory?.heapTotal || 0);
      }

      const status = Number(res.statusCode);
      const entry = {
        requestId,
        ts: Date.now(),
        method: req.method,
        route,
        status,
        durationMs: Math.round(durationMs),
        ip: maskIp(req.ip || req.socket?.remoteAddress),
        userAgent: String(req.get("user-agent") || "").slice(0, 180),
        bytesOut: Number(res.getHeader("content-length")) || 0,
        message: status >= 400 ? sanitizeMessage(res.statusMessage || `HTTP ${status}`) : null,
        error: req.__monitorError
          ? {
              name: req.__monitorError.name,
              message: sanitizeMessage(req.__monitorError.message),
            }
          : null,
        dbOps: [],
      };
      recordRequest(entry);
      if (status >= 500) applicationErrorsTotal.inc({ type: "http_5xx" });
      else if (status >= 400) applicationErrorsTotal.inc({ type: "http_4xx" });
      if (String(req.headers.connection || "").toLowerCase() !== "close") {
        store.http.keepAlive += 1;
      }
    });

    next();
  }

  async function metricsHandler(req, res) {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  }

  return {
    register,
    middleware,
    metricsHandler,
    applicationErrorsTotal,
    thresholds,
  };
}

module.exports = {
  createPrometheusMetrics,
};

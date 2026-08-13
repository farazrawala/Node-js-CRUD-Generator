const { RingBuffer, RollingHistogram, MultiResolutionSeries } = require("./buffers");
const { getThresholds } = require("./config");
const { classifyError, sanitizeMessage } = require("./normalize");

function createStore() {
  const thresholds = getThresholds();
  const startedAt = Date.now();

  const store = {
    startedAt,
    inFlight: 0,
    totals: {
      requests: 0,
      completed: 0,
      failed: 0,
      status2: 0,
      status3: 0,
      status4: 0,
      status5: 0,
      bytesOut: 0,
    },
    latency: new RollingHistogram(),
    routes: new Map(),
    recentFailures: new RingBuffer(80),
    slowRequests: new RingBuffer(80),
    traces: new Map(),
    errorGroups: new Map(),
    statusCounts: Object.create(null),
    slowQueries: new RingBuffer(thresholds.slowQueryLimit),
    mongo: {
      status: "unknown",
      dbName: "",
      queries: 0,
      failed: 0,
      latency: new RollingHistogram(),
      ops: Object.create(null),
      pool: { size: 0, available: 0, pending: 0, current: 0 },
      lastError: null,
      lastChecked: 0,
      lastLatencyMs: 0,
    },
    http: { active: 0, opened: 0, closed: 0, keepAlive: 0 },
    logs: new RingBuffer(400),
    series: new MultiResolutionSeries(),
    alerts: new Map(),
    alertHistory: new RingBuffer(80),
    lastSample: null,
    heapTrend: new RingBuffer(12),
  };

  function routeKey(method, route) {
    return `${method} ${route}`;
  }

  function ensureRoute(method, route) {
    const key = routeKey(method, route);
    if (!store.routes.has(key)) {
      store.routes.set(key, {
        method,
        route,
        count: 0,
        success: 0,
        failures: 0,
        lastTs: 0,
        latency: new RollingHistogram(),
      });
    }
    return store.routes.get(key);
  }

  function rememberTrace(trace) {
    store.traces.set(trace.requestId, trace);
    if (store.traces.size > 400) {
      const first = store.traces.keys().next().value;
      store.traces.delete(first);
    }
  }

  function recordRequest(entry) {
    const status = Number(entry.status) || 0;
    const seconds = (Number(entry.durationMs) || 0) / 1000;
    store.totals.requests += 1;
    store.totals.completed += 1;
    store.latency.observe(seconds);
    if (status >= 200 && status < 300) store.totals.status2 += 1;
    else if (status >= 300 && status < 400) store.totals.status3 += 1;
    else if (status >= 400 && status < 500) store.totals.status4 += 1;
    else if (status >= 500) store.totals.status5 += 1;
    if (status >= 400) store.totals.failed += 1;
    store.statusCounts[status] = (store.statusCounts[status] || 0) + 1;
    if (entry.bytesOut) store.totals.bytesOut += entry.bytesOut;

    const route = ensureRoute(entry.method, entry.route);
    route.count += 1;
    route.lastTs = entry.ts;
    route.latency.observe(seconds);
    if (status >= 400) route.failures += 1;
    else route.success += 1;

    rememberTrace(entry);

    if (status >= 400) {
      store.recentFailures.push(entry);
      store.logs.push({
        ts: entry.ts,
        level: status >= 500 ? "error" : "warn",
        message: sanitizeMessage(
          entry.error?.message || entry.message || `HTTP ${status} ${entry.route}`,
        ),
        requestId: entry.requestId,
        route: entry.route,
      });
      const type = classifyError(entry.error, status);
      const message = sanitizeMessage(entry.error?.message || entry.message || `HTTP ${status}`);
      const groupKey = `${type}:${message}`;
      const group = store.errorGroups.get(groupKey) || {
        type,
        message,
        count: 0,
        firstSeen: entry.ts,
        lastSeen: entry.ts,
        status,
        route: entry.route,
        method: entry.method,
        requestId: entry.requestId,
      };
      group.count += 1;
      group.lastSeen = entry.ts;
      group.requestId = entry.requestId;
      store.errorGroups.set(groupKey, group);
    }

    if (entry.durationMs >= thresholds.slowMs) {
      store.slowRequests.push(entry);
    }
  }

  function recordMongo(op) {
    store.mongo.queries += 1;
    store.mongo.latency.observe((op.durationMs || 0) / 1000);
    store.mongo.lastLatencyMs = op.durationMs || 0;
    store.mongo.ops[op.operation] = (store.mongo.ops[op.operation] || 0) + 1;
    if (op.failed) {
      store.mongo.failed += 1;
      store.mongo.lastError = sanitizeMessage(op.error || "query failed");
    }
    if (op.durationMs >= thresholds.mongoSlowMs || op.failed) {
      store.slowQueries.push(op);
    }
    const ctxTrace = op.requestId ? store.traces.get(op.requestId) : null;
    if (ctxTrace) {
      ctxTrace.dbOps = ctxTrace.dbOps || [];
      if (ctxTrace.dbOps.length < 20) {
        ctxTrace.dbOps.push({
          operation: op.operation,
          collection: op.collection,
          durationMs: op.durationMs,
          ts: op.ts,
          status: op.failed ? "error" : "ok",
        });
      }
    }
  }

  function pushLog(level, message, meta = {}) {
    store.logs.push({
      ts: Date.now(),
      level,
      message: sanitizeMessage(message, 400),
      requestId: meta.requestId || null,
      route: meta.route || null,
    });
  }

  function listRoutes() {
    return [...store.routes.values()].map((r) => ({
      method: r.method,
      route: r.route,
      count: r.count,
      success: r.success,
      failures: r.failures,
      errorRate: r.count ? (r.failures / r.count) * 100 : 0,
      avgMs: Math.round(r.latency.avg() * 1000),
      p50: Math.round(r.latency.percentile(0.5) * 1000),
      p95: Math.round(r.latency.percentile(0.95) * 1000),
      p99: Math.round(r.latency.percentile(0.99) * 1000),
      maxMs: Math.round(r.latency.max * 1000),
      lastTs: r.lastTs,
    }));
  }

  return {
    store,
    thresholds,
    ensureRoute,
    recordRequest,
    recordMongo,
    rememberTrace,
    pushLog,
    listRoutes,
  };
}

module.exports = {
  createStore,
};

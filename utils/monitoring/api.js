const express = require("express");
const { buildLiveSnapshot } = require("./snapshot");

function createMonitoringRouter(runtime) {
  const router = express.Router();
  const { store, listRoutes, thresholds } = runtime;

  router.get("/overview", (req, res) => {
    const sample = store.lastSample || {};
    res.json({
      ts: Date.now(),
      health: sample.health,
      sample,
      totals: store.totals,
      alerts: [...store.alerts.values()],
      thresholds,
    });
  });

  router.get("/system", (req, res) => {
    const sample = store.lastSample || {};
    res.json({
      system: sample.system,
      memory: sample.memory,
      cpuPercent: sample.cpuPercent,
      gc: sample.gc,
      handles: sample.handles,
      http: sample.http,
      v8: sample.v8,
      possibleLeak: sample.possibleLeak,
    });
  });

  router.get("/requests", (req, res) => {
    res.json({
      totals: store.totals,
      latency: {
        avgMs: Math.round((store.latency.avg() || 0) * 1000),
        p50: Math.round(store.latency.percentile(0.5) * 1000),
        p75: Math.round(store.latency.percentile(0.75) * 1000),
        p95: Math.round(store.latency.percentile(0.95) * 1000),
        p99: Math.round(store.latency.percentile(0.99) * 1000),
        maxMs: Math.round(store.latency.max * 1000),
      },
      inFlight: store.inFlight,
      statusCounts: store.statusCounts,
      sample: store.lastSample,
    });
  });

  router.get("/routes", (req, res) => {
    const method = String(req.query.method || "").toUpperCase();
    const sort = String(req.query.sort || "requests");
    let rows = listRoutes();
    if (method) rows = rows.filter((r) => r.method === method);
    const sorters = {
      requests: (a, b) => b.count - a.count,
      slowest: (a, b) => b.avgMs - a.avgMs,
      errors: (a, b) => b.errorRate - a.errorRate,
      p95: (a, b) => b.p95 - a.p95,
      failures: (a, b) => b.failures - a.failures,
    };
    rows.sort(sorters[sort] || sorters.requests);
    res.json({ routes: rows.slice(0, 100) });
  });

  router.get("/errors", (req, res) => {
    const groups = [...store.errorGroups.values()].sort((a, b) => b.count - a.count);
    res.json({
      groups: groups.slice(0, 50),
      recent: store.recentFailures.last(50).reverse(),
      statusCounts: store.statusCounts,
    });
  });

  router.get("/slow-requests", (req, res) => {
    res.json({
      slow: store.slowRequests.last(80).reverse(),
      thresholds: {
        slowMs: thresholds.slowMs,
        verySlowMs: thresholds.verySlowMs,
        criticalSlowMs: thresholds.criticalSlowMs,
      },
    });
  });

  router.get("/database", (req, res) => {
    res.json({
      mongo: {
        ...store.mongo,
        avgMs: Math.round(store.mongo.latency.avg() * 1000),
        p95Ms: Math.round(store.mongo.latency.percentile(0.95) * 1000),
      },
      slowQueries: store.slowQueries.last(80).reverse(),
    });
  });

  router.get("/dependencies", (req, res) => {
    res.json({ dependencies: runtime.collectors.getDependencies() });
  });

  router.get("/alerts", (req, res) => {
    res.json({
      alerts: [...store.alerts.values()],
      history: store.alertHistory.toArray().reverse(),
    });
  });

  router.get("/history", (req, res) => {
    const range = String(req.query.range || "15m");
    res.json({ range, points: store.series.forRange(range) });
  });

  router.get("/logs", (req, res) => {
    const level = String(req.query.level || "").toLowerCase();
    const q = String(req.query.q || "").toLowerCase();
    let rows = store.logs.toArray().reverse();
    if (level) rows = rows.filter((r) => r.level === level);
    if (q) {
      rows = rows.filter(
        (r) =>
          String(r.message).toLowerCase().includes(q) ||
          String(r.requestId || "").toLowerCase().includes(q) ||
          String(r.route || "").toLowerCase().includes(q),
      );
    }
    res.json({ logs: rows.slice(0, 200) });
  });

  router.get("/request/:requestId", (req, res) => {
    const trace = store.traces.get(req.params.requestId);
    if (!trace) {
      return res.status(404).json({ success: false, message: "Request not found in recent buffer" });
    }
    res.json({ request: trace });
  });

  return router;
}

function liveHandler(runtime) {
  return (req, res) => {
    res.json(buildLiveSnapshot(runtime));
  };
}

module.exports = {
  createMonitoringRouter,
  liveHandler,
};

function round(n, d = 0) {
  const f = 10 ** d;
  return Math.round((Number(n) || 0) * f) / f;
}

function buildLiveSnapshot(runtime) {
  const { store, listRoutes } = runtime;
  const sample = store.lastSample || {};
  const routes = listRoutes().sort((a, b) => b.count - a.count);

  return {
    ts: Date.now(),
    uptimeSec: Math.round(process.uptime()),
    inFlight: store.inFlight,
    totalRequests: store.totals.requests,
    totalErrors: store.totals.status5,
    totalFailures: store.totals.failed,
    completed: store.totals.completed,
    rpm: round(sample.rpm, 1),
    rps: round(sample.rps, 2),
    avgMs: Math.round(sample.avgMs || 0),
    p50Ms: Math.round(sample.p50Ms || 0),
    p75Ms: Math.round(sample.p75Ms || 0),
    p95Ms: Math.round(sample.p95Ms || 0),
    p99Ms: Math.round(sample.p99Ms || 0),
    maxMs: Math.round(sample.maxMs || 0),
    memoryBytes: sample.rss || 0,
    eventLoopLagMs: Math.round(sample.lagMs || 0),
    lagAvgMs: Math.round(sample.lagAvgMs || 0),
    lagP95Ms: Math.round(sample.lagP95Ms || 0),
    lagP99Ms: Math.round(sample.lagP99Ms || 0),
    lagMaxMs: Math.round(sample.lagMaxMs || 0),
    elu: round((sample.elu || 0) * 100, 1),
    cpuPercent: round(sample.cpuPercent, 1),
    heapPct: round((sample.heapPct || 0) * 100, 1),
    health: sample.health || { score: 100, status: "healthy", reasons: [] },
    statusCounts: {
      "2xx": store.totals.status2,
      "3xx": store.totals.status3,
      "4xx": store.totals.status4,
      "5xx": store.totals.status5,
      byCode: { ...store.statusCounts },
    },
    routes: routes.slice(0, 40),
    failedRoutes: routes.filter((r) => r.failures > 0).slice(0, 20),
    recentFailures: store.recentFailures.last(30).reverse(),
    slowRequests: store.slowRequests.last(30).reverse(),
    series: store.series.forRange("1m"),
  };
}

module.exports = {
  buildLiveSnapshot,
};

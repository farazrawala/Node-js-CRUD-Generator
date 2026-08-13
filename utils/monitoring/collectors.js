const os = require("os");
const v8 = require("v8");
const mongoose = require("mongoose");
const {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} = require("perf_hooks");
const { getRequestContext, sanitizeMessage } = require("./normalize");

const MONGO_SKIP = new Set([
  "ping",
  "hello",
  "ismaster",
  "isMaster",
  "saslStart",
  "saslContinue",
  "endSessions",
  "buildInfo",
  "getMore",
]);

function nsToMs(ns) {
  return Number(ns || 0) / 1e6;
}

function createCollectors(runtime) {
  const { store, thresholds, recordMongo, pushLog } = runtime;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = process.hrtime.bigint();
  let lastDepCheck = 0;
  let lastSystemSample = 0;
  let lastAlertCheck = 0;
  const gc = {
    count: 0,
    minor: 0,
    major: 0,
    durationMs: 0,
    maxMs: 0,
    lastMs: 0,
  };

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = entry.duration || 0;
        gc.count += 1;
        gc.durationMs += ms;
        gc.lastMs = ms;
        if (ms > gc.maxMs) gc.maxMs = ms;
        const kind = entry.detail?.kind ?? entry.kind;
        if (kind === 1 || kind === "minor") gc.minor += 1;
        else gc.major += 1;
      }
    });
    observer.observe({ entryTypes: ["gc"], buffered: true });
  } catch {
    // GC observer not available on this runtime
  }

  function sampleCpu() {
    const usage = process.cpuUsage(lastCpu);
    const elapsedNs = process.hrtime.bigint() - lastCpuAt;
    lastCpu = process.cpuUsage();
    lastCpuAt = process.hrtime.bigint();
    const elapsedMs = Number(elapsedNs) / 1e6;
    if (elapsedMs <= 0) return 0;
    return ((usage.user + usage.system) / 1000 / elapsedMs) * 100;
  }

  function eventLoopStats() {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    const stats = {
      lagMs: nsToMs(delay.mean),
      lagAvgMs: nsToMs(delay.mean),
      lagP50Ms: nsToMs(delay.percentile(50)),
      lagP95Ms: nsToMs(delay.percentile(95)),
      lagP99Ms: nsToMs(delay.percentile(99)),
      lagMaxMs: nsToMs(delay.max),
      elu: elu.utilization || 0,
    };
    delay.reset();
    return stats;
  }

  function memoryStats() {
    const mem = process.memoryUsage();
    const heapPct = mem.heapTotal ? mem.heapUsed / mem.heapTotal : 0;
    return {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers || 0,
      heapPct,
      systemTotal: os.totalmem(),
      systemFree: os.freemem(),
      systemUsedPct: os.totalmem() ? 1 - os.freemem() / os.totalmem() : 0,
    };
  }

  function systemInfo() {
    return {
      nodeVersion: process.version,
      pid: process.pid,
      env: process.env.APP_ENV || process.env.NODE_ENV || "development",
      processUptimeSec: Math.round(process.uptime()),
      osUptimeSec: Math.round(os.uptime()),
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpuCount: os.cpus()?.length || 0,
    };
  }

  function handleStats() {
    const handles = typeof process._getActiveHandles === "function"
      ? process._getActiveHandles()
      : [];
    const requests = typeof process._getActiveRequests === "function"
      ? process._getActiveRequests()
      : [];
    const byType = Object.create(null);
    for (const handle of handles) {
      const name = handle?.constructor?.name || "Unknown";
      byType[name] = (byType[name] || 0) + 1;
    }
    return {
      handles: handles.length,
      requests: requests.length,
      byType,
    };
  }

  function mongoPool() {
    try {
      const client = mongoose.connection.getClient?.();
      const pool = client?.s?.sessionPool || client?.topology?.s?.server?.s?.pool;
      const counts = client?.topology?.s?.servers
        ? [...client.topology.s.servers.values()]
        : [];
      let current = 0;
      let available = 0;
      let pending = 0;
      for (const server of counts) {
        const p = server?.s?.pool;
        if (!p) continue;
        current += p.totalConnectionCount || p.currentCheckedOutCount || 0;
        available += p.availableConnectionCount || 0;
        pending += p.waitQueueSize || p.waitQueueSize || 0;
      }
      store.mongo.pool = {
        size: current + available,
        current,
        available,
        pending,
      };
    } catch {
      // pool internals vary by driver version
    }
  }

  async function checkMongo() {
    const started = Date.now();
    try {
      const state = mongoose.connection.readyState;
      store.mongo.status =
        state === 1 ? "up" : state === 2 ? "connecting" : "down";
      store.mongo.dbName = mongoose.connection.db?.databaseName || "";
      if (state === 1 && mongoose.connection.db) {
        await mongoose.connection.db.admin().command({ ping: 1 });
        store.mongo.lastLatencyMs = Date.now() - started;
      }
      store.mongo.lastChecked = Date.now();
      mongoPool();
    } catch (err) {
      store.mongo.status = "down";
      store.mongo.lastError = sanitizeMessage(err.message);
      store.mongo.lastChecked = Date.now();
      store.mongo.lastLatencyMs = Date.now() - started;
    }
  }

  async function checkRedis() {
    const started = Date.now();
    const result = {
      service: "Redis",
      status: "skipped",
      latencyMs: 0,
      lastChecked: Date.now(),
      lastFailure: null,
    };
    try {
      const redisCache = require("../redisCache");
      if (!redisCache.isRedisConfigured()) {
        result.status = "disabled";
        return result;
      }
      const ok = await redisCache.isRedisConnected();
      result.latencyMs = Date.now() - started;
      result.status = ok ? "up" : "down";
      if (!ok) result.lastFailure = Date.now();
    } catch (err) {
      result.status = "down";
      result.latencyMs = Date.now() - started;
      result.lastFailure = Date.now();
      result.error = sanitizeMessage(err.message);
    }
    return result;
  }

  function attachMongoCommands() {
    const attach = () => {
      const client = mongoose.connection.getClient?.();
      if (!client || client.__posMonitorAttached) return;
      client.__posMonitorAttached = true;
      const pending = new Map();
      client.on("commandStarted", (event) => {
        if (MONGO_SKIP.has(event.commandName)) return;
        const ctx = getRequestContext();
        pending.set(event.requestId, {
          ts: Date.now(),
          operation: event.commandName,
          collection: collectionName(event),
          requestId: ctx?.requestId || null,
          route: ctx?.route || null,
        });
      });
      client.on("commandSucceeded", (event) => {
        const started = pending.get(event.requestId);
        pending.delete(event.requestId);
        if (!started) return;
        recordMongo({
          ...started,
          durationMs: event.duration,
          failed: false,
        });
      });
      client.on("commandFailed", (event) => {
        const started = pending.get(event.requestId);
        pending.delete(event.requestId);
        recordMongo({
          ...(started || {
            ts: Date.now(),
            operation: event.commandName,
            collection: "unknown",
          }),
          durationMs: event.duration,
          failed: true,
          error: event.failure?.message || "command failed",
        });
      });
    };
    if (mongoose.connection.readyState === 1) attach();
    mongoose.connection.on("connected", attach);
  }

  function collectionName(event) {
    const cmd = event.command || {};
    const raw =
      cmd.collection ||
      cmd.find ||
      cmd.insert ||
      cmd.update ||
      cmd.delete ||
      cmd.aggregate ||
      cmd.createIndexes ||
      cmd.count ||
      cmd.distinct ||
      event.commandName ||
      "unknown";
    return typeof raw === "string" ? raw : event.commandName || "unknown";
  }

  function possibleLeak(mem) {
    store.heapTrend.push({ ts: Date.now(), heapUsed: mem.heapUsed });
    const samples = store.heapTrend.toArray();
    if (samples.length < 8) return false;
    let increases = 0;
    for (let i = 1; i < samples.length; i += 1) {
      if (samples[i].heapUsed > samples[i - 1].heapUsed * 1.02) increases += 1;
    }
    return increases >= 7 && mem.heapPct > 0.6;
  }

  function evaluateAlerts(sample) {
    const checks = [
      ["error_rate", sample.errorRate, thresholds.errorRateWarn, thresholds.errorRateCrit, "%"],
      ["p95_latency", sample.p95Ms, thresholds.p95WarnMs, thresholds.p95CritMs, "ms"],
      ["p99_latency", sample.p99Ms, thresholds.p99WarnMs, thresholds.p99CritMs, "ms"],
      ["cpu", sample.cpuPercent, thresholds.cpuWarn, thresholds.cpuCrit, "%"],
      ["heap", sample.heapPct * 100, thresholds.heapWarn * 100, thresholds.heapCrit * 100, "%"],
      ["event_loop_lag", sample.lagMs, thresholds.lagWarnMs, thresholds.lagCritMs, "ms"],
      ["event_loop_util", sample.elu * 100, thresholds.eluWarn * 100, thresholds.eluCrit * 100, "%"],
      ["rps", sample.rps, thresholds.rpsWarn, thresholds.rpsCrit, ""],
      ["mongo_latency", sample.mongoLatencyMs, thresholds.mongoLatencyWarnMs, thresholds.mongoLatencyCritMs, "ms"],
      ["5xx", sample.status5Rate, thresholds.errorRateWarn, thresholds.errorRateCrit, "%"],
    ];

    for (const [name, value, warn, crit, unit] of checks) {
      let level = "healthy";
      if (value >= crit) level = "critical";
      else if (value >= warn) level = "warning";
      const prev = store.alerts.get(name) || { level: "healthy", streak: 0, since: Date.now() };
      if (level === prev.level) prev.streak += 1;
      else {
        prev.level = level;
        prev.streak = 1;
        prev.since = Date.now();
      }
      prev.value = value;
      prev.unit = unit;
      prev.name = name;
      if (level !== "healthy" && prev.streak >= thresholds.alertConsecutive) {
        prev.state = level;
        if (!prev.openedAt) prev.openedAt = Date.now();
      } else if (level === "healthy" && prev.state && prev.state !== "resolved") {
        prev.state = "resolved";
        prev.resolvedAt = Date.now();
        store.alertHistory.push({ ...prev, ts: Date.now() });
        prev.openedAt = null;
      } else if (level === "healthy") {
        prev.state = "healthy";
      }
      store.alerts.set(name, prev);
    }
  }

  function healthScore(sample) {
    const reasons = [];
    let score = 100;
    const penalties = [
      [sample.errorRate >= thresholds.errorRateCrit, 20, "critical", `Error rate ${sample.errorRate.toFixed(1)}%`],
      [sample.errorRate >= thresholds.errorRateWarn, 8, "warning", `Error rate ${sample.errorRate.toFixed(1)}%`],
      [sample.p95Ms >= thresholds.p95CritMs, 15, "critical", `p95 latency ${Math.round(sample.p95Ms)}ms`],
      [sample.p95Ms >= thresholds.p95WarnMs, 6, "warning", `p95 latency ${Math.round(sample.p95Ms)}ms`],
      [sample.lagMs >= thresholds.lagCritMs, 12, "critical", `Event loop lag ${Math.round(sample.lagMs)}ms`],
      [sample.lagMs >= thresholds.lagWarnMs, 5, "warning", `Event loop lag ${Math.round(sample.lagMs)}ms`],
      [sample.elu >= thresholds.eluCrit, 12, "critical", `Event loop utilization ${(sample.elu * 100).toFixed(0)}%`],
      [sample.elu >= thresholds.eluWarn, 5, "warning", `Event loop utilization ${(sample.elu * 100).toFixed(0)}%`],
      [sample.heapPct >= thresholds.heapCrit, 12, "critical", `Heap ${(sample.heapPct * 100).toFixed(0)}%`],
      [sample.heapPct >= thresholds.heapWarn, 5, "warning", `Heap ${(sample.heapPct * 100).toFixed(0)}%`],
      [sample.cpuPercent >= thresholds.cpuCrit, 10, "critical", `CPU ${sample.cpuPercent.toFixed(0)}%`],
      [sample.cpuPercent >= thresholds.cpuWarn, 4, "warning", `CPU ${sample.cpuPercent.toFixed(0)}%`],
      [store.mongo.status === "down", 15, "critical", "MongoDB is down"],
    ];
    const used = new Set();
    for (const [hit, penalty, level, text] of penalties) {
      if (!hit || used.has(text.split(" ")[0])) continue;
      used.add(text.split(" ")[0]);
      score -= penalty;
      reasons.push({ level, text });
    }
    if (sample.possibleLeak) {
      score -= 8;
      reasons.push({ level: "warning", text: "Heap has been rising steadily (possible leak)" });
    }
    if (!reasons.length) {
      reasons.push({ level: "ok", text: "Error rate healthy" });
      reasons.push({ level: "ok", text: "Memory healthy" });
      reasons.push({ level: "ok", text: "Event loop healthy" });
    }
    score = Math.max(0, Math.min(100, score));
    const status = score >= 90 ? "healthy" : score >= 70 ? "warning" : "critical";
    return { score, status, reasons };
  }

  let lastTotals = { requests: 0, failed: 0, status5: 0, ts: Date.now() };
  let dependencies = [];

  async function tick() {
    const now = Date.now();
    const loop = eventLoopStats();
    const mem = memoryStats();
    const cpuPercent = sampleCpu();
    const dt = Math.max((now - lastTotals.ts) / 1000, 0.001);
    const reqDelta = Math.max(store.totals.requests - lastTotals.requests, 0);
    const failDelta = Math.max(store.totals.failed - lastTotals.failed, 0);
    const status5Delta = Math.max(store.totals.status5 - lastTotals.status5, 0);
    const rps = reqDelta / dt;
    const errorRate = reqDelta ? (status5Delta / reqDelta) * 100 : 0;
    const failRate = reqDelta ? (failDelta / reqDelta) * 100 : 0;
    lastTotals = {
      requests: store.totals.requests,
      failed: store.totals.failed,
      status5: store.totals.status5,
      ts: now,
    };

    const sample = {
      ts: now,
      rps,
      rpm: rps * 60,
      inFlight: store.inFlight,
      errorRate,
      failRate,
      p50Ms: store.latency.percentile(0.5) * 1000,
      p75Ms: store.latency.percentile(0.75) * 1000,
      p95Ms: store.latency.percentile(0.95) * 1000,
      p99Ms: store.latency.percentile(0.99) * 1000,
      avgMs: store.latency.avg() * 1000,
      maxMs: store.latency.max * 1000,
      lagMs: loop.lagMs,
      lagAvgMs: loop.lagAvgMs,
      lagP95Ms: loop.lagP95Ms,
      lagP99Ms: loop.lagP99Ms,
      lagMaxMs: loop.lagMaxMs,
      elu: loop.elu,
      cpuPercent,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      heapPct: mem.heapPct,
      mongoLatencyMs: store.mongo.lastLatencyMs,
      status5Rate: errorRate,
      possibleLeak: false,
    };

    store.series.push({
      ts: now,
      rps,
      inFlight: store.inFlight,
      errorRate,
      p95: sample.p95Ms,
      lag: loop.lagMs,
      elu: loop.elu * 100,
      cpu: cpuPercent,
      heapUsed: mem.heapUsed,
      rss: mem.rss,
    });

    if (now - lastAlertCheck >= 5000) {
      evaluateAlerts(sample);
      lastAlertCheck = now;
    }

    const dueSystem = now - lastSystemSample >= thresholds.systemSampleMs || !store.lastSample;
    if (dueSystem) {
      sample.possibleLeak = possibleLeak(mem);
      sample.system = systemInfo();
      lastSystemSample = now;
    } else {
      sample.possibleLeak = store.lastSample?.possibleLeak || false;
      sample.system = store.lastSample.system;
    }

    sample.health = healthScore(sample);
    sample.memory = mem;
    sample.gc = {
      ...gc,
      avgMs: gc.count ? gc.durationMs / gc.count : 0,
    };
    sample.handles = handleStats();
    sample.http = { ...store.http, active: store.http.active };
    sample.v8 = v8.getHeapStatistics();

    if (now - lastDepCheck >= thresholds.depCheckMs) {
      lastDepCheck = now;
      await checkMongo();
      const redis = await checkRedis();
      dependencies = [
        {
          service: "MongoDB",
          status: store.mongo.status,
          latencyMs: store.mongo.lastLatencyMs,
          lastChecked: store.mongo.lastChecked,
          lastFailure: store.mongo.status === "down" ? store.mongo.lastChecked : null,
        },
        redis,
      ];
    }
    sample.dependencies = dependencies;
    store.lastSample = sample;
    return sample;
  }

  attachMongoCommands();
  checkMongo().catch(() => {});
  const timer = setInterval(() => {
    tick().catch((err) => pushLog("error", `monitor tick failed: ${err.message}`));
  }, 1000);
  if (typeof timer.unref === "function") timer.unref();

  return {
    tick,
    systemInfo,
    memoryStats,
    handleStats,
    gc,
    getDependencies: () => dependencies,
  };
}

module.exports = {
  createCollectors,
};

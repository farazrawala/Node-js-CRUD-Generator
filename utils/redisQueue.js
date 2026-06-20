const {
  getRedisClient,
  isRedisConfigured,
  normalizeCompanyIdForCache,
} = require("./redisCache");

/** Tenant queue key: `{companyId}:{module}:queue` */
const QUEUE_SUFFIX = "queue";
const TENANT_INDEX_PREFIX = "queue:tenants:";

const memoryQueues = new Map();
const memoryTenantIndex = new Map();

function isQueueEnabled() {
  const flag = String(process.env.REDIS_QUEUE_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") {
    return false;
  }
  return isRedisConfigured();
}

function isMemoryQueueFallbackEnabled() {
  const v = String(process.env.REDIS_QUEUE_MEMORY_FALLBACK ?? "true")
    .trim()
    .toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

function normalizeModule(module) {
  const mod = String(module || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_");
  return mod || "default";
}

function normalizeCompanyId(value) {
  return normalizeCompanyIdForCache(value);
}

function normalizeJobId(jobId) {
  if (jobId == null) return null;
  const id = String(jobId).trim();
  return id || null;
}

/**
 * `{companyId}:{module}:queue`
 * Example: `6a0b716e96e8f4d982b91243:process:queue`
 */
function buildQueueKey(companyId, module) {
  const tenant = normalizeCompanyId(companyId);
  const mod = normalizeModule(module);
  if (!tenant) return null;
  return `${tenant}:${mod}:${QUEUE_SUFFIX}`;
}

function buildTenantIndexKey(module) {
  return `${TENANT_INDEX_PREFIX}${normalizeModule(module)}`;
}

function computeQueueScore(priority, enqueuedAt) {
  const p = Number(priority);
  const safePriority = Number.isFinite(p) ? p : 100;
  const ts = Number(enqueuedAt);
  const safeTs = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
  return safePriority * 1e13 + safeTs;
}

function memoryGetQueue(key) {
  if (!memoryQueues.has(key)) {
    memoryQueues.set(key, []);
  }
  return memoryQueues.get(key);
}

function memorySortQueue(entries) {
  entries.sort((a, b) => a.score - b.score || String(a.member).localeCompare(String(b.member)));
}

function memoryAddTenant(module, companyId) {
  const indexKey = buildTenantIndexKey(module);
  if (!memoryTenantIndex.has(indexKey)) {
    memoryTenantIndex.set(indexKey, new Set());
  }
  memoryTenantIndex.get(indexKey).add(companyId);
}

function memoryRemoveTenantIfEmpty(module, companyId, queueKey) {
  const entries = memoryQueues.get(queueKey) || [];
  if (entries.length > 0) return;
  memoryQueues.delete(queueKey);
  const indexKey = buildTenantIndexKey(module);
  const set = memoryTenantIndex.get(indexKey);
  if (set) {
    set.delete(companyId);
    if (set.size === 0) memoryTenantIndex.delete(indexKey);
  }
}

async function redisEnqueue(queueKey, jobId, score, module, companyId) {
  const redis = await getRedisClient();
  if (!redis) return false;
  await redis.zAdd(queueKey, { score, value: jobId });
  await redis.sAdd(buildTenantIndexKey(module), companyId);
  return true;
}

async function redisRemove(queueKey, jobId, module, companyId) {
  const redis = await getRedisClient();
  if (!redis) return false;
  await redis.zRem(queueKey, jobId);
  const size = await redis.zCard(queueKey);
  if (size === 0) {
    await redis.del(queueKey);
    await redis.sRem(buildTenantIndexKey(module), companyId);
  }
  return true;
}

async function redisPeekHead(queueKey) {
  const redis = await getRedisClient();
  if (!redis) return undefined;
  const rows = await redis.zRangeWithScores(queueKey, 0, 0);
  if (!rows?.length) return null;
  const row = rows[0];
  return {
    jobId: row.value,
    score: row.score,
  };
}

async function redisListTenants(module) {
  const redis = await getRedisClient();
  if (!redis) return null;
  return redis.sMembers(buildTenantIndexKey(module));
}

async function redisQueueLength(queueKey) {
  const redis = await getRedisClient();
  if (!redis) return undefined;
  return redis.zCard(queueKey);
}

async function redisPeekMany(queueKey, count) {
  const redis = await getRedisClient();
  if (!redis) return undefined;
  const limit = Math.max(1, Math.min(Number(count) || 10, 100));
  const rows = await redis.zRangeWithScores(queueKey, 0, limit - 1);
  return (rows || []).map((row) => ({
    jobId: row.value,
    score: row.score,
  }));
}

async function redisClearQueue(queueKey, module, companyId) {
  const redis = await getRedisClient();
  if (!redis) return undefined;
  const size = await redis.zCard(queueKey);
  await redis.del(queueKey);
  await redis.sRem(buildTenantIndexKey(module), companyId);
  return size;
}

async function redisListCompanyModules(companyId) {
  const redis = await getRedisClient();
  if (!redis) return null;
  const tenant = normalizeCompanyId(companyId);
  if (!tenant) return [];
  const pattern = `${tenant}:*:${QUEUE_SUFFIX}`;
  const modules = [];
  for await (const chunk of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    const keys = Array.isArray(chunk) ? chunk : [chunk];
    for (const key of keys) {
      const keyStr = String(key);
      const parts = keyStr.split(":");
      if (parts.length >= 3 && parts[parts.length - 1] === QUEUE_SUFFIX) {
        modules.push(parts.slice(1, -1).join(":"));
      }
    }
  }
  return [...new Set(modules)].sort();
}

/**
 * Add or refresh a job in a tenant module queue.
 * @returns {{ queued: boolean, queueKey: string|null, backend: 'redis'|'memory'|'none' }}
 */
async function enqueueJob(companyId, module, jobId, options = {}) {
  const tenant = normalizeCompanyId(companyId);
  const id = normalizeJobId(jobId);
  const mod = normalizeModule(module);
  const queueKey = buildQueueKey(tenant, mod);

  if (!tenant || !id || !queueKey) {
    return { queued: false, queueKey: null, backend: "none" };
  }

  const score = computeQueueScore(options.priority, options.enqueuedAt);

  if (isQueueEnabled()) {
    try {
      const stored = await redisEnqueue(queueKey, id, score, mod, tenant);
      if (stored) {
        return { queued: true, queueKey, backend: "redis" };
      }
    } catch (err) {
      console.warn("[redis-queue] enqueue failed:", err?.message || err);
    }
  }

  if (!isMemoryQueueFallbackEnabled()) {
    return { queued: false, queueKey, backend: "none" };
  }

  const entries = memoryGetQueue(queueKey);
  const existing = entries.findIndex((e) => e.member === id);
  if (existing >= 0) {
    entries[existing].score = score;
  } else {
    entries.push({ member: id, score });
  }
  memorySortQueue(entries);
  memoryAddTenant(mod, tenant);
  return { queued: true, queueKey, backend: "memory" };
}

async function removeJob(companyId, module, jobId) {
  const tenant = normalizeCompanyId(companyId);
  const id = normalizeJobId(jobId);
  const mod = normalizeModule(module);
  const queueKey = buildQueueKey(tenant, mod);
  if (!tenant || !id || !queueKey) return false;

  if (isQueueEnabled()) {
    try {
      await redisRemove(queueKey, id, mod, tenant);
    } catch (err) {
      console.warn("[redis-queue] remove failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    const entries = memoryGetQueue(queueKey);
    const next = entries.filter((e) => e.member !== id);
    memoryQueues.set(queueKey, next);
    memoryRemoveTenantIfEmpty(mod, tenant, queueKey);
  }

  return true;
}

async function peekNextJob(module, { companyId } = {}) {
  const mod = normalizeModule(module);
  const scopedTenant = normalizeCompanyId(companyId);

  if (scopedTenant) {
    const queueKey = buildQueueKey(scopedTenant, mod);
    if (!queueKey) return null;

    if (isQueueEnabled()) {
      try {
        const head = await redisPeekHead(queueKey);
        if (head) {
          return { ...head, companyId: scopedTenant, queueKey, module: mod };
        }
        if (head === null) {
          return null;
        }
      } catch (err) {
        console.warn("[redis-queue] peek failed:", err?.message || err);
      }
    }

    if (isMemoryQueueFallbackEnabled()) {
      const entries = memoryGetQueue(queueKey);
      if (entries.length) {
        return {
          jobId: entries[0].member,
          score: entries[0].score,
          companyId: scopedTenant,
          queueKey,
          module: mod,
        };
      }
    }
    return null;
  }

  const tenants = await listQueueTenants(mod);
  let best = null;
  for (const tenant of tenants) {
    const head = await peekNextJob(mod, { companyId: tenant });
    if (!head) continue;
    if (!best || head.score < best.score) {
      best = head;
    }
  }
  return best;
}

async function listQueueTenants(module) {
  const mod = normalizeModule(module);
  const tenants = new Set();

  if (isQueueEnabled()) {
    try {
      const ids = await redisListTenants(mod);
      if (ids) {
        for (const id of ids) {
          if (id) tenants.add(String(id).toLowerCase());
        }
      }
    } catch (err) {
      console.warn("[redis-queue] list tenants failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    const set = memoryTenantIndex.get(buildTenantIndexKey(mod));
    if (set) {
      for (const id of set) tenants.add(id);
    }
  }

  return [...tenants].sort();
}

async function getQueueLength(companyId, module) {
  const tenant = normalizeCompanyId(companyId);
  const mod = normalizeModule(module);
  const queueKey = buildQueueKey(tenant, mod);
  if (!queueKey) return 0;

  if (isQueueEnabled()) {
    try {
      const length = await redisQueueLength(queueKey);
      if (length !== undefined) return length;
    } catch (err) {
      console.warn("[redis-queue] length failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    return (memoryQueues.get(queueKey) || []).length;
  }
  return 0;
}

async function peekJobs(companyId, module, count = 10) {
  const tenant = normalizeCompanyId(companyId);
  const mod = normalizeModule(module);
  const queueKey = buildQueueKey(tenant, mod);
  if (!queueKey) return [];

  if (isQueueEnabled()) {
    try {
      const rows = await redisPeekMany(queueKey, count);
      if (rows !== undefined) return rows;
    } catch (err) {
      console.warn("[redis-queue] peek many failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    const limit = Math.max(1, Math.min(Number(count) || 10, 100));
    return (memoryQueues.get(queueKey) || [])
      .slice(0, limit)
      .map((row) => ({ jobId: row.member, score: row.score }));
  }
  return [];
}

async function clearQueue(companyId, module) {
  const tenant = normalizeCompanyId(companyId);
  const mod = normalizeModule(module);
  const queueKey = buildQueueKey(tenant, mod);
  if (!queueKey) return 0;

  let removed = 0;

  if (isQueueEnabled()) {
    try {
      const cleared = await redisClearQueue(queueKey, mod, tenant);
      if (cleared !== undefined) removed = cleared;
    } catch (err) {
      console.warn("[redis-queue] clear failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    removed = Math.max(removed, (memoryQueues.get(queueKey) || []).length);
    memoryQueues.delete(queueKey);
    memoryRemoveTenantIfEmpty(mod, tenant, queueKey);
  }

  return removed;
}

async function listCompanyQueues(companyId) {
  const tenant = normalizeCompanyId(companyId);
  if (!tenant) {
    return {
      company_id: null,
      queues: [],
      queue_enabled: isQueueEnabled(),
      memory_fallback: isMemoryQueueFallbackEnabled(),
    };
  }

  const modules = new Set();

  if (isQueueEnabled()) {
    try {
      const redisModules = await redisListCompanyModules(tenant);
      if (redisModules) {
        for (const mod of redisModules) {
          modules.add(mod);
        }
      }
    } catch (err) {
      console.warn("[redis-queue] list company modules failed:", err?.message || err);
    }
  }

  if (isMemoryQueueFallbackEnabled()) {
    const prefix = `${tenant}:`;
    const suffix = `:${QUEUE_SUFFIX}`;
    for (const key of memoryQueues.keys()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        const mod = key.slice(prefix.length, key.length - suffix.length);
        if (mod) modules.add(mod);
      }
    }
  }

  const queues = [];
  for (const mod of [...modules].sort()) {
    const queueKey = buildQueueKey(tenant, mod);
    const length = await getQueueLength(tenant, mod);
    const pending = await peekJobs(tenant, mod, 5);
    queues.push({
      module: mod,
      queue_key: `${tenant}:${mod}`,
      redis_key: queueKey,
      length,
      pending,
    });
  }

  return {
    company_id: tenant,
    queues,
    count: queues.length,
    queue_enabled: isQueueEnabled(),
    memory_fallback: isMemoryQueueFallbackEnabled(),
  };
}

if (isQueueEnabled()) {
  console.log("[redis-queue] Tenant queues enabled (key: {companyId}:{module}:queue)");
} else if (isMemoryQueueFallbackEnabled()) {
  console.warn(
    "[redis-queue] REDIS disabled — queues use in-process memory only (cleared on restart).",
  );
} else {
  console.warn("[redis-queue] Queue storage is OFF.");
}

module.exports = {
  QUEUE_SUFFIX,
  isQueueEnabled,
  isMemoryQueueFallbackEnabled,
  normalizeModule,
  normalizeCompanyId,
  buildQueueKey,
  computeQueueScore,
  enqueueJob,
  removeJob,
  peekNextJob,
  peekJobs,
  getQueueLength,
  clearQueue,
  listCompanyQueues,
  listQueueTenants,
};

const crypto = require("crypto");
const { coalesceObjectId } = require("./modelHelper");

/** Suffix for active warehouse list cache keys: `{companyId}:warehouse:get-all-active` */
const WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX = "warehouse:get-all-active";

const WAREHOUSE_ACTIVE_CACHE_TTL_SEC = Number(
  process.env.REDIS_TTL_WAREHOUSE_ACTIVE || 300,
);

let client = null;
let connectPromise = null;
let redisUnavailable = false;
let redisUnavailableAt = 0;
let connectFailureLogged = false;

/** In-process fallback when Redis is unreachable (per Node process). */
const memoryCache = new Map();

const REDIS_RETRY_AFTER_MS = Number(process.env.REDIS_RETRY_AFTER_MS || 5_000);

function isMemoryFallbackEnabled() {
  const v = String(process.env.REDIS_MEMORY_FALLBACK ?? "true")
    .trim()
    .toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

function memoryGet(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key, value, ttlSeconds) {
  const ttl = Number(ttlSeconds);
  const sec =
    Number.isFinite(ttl) && ttl > 0 ? ttl : WAREHOUSE_ACTIVE_CACHE_TTL_SEC;
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + Math.floor(sec) * 1000,
  });
}

function memoryDel(key) {
  memoryCache.delete(key);
}

function isRedisConfigured() {
  const enabled = String(process.env.REDIS_ENABLED ?? "true")
    .trim()
    .toLowerCase();
  if (enabled === "false" || enabled === "0" || enabled === "no") {
    return false;
  }
  return Boolean(process.env.REDIS_URL && String(process.env.REDIS_URL).trim());
}

function shouldRetryRedisConnect() {
  if (!redisUnavailable) return true;
  if (!redisUnavailableAt) return true;
  return Date.now() - redisUnavailableAt >= REDIS_RETRY_AFTER_MS;
}

function markRedisUnavailable(err) {
  redisUnavailable = true;
  redisUnavailableAt = Date.now();
  if (!connectFailureLogged) {
    connectFailureLogged = true;
    console.warn(
      "[redis] unavailable — API will continue without cache:",
      err?.message || err,
    );
  }
  if (client) {
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
  }
  client = null;
  connectPromise = null;
}

/**
 * Reusable Redis client (singleton). Returns null if Redis is disabled or unreachable.
 * Never throws — safe to call from request handlers.
 */
async function getRedisClient() {
  if (!isRedisConfigured()) return null;
  if (redisUnavailable && !shouldRetryRedisConnect()) return null;
  if (redisUnavailable && shouldRetryRedisConnect()) {
    redisUnavailable = false;
    connectFailureLogged = false;
    client = null;
    connectPromise = null;
  }
  if (client?.isOpen) return client;
  if (connectPromise) return connectPromise;

  const { createClient } = require("redis");
  client = createClient({
    url: String(process.env.REDIS_URL).trim(),
    socket: {
      connectTimeout: 2000,
      reconnectStrategy(retries) {
        if (retries > 0) return new Error("Redis reconnect disabled");
        return 500;
      },
    },
  });

  connectPromise = client
    .connect()
    .then(() => {
      console.log("✅ Redis connected:", process.env.REDIS_URL);
      return client;
    })
    .catch((err) => {
      markRedisUnavailable(err);
      return null;
    });

  return connectPromise;
}

/**
 * Read JSON from cache (Redis first, then in-memory fallback).
 * @returns {{ data: object|null, backend: 'redis'|'memory'|null }}
 */
async function getCache(key) {
  try {
    const redis = await getRedisClient();
    if (redis) {
      const raw = await redis.get(key);
      if (raw) {
        return { data: JSON.parse(raw), backend: "redis" };
      }
    }
  } catch (err) {
    markRedisUnavailable(err);
  }
  if (isMemoryFallbackEnabled()) {
    const hit = memoryGet(key);
    if (hit) return { data: hit, backend: "memory" };
  }
  return { data: null, backend: null };
}

/**
 * Write JSON to cache with TTL (seconds).
 * @returns {{ stored: boolean, backend: 'redis'|'memory'|null }}
 */
async function setCache(key, value, ttlSeconds = WAREHOUSE_ACTIVE_CACHE_TTL_SEC) {
  let backend = null;
  try {
    const redis = await getRedisClient();
    if (redis) {
      const ttl = Number(ttlSeconds);
      const ex =
        Number.isFinite(ttl) && ttl > 0 ?
          Math.floor(ttl)
        : WAREHOUSE_ACTIVE_CACHE_TTL_SEC;
      await redis.set(key, JSON.stringify(value), { EX: ex });
      backend = "redis";
    }
  } catch (err) {
    markRedisUnavailable(err);
  }
  if (isMemoryFallbackEnabled()) {
    memorySet(key, value, ttlSeconds);
    return { stored: true, backend: backend || "memory" };
  }
  return { stored: backend === "redis", backend };
}

/** Delete a cache key (Redis + memory). */
async function deleteCache(key) {
  memoryDel(key);
  try {
    const redis = await getRedisClient();
    if (!redis) return false;
    await redis.del(key);
    return true;
  } catch (err) {
    markRedisUnavailable(err);
    return false;
  }
}

async function isRedisConnected() {
  const redis = await getRedisClient();
  return Boolean(redis?.isOpen);
}

/** Query params that change the get-all-active response shape (each combo gets its own cache entry). */
const WAREHOUSE_ACTIVE_CACHE_QUERY_KEYS = [
  "limit",
  "skip",
  "search",
  "searchFields",
  "sortBy",
  "sortOrder",
  "populate",
];

function normalizeWarehouseActiveListQuery(query = {}) {
  const normalized = {};
  for (const key of WAREHOUSE_ACTIVE_CACHE_QUERY_KEYS) {
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") continue;
    normalized[key] = String(raw).trim();
  }
  return normalized;
}

/**
 * `{companyId}:warehouse:get-all-active` or `...:q:{hash}` when limit/skip/search/populate differ.
 */
function buildWarehouseActiveListCacheKey(companyId, req) {
  const base =
    companyId ?
      `${String(companyId)}:${WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX}`
    : WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX;
  const queryPart = normalizeWarehouseActiveListQuery(req?.query);
  if (Object.keys(queryPart).length === 0) {
    return base;
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(queryPart))
    .digest("hex")
    .slice(0, 16);
  return `${base}:q:${fingerprint}`;
}

function resolveCompanyIdFromReq(req) {
  return coalesceObjectId(req.user?.company_id);
}

/** Prefix for all warehouse active-list keys for a company (used on invalidation). */
function warehouseActiveListCachePrefix(companyId) {
  if (!companyId) return WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX;
  return `${String(companyId)}:${WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX}`;
}

async function deleteCacheByPattern(matchPattern) {
  const prefix = matchPattern.replace(/\*$/, "");
  for (const key of [...memoryCache.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`)) {
      memoryDel(key);
    }
  }
  try {
    const redis = await getRedisClient();
    if (!redis) return 0;
    let cursor = 0;
    let deleted = 0;
    do {
      const reply = await redis.scan(cursor, {
        MATCH: matchPattern,
        COUNT: 100,
      });
      cursor = reply.cursor;
      if (reply.keys.length > 0) {
        deleted += await redis.del(reply.keys);
      }
    } while (cursor !== 0);
    return deleted;
  } catch (err) {
    markRedisUnavailable(err);
    return 0;
  }
}

async function invalidateWarehouseActiveList(companyId) {
  if (!companyId) return;
  const pattern = `${warehouseActiveListCachePrefix(companyId)}*`;
  const deleted = await deleteCacheByPattern(pattern);
  if (deleted > 0) {
    console.log("[redis] invalidated warehouse active-list cache:", pattern, deleted);
  }
}

async function invalidateWarehouseActiveListForReq(req) {
  const companyId = resolveCompanyIdFromReq(req);
  if (companyId) {
    await invalidateWarehouseActiveList(companyId);
  }
}

module.exports = {
  WAREHOUSE_ACTIVE_LIST_KEY_SUFFIX,
  WAREHOUSE_ACTIVE_CACHE_TTL_SEC,
  getRedisClient,
  getCache,
  setCache,
  deleteCache,
  buildWarehouseActiveListCacheKey,
  normalizeWarehouseActiveListQuery,
  warehouseActiveListCachePrefix,
  resolveCompanyIdFromReq,
  invalidateWarehouseActiveList,
  invalidateWarehouseActiveListForReq,
  isRedisConfigured,
  isRedisConnected,
  isMemoryFallbackEnabled,
};

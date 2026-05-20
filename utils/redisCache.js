const crypto = require("crypto");
const { coalesceObjectId } = require("./modelHelper");

const DEFAULT_LIST_CACHE_TTL_SEC = Number(
  process.env.REDIS_TTL_LIST_CACHE ||
    process.env.REDIS_TTL_WAREHOUSE_ACTIVE ||
    300,
);

/** Ignored when building cache keys from full query (e.g. cache-busters). */
const LIST_CACHE_QUERY_BLOCKLIST = new Set([
  "_",
  "t",
  "cb",
  "nocache",
  "timestamp",
]);

let client = null;
let connectPromise = null;
let redisUnavailable = false;
let redisUnavailableAt = 0;
let connectFailureLogged = false;

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
    Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_LIST_CACHE_TTL_SEC;
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

async function setCache(key, value, ttlSeconds = DEFAULT_LIST_CACHE_TTL_SEC) {
  let backend = null;
  try {
    const redis = await getRedisClient();
    if (redis) {
      const ttl = Number(ttlSeconds);
      const ex =
        Number.isFinite(ttl) && ttl > 0 ?
          Math.floor(ttl)
        : DEFAULT_LIST_CACHE_TTL_SEC;
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

/**
 * Stable query object for cache key fingerprint (pagination, search, filters, populate).
 * @param {object} [query] req.query
 * @param {{ keys?: string[] }} [options] optional allowlist; default = all keys except blocklist
 */
function normalizeListQuery(query = {}, options = {}) {
  const normalized = {};
  const allowlist = options.keys;
  const keys =
    allowlist ?
      [...allowlist].sort()
    : Object.keys(query).sort();

  for (const key of keys) {
    if (LIST_CACHE_QUERY_BLOCKLIST.has(key)) continue;
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") continue;
    normalized[key] =
      Array.isArray(raw) ?
        raw.map((v) => String(v).trim()).join(",")
      : String(raw).trim();
  }
  return normalized;
}

/**
 * `{companyId}:{module}:{action}` or `...:q:{hash}` when query params differ.
 */
function buildListCacheKey({ companyId, module, action = "get-all-active", query }) {
  const mod = String(module || "resource").trim();
  const act = String(action || "get-all-active").trim();
  const base =
    companyId ? `${String(companyId)}:${mod}:${act}` : `${mod}:${act}`;
  const queryPart = normalizeListQuery(query || {});
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

function buildListCachePrefix(companyId, module, action = "get-all-active") {
  const mod = String(module || "resource").trim();
  const act = String(action || "get-all-active").trim();
  return companyId ? `${String(companyId)}:${mod}:${act}` : `${mod}:${act}`;
}

function resolveCompanyIdFromReq(req) {
  return coalesceObjectId(req.user?.company_id);
}

/**
 * Cache key + normalized query for a list endpoint.
 * @returns {{ cacheKey: string|null, cacheQuery: object, companyId: string|null }}
 */
function resolveListCacheFromReq(req, { module, action = "get-all-active" } = {}) {
  const companyId = resolveCompanyIdFromReq(req);
  const cacheQuery = normalizeListQuery(req?.query);
  const cacheKey =
    companyId ?
      buildListCacheKey({
        companyId,
        module,
        action,
        query: req?.query,
      })
    : null;
  return { cacheKey, cacheQuery, companyId };
}

async function deleteCacheByPattern(matchPattern) {
  const prefix = matchPattern.replace(/\*$/, "");
  let deleted = 0;
  for (const key of [...memoryCache.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}:`)) {
      memoryDel(key);
      deleted += 1;
    }
  }
  try {
    const redis = await getRedisClient();
    if (!redis) return deleted;
    let cursor = 0;
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
    return deleted;
  }
}

async function invalidateListCache(companyId, module, action = "get-all-active") {
  if (!companyId) return 0;
  const pattern = `${buildListCachePrefix(companyId, module, action)}*`;
  const deleted = await deleteCacheByPattern(pattern);
  if (deleted > 0) {
    console.log("[redis] invalidated list cache:", pattern, deleted);
  }
  return deleted;
}

async function invalidateListCacheForReq(
  req,
  module,
  action = "get-all-active",
) {
  const companyId = resolveCompanyIdFromReq(req);
  if (companyId) {
    return invalidateListCache(companyId, module, action);
  }
  return 0;
}

/**
 * Generic read-through cache for GET list / get-all-active handlers.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ module: string, action?: string, ttl?: number, fetch: () => Promise<object> }} options
 */
async function runCachedListHandler(req, res, options) {
  const {
    module,
    action = "get-all-active",
    ttl = DEFAULT_LIST_CACHE_TTL_SEC,
    fetch,
  } = options;

  const { cacheKey, cacheQuery } = resolveListCacheFromReq(req, {
    module,
    action,
  });

  if (cacheKey) {
    const { data: cached, backend } = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json({
        ...cached,
        fromCache: true,
        cacheKey,
        cacheBackend: backend,
        ...(Object.keys(cacheQuery).length > 0 ? { cacheQuery } : {}),
      });
    }
  }

  const response = await fetch();

  let cacheMeta = {};
  if (cacheKey && response?.success) {
    const { stored, backend } = await setCache(cacheKey, response, ttl);
    const redisUp = await isRedisConnected();
    cacheMeta = {
      cacheKey,
      fromCache: false,
      cached: stored,
      cacheBackend: backend,
      redisConnected: redisUp,
      ...(Object.keys(cacheQuery).length > 0 ? { cacheQuery } : {}),
      ...(!redisUp && {
        cacheNote:
          "Redis is not running on REDIS_URL; using in-memory cache for this process.",
      }),
    };
  }

  return res.status(response?.status || 200).json({
    ...response,
    ...cacheMeta,
  });
}

module.exports = {
  DEFAULT_LIST_CACHE_TTL_SEC,
  WAREHOUSE_ACTIVE_CACHE_TTL_SEC: DEFAULT_LIST_CACHE_TTL_SEC,
  getRedisClient,
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  normalizeListQuery,
  buildListCacheKey,
  buildListCachePrefix,
  resolveListCacheFromReq,
  resolveCompanyIdFromReq,
  invalidateListCache,
  invalidateListCacheForReq,
  runCachedListHandler,
  isRedisConfigured,
  isRedisConnected,
  isMemoryFallbackEnabled,
};

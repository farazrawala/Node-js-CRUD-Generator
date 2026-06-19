const crypto = require("crypto");
const { coalesceObjectId } = require("./modelHelper");
const {
  logListAccess,
  isListAccessAuditExcluded,
} = require("./applicationLogs");

/** 3 days — default list-cache TTL (memory + Redis EX). Override via env. */
const THREE_DAYS_SEC = 3 * 24 * 60 * 60;

const DEFAULT_LIST_CACHE_TTL_SEC = Number(
  process.env.REDIS_TTL_LIST_CACHE ||
    process.env.REDIS_TTL_WAREHOUSE_ACTIVE ||
    THREE_DAYS_SEC,
);

/** Single TTL (seconds) for Redis EX and in-memory expiresAt. */
function resolveListCacheTtlSeconds(ttlSeconds) {
  const ttl = Number(ttlSeconds);
  return Number.isFinite(ttl) && ttl > 0 ?
      Math.floor(ttl)
    : DEFAULT_LIST_CACHE_TTL_SEC;
}

function memoryTtlSecondsRemaining(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  const remaining = Math.floor((entry.expiresAt - Date.now()) / 1000);
  if (remaining <= 0) {
    memoryCache.delete(key);
    return null;
  }
  return remaining;
}

/** Ignored when building cache keys from full query (e.g. cache-busters). */
const LIST_CACHE_QUERY_BLOCKLIST = new Set([
  "_",
  "t",
  "cb",
  "nocache",
  "timestamp",
]);

/** Never read/write list cache for these modules (`get-all-active` / `get-all`). */
const LIST_CACHE_BYPASS_MODULES = new Set(["user", "logs"]);

/** List endpoints that share the same invalidation on create/update/delete. */
const LIST_CACHE_ACTIONS = ["get-all-active", "get-all"];

function isListCacheBypassed(module) {
  return LIST_CACHE_BYPASS_MODULES.has(String(module || "").trim());
}

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

/** True when list responses can be stored (Redis and/or in-process memory). */
function isListCacheStorageEnabled() {
  return isRedisConfigured() || isMemoryFallbackEnabled();
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
  const sec = resolveListCacheTtlSeconds(ttlSeconds);
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + sec * 1000,
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
  let ttlSecondsRemaining = null;

  try {
    const redis = await getRedisClient();
    if (redis) {
      const raw = await redis.get(key);
      if (raw) {
        const data = JSON.parse(raw);
        try {
          const ttl = await redis.ttl(key);
          if (ttl > 0) {
            ttlSecondsRemaining = ttl;
            if (isMemoryFallbackEnabled()) {
              memorySet(key, data, ttl);
            }
          }
        } catch {
          /* ignore */
        }
        return { data, backend: "redis", ttlSecondsRemaining };
      }
    }
  } catch (err) {
    markRedisUnavailable(err);
  }

  if (isMemoryFallbackEnabled()) {
    const hit = memoryGet(key);
    if (hit) {
      ttlSecondsRemaining = memoryTtlSecondsRemaining(key);
      try {
        const redis = await getRedisClient();
        if (redis && ttlSecondsRemaining > 0) {
          await redis.set(key, JSON.stringify(hit), {
            EX: ttlSecondsRemaining,
          });
        }
      } catch (err) {
        markRedisUnavailable(err);
      }
      return { data: hit, backend: "memory", ttlSecondsRemaining };
    }
  }

  return { data: null, backend: null, ttlSecondsRemaining: null };
}

async function setCache(key, value, ttlSeconds = DEFAULT_LIST_CACHE_TTL_SEC) {
  const ex = resolveListCacheTtlSeconds(ttlSeconds);
  let backend = null;
  try {
    const redis = await getRedisClient();
    if (redis) {
      await redis.set(key, JSON.stringify(value), { EX: ex });
      backend = "redis";
    }
  } catch (err) {
    markRedisUnavailable(err);
  }
  if (isMemoryFallbackEnabled()) {
    memorySet(key, value, ex);
    return { stored: true, backend: backend || "memory", ttlSeconds: ex };
  }
  return { stored: backend === "redis", backend, ttlSeconds: ex };
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
  const keys = allowlist ? [...allowlist].sort() : Object.keys(query).sort();

  for (const key of keys) {
    if (LIST_CACHE_QUERY_BLOCKLIST.has(key)) continue;
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") continue;
    normalized[key] =
      Array.isArray(raw) ?
        raw.map((v) => String(v).trim()).join(",")
      : String(raw).trim();
  }
  // Common typo: `lim` → `limit` so cache keys match get-all-active requests.
  if (normalized.lim != null && normalized.limit == null) {
    normalized.limit = normalized.lim;
    delete normalized.lim;
  }
  return normalized;
}

/**
 * `{companyId}:{module}:{action}` or `...:q:{hash}` when query params differ.
 */
function buildListCacheKey({
  companyId,
  module,
  action = "get-all-active",
  query,
}) {
  const mod = String(module || "resource").trim();
  const act = String(action || "get-all-active").trim();
  const tenant = normalizeCompanyIdForCache(companyId);
  const base = tenant ? `${tenant}:${mod}:${act}` : `${mod}:${act}`;
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
  const tenant = normalizeCompanyIdForCache(companyId);
  return tenant ? `${tenant}:${mod}:${act}` : `${mod}:${act}`;
}

/** Canonical 24-char hex tenant id for cache keys (handles populated `company_id`). */
function normalizeCompanyIdForCache(value) {
  const raw = coalesceObjectId(value);
  if (raw == null || raw === "") return null;
  const hex = String(raw).trim();
  if (!/^[a-fA-F0-9]{24}$/.test(hex)) return null;
  return hex.toLowerCase();
}

function resolveCompanyIdFromReq(req) {
  return normalizeCompanyIdForCache(req.user?.company_id);
}

/** Redis SCAN may yield Buffer keys; always coerce before string methods. */
function normalizeCacheKey(key) {
  if (key == null) return "";
  if (typeof key === "string") return key;
  if (Buffer.isBuffer(key)) return key.toString("utf8");
  return String(key);
}

function keyBelongsToCompany(key, companyIdHex) {
  const keyStr = normalizeCacheKey(key);
  if (!companyIdHex || !keyStr) return false;
  if (keyStr === companyIdHex || keyStr.startsWith(`${companyIdHex}:`)) {
    return true;
  }
  const first = keyStr.split(":")[0];
  return (
    first.length === 24 &&
    /^[a-fA-F0-9]{24}$/.test(first) &&
    first.toLowerCase() === companyIdHex
  );
}

/**
 * Cache key + normalized query for a list endpoint.
 * @returns {{ cacheKey: string|null, cacheQuery: object, companyId: string|null }}
 */
function resolveListCacheFromReq(
  req,
  { module, action = "get-all-active" } = {},
) {
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

function patternToPrefix(matchPattern) {
  return String(matchPattern || "")
    .replace(/\*+$/, "")
    .replace(/:+$/, "");
}

async function deleteCacheByPattern(matchPattern) {
  const prefix = patternToPrefix(matchPattern);
  const companyPrefix =
    /^[a-fA-F0-9]{24}$/.test(prefix) ? prefix.toLowerCase() : null;
  let deleted = 0;

  for (const key of [...memoryCache.keys()]) {
    const keyStr = normalizeCacheKey(key);
    const matches =
      companyPrefix ?
        keyBelongsToCompany(keyStr, companyPrefix)
      : keyStr === prefix || keyStr.startsWith(`${prefix}:`);
    if (matches) {
      memoryDel(key);
      deleted += 1;
    }
  }

  try {
    const redis = await getRedisClient();
    if (!redis) return deleted;

    const iterator = redis.scanIterator({
      MATCH: matchPattern,
      COUNT: 100,
    });
    for await (const rawKey of iterator) {
      const keyStr = normalizeCacheKey(rawKey);
      memoryDel(keyStr);
      deleted += await redis.del(rawKey);
    }
    return deleted;
  } catch (err) {
    markRedisUnavailable(err);
    return deleted;
  }
}

async function invalidateListCache(
  companyId,
  module,
  action = "get-all-active",
) {
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

/** Invalidate every list-cache action for a module (get-all-active + get-all). */
async function invalidateModuleListCachesForReq(req, module) {
  let deleted = 0;
  for (const action of LIST_CACHE_ACTIONS) {
    deleted += await invalidateListCacheForReq(req, module, action);
  }
  return deleted;
}

/**
 * Drop every list-cache key for a tenant: `{companyId}:*` (all modules/actions/query variants).
 */
async function invalidateAllListCacheForCompany(companyId) {
  const tenant = normalizeCompanyIdForCache(companyId);
  if (!tenant) return 0;
  const pattern = `${tenant}:*`;
  const deleted = await deleteCacheByPattern(pattern);
  console.log(
    "[redis] invalidated all list cache for company:",
    pattern,
    deleted,
  );
  return deleted;
}

/** @returns {Promise<number>} keys removed */
async function invalidateAllListCacheForReq(req) {
  const companyId = resolveCompanyIdFromReq(req);
  if (!companyId) return 0;
  return invalidateAllListCacheForCompany(companyId);
}

/** Parse `{companyId}:{module}:{action}[:q:{hash}]` list-cache keys. */
function parseListCacheKey(key, companyId) {
  const keyStr = normalizeCacheKey(key);
  const prefix = `${String(companyId)}:`;
  if (!keyStr.startsWith(prefix)) {
    return { module: null, action: null, query_fingerprint: null };
  }
  const rest = keyStr.slice(prefix.length);
  const parts = rest.split(":");
  const module = parts[0] || null;
  const action = parts[1] || null;
  const query_fingerprint = parts[2] === "q" ? parts[3] || null : null;
  return { module, action, query_fingerprint };
}

function summarizeCacheValue(value) {
  if (value == null) return null;
  if (typeof value !== "object") return { type: typeof value };
  return {
    success: value.success,
    status: value.status,
    count: value.count,
    data_count: Array.isArray(value.data) ? value.data.length : undefined,
    fromCache: value.fromCache,
  };
}

/**
 * List all list-cache keys for a tenant (`{companyId}:*`) from memory and Redis.
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {{ includeValues?: boolean }} [options]
 */
async function listAllListCacheForCompany(companyId, options = {}) {
  const companyIdStr = normalizeCompanyIdForCache(companyId);
  if (!companyIdStr) {
    return {
      company_id: null,
      pattern: null,
      count: 0,
      memory_count: 0,
      redis_count: 0,
      redis_enabled: isRedisConfigured(),
      redis_connected: false,
      list_cache_storage_enabled: isListCacheStorageEnabled(),
      entries: [],
    };
  }

  const pattern = `${companyIdStr}:*`;
  const includeValues = options.includeValues === true;
  const now = Date.now();
  const entries = [];

  const memoryByKey = new Map();

  for (const [key, entry] of memoryCache.entries()) {
    const keyStr = normalizeCacheKey(key);
    if (!keyBelongsToCompany(keyStr, companyIdStr)) continue;
    const expired = now > entry.expiresAt;
    const memoryTtl =
      expired ? 0 : Math.max(0, Math.floor((entry.expiresAt - now) / 1000));
    memoryByKey.set(keyStr, {
      entry,
      expired,
      memoryTtl,
      expires_at: new Date(entry.expiresAt).toISOString(),
    });
  }

  let redisConnected = false;
  const redisTtlByKey = new Map();
  try {
    const redis = await getRedisClient();
    redisConnected = Boolean(redis?.isOpen);
    if (redis) {
      const iterator = redis.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      });
      for await (const rawKey of iterator) {
        const keyStr = normalizeCacheKey(rawKey);
        let ttl = -2;
        try {
          ttl = await redis.ttl(rawKey);
        } catch {
          /* ignore */
        }
        redisTtlByKey.set(keyStr, ttl);
      }
    }
  } catch (err) {
    markRedisUnavailable(err);
  }

  const allKeys = new Set([...memoryByKey.keys(), ...redisTtlByKey.keys()]);
  for (const rawKey of allKeys) {
    const key = normalizeCacheKey(rawKey);
    const mem = memoryByKey.get(key);
    const redisTtl = redisTtlByKey.has(key) ? redisTtlByKey.get(key) : null;
    const memoryTtl = mem?.memoryTtl ?? null;
    const redisLive = redisTtl != null && redisTtl >= 0;
    const memoryLive = memoryTtl != null && memoryTtl > 0 && !mem?.expired;

    let effectiveTtl = null;
    if (redisLive && memoryLive) {
      effectiveTtl = Math.min(redisTtl, memoryTtl);
    } else if (redisLive) {
      effectiveTtl = redisTtl;
    } else if (memoryLive) {
      effectiveTtl = memoryTtl;
    }

    const backends = [];
    if (memoryLive) backends.push("memory");
    if (redisLive) backends.push("redis");

    const row = {
      key,
      backend: backends.length === 1 ? backends[0] : backends.join("+"),
      backends,
      expired: effectiveTtl == null || effectiveTtl <= 0,
      expires_at: mem?.expires_at ?? null,
      ttl_seconds_remaining: effectiveTtl,
      memory_ttl_seconds_remaining: memoryLive ? memoryTtl : null,
      redis_ttl_seconds_remaining: redisLive ? redisTtl : null,
      ttl_mismatch:
        memoryLive &&
        redisLive &&
        Math.abs(memoryTtl - redisTtl) > 2,
      ...parseListCacheKey(key, companyIdStr),
    };
    if (includeValues && mem?.entry) {
      row.value_summary = summarizeCacheValue(mem.entry.value);
    } else if (includeValues && redisLive) {
      try {
        const redis = await getRedisClient();
        const raw = redis ? await redis.get(key) : null;
        row.value_summary = summarizeCacheValue(
          raw ? JSON.parse(raw) : null,
        );
      } catch {
        row.value_summary = null;
      }
    }
    entries.push(row);
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  const memory_count = entries.filter((e) =>
    e.backends?.includes("memory"),
  ).length;
  const redis_count = entries.filter((e) => e.backends?.includes("redis")).length;

  return {
    company_id: companyIdStr,
    pattern,
    count: entries.length,
    memory_count,
    redis_count,
    redis_enabled: isRedisConfigured(),
    redis_connected: redisConnected,
    list_cache_storage_enabled: isListCacheStorageEnabled(),
    entries,
  };
}

async function listAllListCacheForReq(req, options = {}) {
  const companyId = resolveCompanyIdFromReq(req);
  if (!companyId) {
    return {
      company_id: null,
      pattern: null,
      count: 0,
      memory_count: 0,
      redis_count: 0,
      redis_enabled: isRedisConfigured(),
      redis_connected: false,
      list_cache_storage_enabled: isListCacheStorageEnabled(),
      entries: [],
    };
  }
  const includeValues =
    options.includeValues === true ||
    req.query?.include_values === "true" ||
    req.query?.include_values === "1";
  return listAllListCacheForCompany(companyId, { includeValues });
}

/**
 * Generic read-through cache for GET list / get-all / get-all-active handlers.
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

  // `user`: stale empty lists after create; `logs`: always hit DB, no list-access audit row.
  if (isListCacheBypassed(module)) {
    const response = await fetch();
    if (!isListAccessAuditExcluded(module)) {
      void logListAccess(req, { source: "api", module, action });
    }
    return res.status(response?.status || 200).json(response);
  }

  const { cacheKey, cacheQuery } = resolveListCacheFromReq(req, {
    module,
    action,
  });

  if (cacheKey) {
    const { data: cached, backend, ttlSecondsRemaining } =
      await getCache(cacheKey);
    if (cached) {
      void logListAccess(req, {
        source: "cache",
        module,
        action,
        cacheKey,
        cacheBackend: backend,
      });
      return res.status(200).json({
        ...cached,
        fromCache: true,
        cacheKey,
        cacheBackend: backend,
        ...(ttlSecondsRemaining != null ?
          { cacheTtlSecondsRemaining: ttlSecondsRemaining }
        : {}),
        ...(Object.keys(cacheQuery).length > 0 ? { cacheQuery } : {}),
      });
    }
  }

  const response = await fetch();
  void logListAccess(req, { source: "api", module, action, cacheKey });

  let cacheMeta = {};
  if (cacheKey && response?.success) {
    const { stored, backend, ttlSeconds } = await setCache(
      cacheKey,
      response,
      ttl,
    );
    const redisUp = await isRedisConnected();
    const storageEnabled = isListCacheStorageEnabled();
    let cacheNote;
    if (!stored && !storageEnabled) {
      cacheNote =
        "List cache storage is disabled (REDIS_ENABLED=false and REDIS_MEMORY_FALLBACK=false).";
    } else if (!stored && !redisUp && isMemoryFallbackEnabled()) {
      cacheNote =
        "Redis is not running on REDIS_URL; using in-memory cache for this process.";
    } else if (!stored && !redisUp) {
      cacheNote =
        "Redis is not connected and REDIS_MEMORY_FALLBACK is disabled.";
    }
    cacheMeta = {
      cacheKey,
      fromCache: false,
      cached: stored,
      listCacheStorageEnabled: storageEnabled,
      cacheBackend: backend,
      cacheTtlSeconds: ttlSeconds,
      redisConnected: redisUp,
      ...(Object.keys(cacheQuery).length > 0 ? { cacheQuery } : {}),
      ...(cacheNote ? { cacheNote } : {}),
    };
  } else if (!cacheKey && response?.success) {
    cacheMeta = {
      fromCache: false,
      cached: false,
      listCacheStorageEnabled: isListCacheStorageEnabled(),
      cacheNote:
        "No cache key (authenticate with a user that has company_id).",
    };
  }

  return res.status(response?.status || 200).json({
    ...response,
    ...cacheMeta,
  });
}

if (!Number.isFinite(DEFAULT_LIST_CACHE_TTL_SEC) || DEFAULT_LIST_CACHE_TTL_SEC <= 0) {
  console.warn(
    `[redis] Invalid REDIS_TTL_LIST_CACHE / REDIS_TTL_WAREHOUSE_ACTIVE — using ${THREE_DAYS_SEC}s (3 days)`,
  );
}
if (isMemoryFallbackEnabled() && !isRedisConfigured()) {
  console.warn(
    `[redis] REDIS_ENABLED=false — list cache is in-process memory only (TTL ${resolveListCacheTtlSeconds()}s). Cache is cleared on server restart and when create/update/delete invalidates the module.`,
  );
} else if (!isListCacheStorageEnabled()) {
  console.warn(
    "[redis] List cache storage is OFF (REDIS_ENABLED=false and REDIS_MEMORY_FALLBACK=false). get-all / get-all-active responses are not stored.",
  );
} else {
  console.log(
    `[redis] List cache TTL: ${resolveListCacheTtlSeconds()}s (REDIS_ENABLED=${String(process.env.REDIS_ENABLED ?? "true")})`,
  );
}

module.exports = {
  DEFAULT_LIST_CACHE_TTL_SEC,
  resolveListCacheTtlSeconds,
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
  normalizeCacheKey,
  normalizeCompanyIdForCache,
  resolveCompanyIdFromReq,
  LIST_CACHE_ACTIONS,
  invalidateListCache,
  invalidateListCacheForReq,
  invalidateModuleListCachesForReq,
  invalidateAllListCacheForCompany,
  invalidateAllListCacheForReq,
  listAllListCacheForCompany,
  listAllListCacheForReq,
  runCachedListHandler,
  isListCacheStorageEnabled,
  isListCacheBypassed,
  LIST_CACHE_BYPASS_MODULES,
  isRedisConfigured,
  isRedisConnected,
  isMemoryFallbackEnabled,
};

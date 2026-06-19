/**
 * Exercise listAllListCacheForCompany with a mocked Redis scan iterator.
 * Usage: node scripts/test-list-cache-redis-mock.js
 */
process.env.REDIS_ENABLED = 'true';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';
process.env.REDIS_MEMORY_FALLBACK = 'true';

const Module = require('module');
const originalRequire = Module.prototype.require;

const COMPANY = '6a2c2ea0bf694c74695f24ec';
const mockKeys = [
  [
    `${COMPANY}:category:get-all-active`,
    `${COMPANY}:product:get-all-active`,
  ],
  Buffer.from(`${COMPANY}:warehouse:get-all-active`),
];

Module.prototype.require = function patchedRequire(id) {
  if (id === 'redis') {
    return {
      createClient: () => {
        const client = {
          isOpen: false,
          on() {},
          destroy() {},
          async connect() {
            client.isOpen = true;
            return client;
          },
          scanIterator: async function* scanIterator() {
            for (const key of mockKeys) yield key;
          },
          async ttl() {
            return 3600;
          },
          async get(key) {
            return JSON.stringify({ success: true, data: [], fromCache: true });
          },
          async set() {
            return 'OK';
          },
          async del() {
            return 1;
          },
        };
        return client;
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

const cachePath = require.resolve('../utils/redisCache');
delete require.cache[cachePath];

const { listAllListCacheForCompany } = require('../utils/redisCache');

listAllListCacheForCompany(COMPANY, { includeValues: true })
  .then((data) => {
    console.log('OK', {
      count: data.count,
      keys: data.entries.map((e) => e.key),
    });
  })
  .catch((err) => {
    console.error('FAILED', err.message);
    console.error(err.stack);
    process.exit(1);
  });

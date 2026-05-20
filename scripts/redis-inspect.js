/**
 * Inspect Redis cache from Windows (no redis-cli required).
 * Usage:
 *   node scripts/redis-inspect.js
 *   node scripts/redis-inspect.js 6a0b716e96e8f4d982b91243
 */
require("dotenv").config();

const { createClient } = require("redis");

const companyId = process.argv[2];
const url = process.env.REDIS_URL;

async function main() {
  if (!url || String(url).trim() === "") {
    console.error("Set REDIS_URL in .env");
    process.exit(1);
  }

  const client = createClient({
    url: String(url).trim(),
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: () => new Error("stop"),
    },
  });

  try {
    await client.connect();
    console.log("Connected:", url.replace(/:[^:@]+@/, ":****@"));

    const dbsize = await client.dbSize();
    console.log("\nTotal keys (DBSIZE):", dbsize);

    const info = await client.info("memory");
    const used = info.match(/used_memory_human:([^\r\n]+)/);
    const peak = info.match(/used_memory_peak_human:([^\r\n]+)/);
    if (used) console.log("Memory used:", used[1].trim());
    if (peak) console.log("Memory peak:", peak[1].trim());

    const pattern = companyId ? `${companyId}:*` : "*";
    console.log("\nKeys matching", pattern, ":\n");

    let cursor = 0;
    const keys = [];
    do {
      const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = reply.cursor;
      keys.push(...reply.keys);
    } while (cursor !== 0);

    if (keys.length === 0) {
      console.log("  (none — call get-all-active once while API is running)");
    }

    for (const key of keys) {
      const type = await client.type(key);
      const ttl = await client.ttl(key);
      let sizeNote = "";
      if (type === "string") {
        const len = await client.strLen(key);
        sizeNote = `${len} bytes`;
      }
      console.log(`  ${key}`);
      console.log(`    type=${type}  ttl=${ttl}s  ${sizeNote}`);
    }

    if (companyId) {
      const exact = `${companyId}:warehouse:get-all-active`;
      // Also try with query hash: KEYS `${companyId}:warehouse:get-all-active*`
      const exists = await client.exists(exact);
      if (exists) {
        const raw = await client.get(exact);
        console.log("\nPreview (first 200 chars):");
        console.log(raw.slice(0, 200) + (raw.length > 200 ? "..." : ""));
      }
    }
  } catch (err) {
    console.error("\nFailed:", err.message);
    if (err.code === "ECONNREFUSED") {
      console.error(
        "Nothing on REDIS_URL — use Redis Cloud URL in .env or start local Redis.",
      );
    }
    process.exit(1);
  } finally {
    try {
      await client.quit();
    } catch {
      /* ignore */
    }
  }
}

main();

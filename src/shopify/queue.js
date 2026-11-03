/**
 * Redis + BullMQ queue, with an in-process fallback when Redis is off.
 * @module src/shopify/queue
 */

const { ShopifyConnection } = require("./models");

const QUEUE_NAME = "shopify-sync";
const memoryJobs = [];
let queue;
let worker;
let started = false;
let usingMemory = false;
let draining = false;

function redisOptions() {
  const enabled = String(process.env.REDIS_ENABLED ?? "true").toLowerCase();
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url || enabled === "false" || enabled === "0") return null;
  return { url, maxRetriesPerRequest: null };
}

function jobIdOf(name, data, explicit) {
  if (explicit) return explicit;
  return `${name}:${data.connectionId}:${data.webhookId || "manual"}:${Date.now()}`;
}

async function enqueue(name, data, explicitId) {
  const jobId = jobIdOf(name, data, explicitId);
  const connection = redisOptions();
  if (connection && !usingMemory) {
    try {
      const { Queue } = require("bullmq");
      if (!queue) {
        queue = new Queue(QUEUE_NAME, { connection });
      }
      await queue.add(name, data, {
        jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      });
      return { queued: true, backend: "bullmq", jobId };
    } catch (error) {
      console.warn("[shopify] BullMQ unavailable, using in-process queue:", error.message);
      usingMemory = true;
    }
  }
  if (memoryJobs.some((job) => job.id === jobId)) {
    return { queued: false, duplicate: true, backend: "memory", jobId };
  }
  memoryJobs.push({ id: jobId, name, data, attempts: 0 });
  setImmediate(drainMemory);
  return { queued: true, backend: "memory", jobId };
}

async function drainMemory() {
  if (draining) return;
  draining = true;
  try {
    const { runJob } = require("./jobs");
    while (memoryJobs.length) {
      const job = memoryJobs.shift();
      try {
        await runJob(job.name, job.data);
      } catch (error) {
        job.attempts += 1;
        console.error(`[shopify] job ${job.name} failed:`, error?.message || error);
        if (job.attempts < 5) {
          memoryJobs.push(job);
          await new Promise((resolve) => setTimeout(resolve, 1000 * job.attempts));
        }
      }
    }
  } finally {
    draining = false;
  }
}

async function scheduleDueConnections() {
  if (mongooseReady() !== 1) return;
  const now = Date.now();
  const rows = await ShopifyConnection.find({ status: "connected" })
    .select("company_id shop_domain sync_settings last_sync_at")
    .lean();
  for (const row of rows) {
    const minutes = Number(row.sync_settings?.auto_sync_interval_minutes);
    if (!minutes) continue;
    const last = row.last_sync_at ? new Date(row.last_sync_at).getTime() : 0;
    if (now - last < minutes * 60 * 1000) continue;
    await enqueue(
      "reconcile",
      { connectionId: String(row._id), companyId: String(row.company_id) },
      `reconcile:${row._id}:${Math.floor(now / (minutes * 60 * 1000))}`,
    );
  }
}

function mongooseReady() {
  try {
    return require("mongoose").connection.readyState;
  } catch {
    return 0;
  }
}

function startShopifyWorker() {
  if (started) return;
  if (String(process.env.SHOPIFY_WORKER_ENABLED || "true").toLowerCase() === "false") {
    return;
  }
  started = true;
  const connection = redisOptions();
  if (connection) {
    try {
      const { Worker } = require("bullmq");
      worker = new Worker(
        QUEUE_NAME,
        async (job) => {
          const { runJob } = require("./jobs");
          return runJob(job.name, job.data);
        },
        { connection, concurrency: 2 },
      );
      worker.on("failed", (job, error) => {
        console.error(
          `[shopify] job ${job?.name} failed:`,
          error?.message || error,
        );
      });
      console.log("[shopify] BullMQ worker listening on", QUEUE_NAME);
    } catch (error) {
      usingMemory = true;
      console.warn("[shopify] BullMQ worker not started:", error.message);
    }
  } else {
    usingMemory = true;
    console.log("[shopify] Redis is off. Shopify jobs run in this process.");
  }
  const timer = setInterval(() => {
    scheduleDueConnections().catch((error) => {
      console.warn("[shopify] reconciliation schedule:", error?.message || error);
    });
  }, 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();
}

module.exports = {
  enqueue,
  startShopifyWorker,
  scheduleDueConnections,
};

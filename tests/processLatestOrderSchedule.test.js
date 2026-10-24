/**
 * fetch_latest_order waits next_run_at between runs. Runs against a throwaway local
 * MongoDB database (dropped afterwards); skipped when no MongoDB answers.
 */
const { after, before, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

process.env.REDIS_ENABLED = "false";
process.env.REDIS_QUEUE_ENABLED = "false";
process.env.REDIS_QUEUE_MEMORY_FALLBACK = "false";
process.env.PROCESS_QUEUE_WORKER_ENABLED = "false";

const MONGO = process.env.PROCESS_TEST_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = `process_latest_order_it_${Date.now()}`;
const TWO_MINUTES = 2 * 60 * 1000;

let available = false;
let ProcessModel;
let processCtrl;
let helpers;
const companyId = new mongoose.Types.ObjectId();

function fakeRes() {
  return {
    code: 0,
    body: null,
    status(code) {
      this.code = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const latestOrderJob = (fields = {}) =>
  ProcessModel.create({
    action: "fetch_latest_order",
    company_id: companyId,
    status: "active",
    progress: "not_started",
    priority: 5000,
    limit: 20,
    ...fields,
  });

const pickNext = () =>
  processCtrl.loadActiveProcess({ query: { company_id: String(companyId) }, params: {} });

before(async () => {
  try {
    await mongoose.connect(`${MONGO}/${DB_NAME}`, { serverSelectionTimeoutMS: 1500 });
    available = true;
  } catch {
    available = false;
    return;
  }
  ProcessModel = require("../models/process");
  processCtrl = require("../controllers/process");
  helpers = require("../utils/processHelpers");
});

after(async () => {
  if (!available) return;
  // Index builds that finish after the drop would create the database again.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init().catch(() => {})));
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
});

describe("fetch_latest_order scheduling", () => {
  it("finishing a run keeps the job active and sets next_run_at two minutes out", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const job = await latestOrderJob();
    const res = fakeRes();
    const startedAt = Date.now();

    await helpers.finishFetchLatestOrderBatch({}, res, job.toObject(), {
      fetched: 20,
      inserted: 0,
      skipped: 20,
      remarks: "Latest order poll",
    });

    const saved = await ProcessModel.findById(job._id).lean();
    assert.equal(saved.status, "active");
    assert.equal(saved.progress, "not_started");
    assert.equal(saved.hits, 1);
    const nextRun = new Date(saved.next_run_at).getTime();
    assert.ok(nextRun >= startedAt + TWO_MINUTES && nextRun <= Date.now() + TWO_MINUTES);
    assert.ok(res.body.data.next_run_at, "response tells a scoped drain to stop");
    await ProcessModel.deleteOne({ _id: job._id });
  });

  it("the worker skips the job until next_run_at passes; a run by id still works", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const job = await latestOrderJob({ next_run_at: new Date(Date.now() + 60_000) });

    assert.equal(await pickNext(), null);

    const manual = await processCtrl.loadActiveProcess({ query: {}, params: { id: String(job._id) } });
    assert.equal(String(manual._id), String(job._id));

    await ProcessModel.updateOne({ _id: job._id }, { next_run_at: new Date(Date.now() - 1000) });
    assert.equal(String((await pickNext())._id), String(job._id));
    await ProcessModel.deleteOne({ _id: job._id });
  });

  it("a waiting latest-order job does not hold back other jobs", async (t) => {
    if (!available) return t.skip("no local MongoDB");
    const waiting = await latestOrderJob({ priority: 1, next_run_at: new Date(Date.now() + 60_000) });
    const fetchOrders = await ProcessModel.create({
      action: "fetch_order",
      company_id: companyId,
      status: "active",
      progress: "not_started",
      priority: 1000,
    });

    assert.equal(String((await pickNext())._id), String(fetchOrders._id));
    await ProcessModel.deleteMany({ _id: { $in: [waiting._id, fetchOrders._id] } });
  });
});

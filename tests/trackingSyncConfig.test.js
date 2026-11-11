const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");
const { getSyncBatchSize } = require("../src/jobs/trackingSync.job");

describe("tracking sync configuration", () => {
  it("uses a batch size of 25 and never exceeds it", () => {
    const previous = process.env.COURIER_TRACKING_SYNC_LIMIT;
    try {
      delete process.env.COURIER_TRACKING_SYNC_LIMIT;
      assert.equal(getSyncBatchSize(), 25);

      process.env.COURIER_TRACKING_SYNC_LIMIT = "10";
      assert.equal(getSyncBatchSize(), 10);

      process.env.COURIER_TRACKING_SYNC_LIMIT = "100";
      assert.equal(getSyncBatchSize(), 25);

      process.env.COURIER_TRACKING_SYNC_LIMIT = "0.5";
      assert.equal(getSyncBatchSize(), 1);
    } finally {
      if (previous === undefined) delete process.env.COURIER_TRACKING_SYNC_LIMIT;
      else process.env.COURIER_TRACKING_SYNC_LIMIT = previous;
    }
  });

  it("sets MongoDB buffering timeout to 60 seconds", async () => {
    const originalConnect = mongoose.connect;
    let options;
    mongoose.connect = async (_uri, connectOptions) => {
      options = connectOptions;
      return mongoose;
    };

    try {
      await connectMonogodb("mongodb://localhost/test");
      assert.equal(options.bufferTimeoutMS, 60_000);
    } finally {
      mongoose.connect = originalConnect;
    }
  });
});

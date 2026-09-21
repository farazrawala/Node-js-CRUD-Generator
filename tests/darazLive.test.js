/**
 * Opt-in live Daraz Pakistan tests. Skipped unless DARAZ_LIVE_TEST=1.
 *
 *   DARAZ_LIVE_TEST=1 node --test tests/darazLive.test.js
 *   DARAZ_LIVE_TEST=1 DARAZ_LIVE_CREATE=1 node --test tests/darazLive.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const live = String(process.env.DARAZ_LIVE_TEST || "").trim() === "1";

describe("daraz live network", { skip: !live }, () => {
  it("calls api.daraz.pk with the active POS integration", async () => {
    const { runDarazLiveSmoke } = require("../scripts/daraz-live-smoke");
    try {
      const { results, failed } = await runDarazLiveSmoke({
        create: String(process.env.DARAZ_LIVE_CREATE || "").trim() === "1",
      });
      assert.ok(results.length > 0, "expected live steps to run");
      assert.equal(
        failed.length,
        0,
        failed.map((row) => `${row.name}: ${row.error}`).join(" | "),
      );
    } finally {
      await mongoose.disconnect().catch(() => {});
    }
  });
});

/**
 * Unit checks for imported-order duplicate helpers (no DB).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isMongoDuplicateKeyError } = require("../utils/processHelpers");

describe("isMongoDuplicateKeyError", () => {
  it("detects E11000 code", () => {
    assert.equal(isMongoDuplicateKeyError({ code: 11000 }), true);
    assert.equal(isMongoDuplicateKeyError({ code: 11001 }), true);
  });

  it("detects message text", () => {
    assert.equal(
      isMongoDuplicateKeyError({
        message: "E11000 duplicate key error collection: orders",
      }),
      true,
    );
  });

  it("rejects unrelated errors", () => {
    assert.equal(isMongoDuplicateKeyError(null), false);
    assert.equal(isMongoDuplicateKeyError({ code: 123 }), false);
    assert.equal(isMongoDuplicateKeyError(new Error("timeout")), false);
  });
});

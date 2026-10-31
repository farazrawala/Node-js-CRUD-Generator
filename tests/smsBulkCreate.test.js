const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { prepareSmsBulkDocuments, collectSmsMessageIds } = require("../controllers/sms_message");

const companyId = "64b000000000000000000001";

describe("prepareSmsBulkDocuments", () => {
  it("builds one document per unique number and adds the Pakistan prefix", () => {
    const result = prepareSmsBulkDocuments(
      {
        message: "Sale tomorrow",
        status: "on_hold",
        numbers: ["03231399646", "3007069021", "03231399646", "12"],
      },
      { companyId },
    );

    assert.equal(result.tooMany, false);
    assert.deepEqual(
      result.docs.map((doc) => doc.number),
      ["923231399646", "923007069021"],
    );
    assert.equal(result.docs[0].message, "Sale tomorrow");
    assert.equal(result.docs[0].status, "on_hold");
    assert.equal(result.docs[0].company_id, companyId);
    assert.equal(result.skipped, 2);
    assert.equal(result.errors.length, 1);
  });

  it("accepts items when numbers is omitted", () => {
    const result = prepareSmsBulkDocuments(
      { items: [{ number: "923001234567", message: "Hello" }] },
      { companyId },
    );
    assert.equal(result.docs.length, 1);
    assert.equal(result.docs[0].number, "923001234567");
    assert.equal(result.docs[0].message, "Hello");
  });

  it("keeps unique message ids for bulk delete", () => {
    const id = "64b0000000000000000000ab";
    const result = collectSmsMessageIds([id, id, "nope", ""]);
    assert.deepEqual(result.ids, [id]);
    assert.equal(result.skipped, 2);
  });

  it("rejects an empty list", () => {
    const result = prepareSmsBulkDocuments({ message: "Hi", numbers: [] }, { companyId });
    assert.equal(result.docs.length, 0);
  });
});

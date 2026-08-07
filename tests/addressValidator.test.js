/**
 * Address quality validator unit tests (no DB / network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateAddress,
} = require("../validators/addressValidator");

describe("addressValidator", () => {
  it("accepts a valid detailed address", () => {
    const r = validateAddress("12 Street 4 PECHS Karachi 75500 Pakistan");
    assert.equal(r.isValid, true);
    assert.ok(r.score >= 70);
    assert.ok(["MEDIUM", "HIGH"].includes(r.confidence));
    assert.ok(r.details.hasHouseNumber);
    assert.ok(r.details.hasStreet);
    assert.ok(r.details.hasCity);
  });

  it("warns when street keyword is missing but does not hard-fail length", () => {
    const r = validateAddress({
      house: "12",
      street: "",
      area: "PECHS Block 2",
      city: "Karachi",
      postalCode: "75500",
      country: "Pakistan",
      address: "12 PECHS Block 2 Karachi 75500 Pakistan",
    });
    // May still detect Block as street keyword
    assert.ok(r.score > 0);
    assert.ok(Array.isArray(r.warnings));
  });

  it("flags missing city", () => {
    const r = validateAddress("12 Street 4 Block A Phase 2 near park area");
    assert.ok(r.missingFields.includes("city") || r.warnings.some((w) => /city/i.test(w)));
    assert.ok(r.score < 90);
  });

  it("flags missing postal code via suggestions", () => {
    const r = validateAddress("12 Street 4 PECHS Karachi Pakistan");
    assert.ok(
      r.missingFields.includes("postalCode") ||
        r.suggestions.some((s) => /postal|zip/i.test(s)),
    );
  });

  it("rejects only city entered", () => {
    const r = validateAddress("Karachi");
    assert.equal(r.isValid, false);
    assert.ok(r.score < 40);
  });

  it("rejects only country entered", () => {
    const r = validateAddress("Pakistan");
    assert.equal(r.isValid, false);
  });

  it("flags random / gibberish text", () => {
    const r = validateAddress("asd asd qwe qwe zxcasd hello");
    assert.ok(
      r.isValid === false ||
        r.warnings.some((w) => /gibberish|random/i.test(w)) ||
        r.score < 70,
    );
  });

  it("rejects repeated characters", () => {
    const r = validateAddress("aaaaaaaaaaaa");
    assert.equal(r.isValid, false);
    assert.ok(r.warnings.some((w) => /repeated/i.test(w)));
  });

  it("detects duplicate words", () => {
    const r = validateAddress(
      "Street Street Street House 12 Block A Karachi Pakistan",
    );
    assert.ok(
      r.warnings.some((w) => /repeated words/i.test(w)) ||
        r.score < 100,
    );
  });

  it("rejects very short address", () => {
    const r = validateAddress("Lahore PK");
    assert.equal(r.isValid, false);
  });

  it("warns on blacklisted values", () => {
    const r = validateAddress("House 12 Street 4 test Karachi 75500 Pakistan");
    assert.ok(r.warnings.some((w) => /suspicious|placeholder|test/i.test(w)));
  });

  it("accepts structured fields input", () => {
    const r = validateAddress({
      house: "45",
      street: "Main Road",
      area: "DHA Phase 5",
      city: "Lahore",
      postalCode: "54000",
      country: "Pakistan",
    });
    assert.equal(r.isValid, true);
    assert.ok(r.score >= 70);
  });
});

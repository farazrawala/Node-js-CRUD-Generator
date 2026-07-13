/**
 * Lightweight unit checks for courier module (no DB / network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mapTcsStatus,
  mapLeopardStatus,
} = require("../src/couriers/statusMap");
const { UNIFIED_STATUSES, normalizeProviderKey } = require("../src/couriers/constants");
const CourierFactory = require("../src/couriers/CourierFactory");
const {
  encryptSecret,
  decryptSecret,
  maskSensitive,
} = require("../src/utils/encryptCredentials");
const { CourierError } = require("../src/couriers/errors");

describe("courier status mapping", () => {
  it("maps TCS delivered code OK", () => {
    assert.equal(mapTcsStatus({ code: "OK", status: "Delivered" }), UNIFIED_STATUSES.DELIVERED);
  });

  it("maps TCS out for delivery text", () => {
    assert.equal(
      mapTcsStatus({ status: "Out For Delivery" }),
      UNIFIED_STATUSES.OUT_FOR_DELIVERY,
    );
  });

  it("maps Leopard statuses", () => {
    assert.equal(mapLeopardStatus({ status: "Delivered" }), UNIFIED_STATUSES.DELIVERED);
    assert.equal(mapLeopardStatus({ status: "Dispatched" }), UNIFIED_STATUSES.IN_TRANSIT);
  });
});

describe("courier factory", () => {
  it("registers TCS and Leopard", () => {
    assert.ok(CourierFactory.isRegistered("TCS"));
    assert.ok(CourierFactory.isRegistered("leopard"));
  });

  it("normalizes provider aliases", () => {
    assert.equal(normalizeProviderKey("tcs"), "TCS");
    assert.equal(normalizeProviderKey("LCS"), "Leopard");
    assert.equal(normalizeProviderKey("M&P"), "M&P");
  });

  it("builds TCS driver from config", () => {
    const driver = CourierFactory.get(
      { _id: "c1", preferred_courier: "TCS" },
      {
        provider: "TCS",
        username: "u",
        password: "p",
        api_key: "k",
        secret: "s",
        sandbox: true,
        settings: {},
      },
    );
    assert.equal(driver.providerName, "TCS");
  });
});

describe("credential encryption", () => {
  it("round-trips secrets", () => {
    const enc = encryptSecret("super-secret");
    assert.match(enc, /^enc:v1:/);
    assert.equal(decryptSecret(enc), "super-secret");
  });

  it("masks sensitive keys", () => {
    const masked = maskSensitive({ password: "abc", tracking: "1" });
    assert.equal(masked.password, "[REDACTED]");
    assert.equal(masked.tracking, "1");
  });
});

describe("courier errors", () => {
  it("exposes httpStatus", () => {
    const err = new CourierError("x", { code: "Y", httpStatus: 409 });
    assert.equal(err.httpStatus, 409);
    assert.equal(err.code, "Y");
  });
});

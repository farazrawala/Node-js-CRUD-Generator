/**
 * Lightweight unit checks for courier module (no DB / network).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mapTcsStatus,
  mapLeopardStatus,
  mapFlashipStatus,
} = require("../src/couriers/statusMap");
const {
  UNIFIED_STATUSES,
  normalizeProviderKey,
  planImportedCourier,
} = require("../src/couriers/constants");
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

  it("maps Flaship statuses", () => {
    assert.equal(mapFlashipStatus({ order_status: "Out for Delivery" }), UNIFIED_STATUSES.OUT_FOR_DELIVERY);
    assert.equal(mapFlashipStatus({ status: "Picked up" }), UNIFIED_STATUSES.PICKED);
    assert.equal(mapFlashipStatus({ status: "Return in Transit" }), UNIFIED_STATUSES.RETURNED);
  });
});

describe("courier status to order_status", () => {
  const { mapCourierStatusToOrderStatus } = require("../src/couriers/statusMap");

  it("maps delivered scans to order.order_status delivered", () => {
    assert.equal(mapCourierStatusToOrderStatus("Delivered"), "delivered");
    assert.equal(mapCourierStatusToOrderStatus("OK"), "delivered");
    assert.equal(mapCourierStatusToOrderStatus(UNIFIED_STATUSES.DELIVERED), "delivered");
  });

  it("maps in-transit style scans", () => {
    assert.equal(mapCourierStatusToOrderStatus("Out For Delivery"), "in_transit");
    assert.equal(mapCourierStatusToOrderStatus("In Transit"), "in_transit");
    assert.equal(mapCourierStatusToOrderStatus("Dispatched"), "in_transit");
  });

  it("maps booked/picked to packed", () => {
    assert.equal(mapCourierStatusToOrderStatus("Booked"), "packed");
    assert.equal(mapCourierStatusToOrderStatus("Picked up"), "packed");
  });

  it("maps returned and cancelled", () => {
    assert.equal(mapCourierStatusToOrderStatus("Returned"), "return");
    assert.equal(mapCourierStatusToOrderStatus("Cancelled"), "cancelled");
  });
});

describe("courier factory", () => {
  it("registers TCS, Leopard, PostEx, and Flagship", () => {
    assert.ok(CourierFactory.isRegistered("TCS"));
    assert.ok(CourierFactory.isRegistered("leopard"));
    assert.ok(CourierFactory.isRegistered("postex"));
    assert.ok(CourierFactory.isRegistered("flagship"));
    assert.ok(CourierFactory.isRegistered("flaship"));
  });

  it("normalizes provider aliases", () => {
    assert.equal(normalizeProviderKey("tcs"), "TCS");
    assert.equal(normalizeProviderKey("LCS"), "Leopard");
    assert.equal(normalizeProviderKey("M&P"), "M&P");
    assert.equal(normalizeProviderKey("flagship"), "Flagship");
    assert.equal(normalizeProviderKey("Flaship"), "Flagship");
    assert.equal(normalizeProviderKey("Leopards Courier"), "Leopard");
  });

  it("plans a basic courier row for known and unknown names", () => {
    assert.deepEqual(planImportedCourier("Leopards Courier"), {
      type: "leopard",
      name: "Leopard",
      provider: "Leopard",
    });
    assert.deepEqual(planImportedCourier("Stallion"), {
      type: "other",
      name: "Stallion",
      provider: "Other",
    });
    assert.equal(planImportedCourier("  "), null);
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

  it("builds Flagship driver from config", () => {
    const driver = CourierFactory.get(
      { _id: "c1", preferred_courier: "Flagship" },
      {
        provider: "Flagship",
        token: "test-api-key",
        sandbox: true,
        settings: {},
      },
    );
    assert.equal(driver.providerName, "Flagship");
  });
});

describe("Flagship tracking status", () => {
  const trackWith = async (body) => {
    const driver = CourierFactory.get(
      { _id: "c1", preferred_courier: "Flagship" },
      { provider: "Flagship", token: "test-api-key", sandbox: true, settings: {} },
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      return await driver.getTracking(body.tracking_number);
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it("saves the live courier scan, not the SHIPPER_ADVISE portal bucket", async () => {
    const result = await trackWith({
      success: true,
      tracking_number: "20222370029635",
      status: "SHIPPER_ADVISE",
      live_courier_status: "Shipment - Delivery Unsuccessful",
      tracking: [
        { status: "Shipment - Out for Delivery", time: "2026-11-10 00:16:00" },
        { status: "Shipment - Delivery Unsuccessful", time: "2026-11-10 13:09:00" },
      ],
    });
    assert.equal(result.lastStatus, "Shipment - Delivery Unsuccessful");
    assert.equal(result.status, UNIFIED_STATUSES.EXCEPTION);
  });

  it("falls back to the latest event when live_courier_status is missing", async () => {
    const result = await trackWith({
      success: true,
      tracking_number: "1",
      status: "IN_TRANSIT",
      tracking: [
        { status: "Shipment - In Transit", time: "2026-11-06 18:10:00" },
        { status: "Shipment - Arrived at Destination", time: "2026-11-07 22:16:00" },
      ],
    });
    assert.equal(result.lastStatus, "Shipment - Arrived at Destination");
  });

  it("keeps the portal code once the shipment is final", async () => {
    const result = await trackWith({
      success: true,
      tracking_number: "2",
      status: "CANCELLED",
      live_courier_status: "Booked",
      tracking: [{ status: "BOOKED", time: "2026-11-01 10:00:00" }],
    });
    assert.equal(result.lastStatus, "CANCELLED");
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

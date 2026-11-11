const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTrackingStatusFilter,
  isStoredInTransitTrackingStatus,
} = require("../src/utils/orderTrackingStatus");

describe("order tracking status filter", () => {
  it("matches In Transit courier scans and orders with POS In Transit status", () => {
    const filter = buildTrackingStatusFilter("In Transit");
    const [trackingStatus, orderStatus] = filter.$or;

    assert.equal(trackingStatus.tracking_status.test("TRANSIT"), true);
    assert.equal(trackingStatus.tracking_status.test("Shipment - In Transit"), true);
    assert.equal(trackingStatus.tracking_status.test("Re-Attempt Call Requested"), false);
    assert.equal(orderStatus.order_status.test("in_transit"), true);
  });

  it("keeps other tracking status filters specific to courier status", () => {
    const filter = buildTrackingStatusFilter("Re-Attempt Call Requested");

    assert.equal(filter.tracking_status.test("Re-Attempt Call Requested"), true);
    assert.equal(filter.tracking_status.test("In Transit"), false);
    assert.equal(filter.$or, undefined);
  });

  it("recognizes raw transit aliases for canonical count aggregation", () => {
    for (const status of [
      "TRANSIT",
      "Shipment - In Transit",
      "Dispatched",
      "Departed",
      "On Route",
    ]) {
      assert.equal(isStoredInTransitTrackingStatus(status), true, status);
    }
    assert.equal(isStoredInTransitTrackingStatus("Re-Attempt Call Requested"), false);
  });
});

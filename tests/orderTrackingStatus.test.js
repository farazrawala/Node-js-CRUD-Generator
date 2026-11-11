const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTrackingStatusFilter,
  findStuckInTransitOrderIds,
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

  it("finds active company shipments with an In Transit event older than the threshold", async () => {
    const now = new Date("2026-11-11T12:00:00.000Z").getTime();
    const shipmentIds = ["shipment-1"];
    const expectedOrderIds = ["order-1"];
    let shipmentQuery;
    let orderQuery;
    const CourierTracking = {
      distinct: async (field, query) => {
        shipmentQuery = { field, query };
        return shipmentIds;
      },
    };
    const CourierShipment = {
      distinct: async (field, query) => {
        orderQuery = { field, query };
        return expectedOrderIds;
      },
    };

    const orderIds = await findStuckInTransitOrderIds({
      CourierTracking,
      CourierShipment,
      companyId: "company-1",
      days: 5,
      now,
    });

    assert.deepEqual(orderIds, expectedOrderIds);
    assert.equal(shipmentQuery.field, "shipment_id");
    assert.equal(shipmentQuery.query.company_id, "company-1");
    assert.equal(shipmentQuery.query.status, "In Transit");
    assert.equal(
      shipmentQuery.query.event_time.$lte.toISOString(),
      "2026-11-06T12:00:00.000Z",
    );
    assert.deepEqual(orderQuery.query._id.$in, shipmentIds);
    assert.equal(orderQuery.query.company_id, "company-1");
    assert.equal(orderQuery.query.deletedAt, null);
  });

  it("returns no orders when no old In Transit scan exists", async () => {
    let shipmentLookupCalled = false;
    const orderIds = await findStuckInTransitOrderIds({
      CourierTracking: { distinct: async () => [] },
      CourierShipment: {
        distinct: async () => {
          shipmentLookupCalled = true;
          return ["unexpected"];
        },
      },
      companyId: "company-1",
      days: 5,
    });

    assert.deepEqual(orderIds, []);
    assert.equal(shipmentLookupCalled, false);
  });
});

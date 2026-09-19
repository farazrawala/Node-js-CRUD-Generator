/**
 * Unit tests: Shopify fulfillment tracking → POS fields on fetch/pull.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  extractShopifyFulfillmentTracking,
  buildPosTrackingFieldsFromShopify,
  mapShopifyShipmentStatusToPosTrackingStatus,
} = require("../utils/processHelpers");

describe("mapShopifyShipmentStatusToPosTrackingStatus", () => {
  it("maps common Shopify shipment statuses", () => {
    assert.equal(
      mapShopifyShipmentStatusToPosTrackingStatus("delivered"),
      "delivered",
    );
    assert.equal(
      mapShopifyShipmentStatusToPosTrackingStatus("in_transit"),
      "in_transit",
    );
    assert.equal(
      mapShopifyShipmentStatusToPosTrackingStatus("Out for Delivery"),
      "out_for_delivery",
    );
    assert.equal(
      mapShopifyShipmentStatusToPosTrackingStatus("confirmed"),
      "booked",
    );
  });
});

describe("extractShopifyFulfillmentTracking", () => {
  it("returns null when no fulfillments", () => {
    assert.equal(extractShopifyFulfillmentTracking({}), null);
    assert.equal(extractShopifyFulfillmentTracking({ fulfillments: [] }), null);
  });

  it("reads tracking from nested fulfillments", () => {
    const tracking = extractShopifyFulfillmentTracking({
      fulfillments: [
        {
          status: "success",
          tracking_number: "22000310000025",
          tracking_company: "PostEx",
          tracking_url: "https://postex.pk/tracking?cn=22000310000025",
          shipment_status: "delivered",
          updated_at: "2026-09-17T01:00:00Z",
        },
      ],
    });
    assert.equal(tracking.tracking_number, "22000310000025");
    assert.equal(tracking.courier_name, "PostEx");
    assert.equal(tracking.tracking_status, "delivered");
    assert.match(tracking.tracking_url, /22000310000025/);
  });

  it("prefers latest fulfillment with a number and skips cancelled", () => {
    const tracking = extractShopifyFulfillmentTracking({
      fulfillments: [
        {
          status: "success",
          tracking_number: "OLD",
          tracking_company: "PostEx",
          updated_at: "2026-09-16T01:00:00Z",
        },
        {
          status: "cancelled",
          tracking_number: "CANCELLED",
          updated_at: "2026-09-17T02:00:00Z",
        },
        {
          status: "success",
          tracking_numbers: ["22000310000025"],
          tracking_company: "PostEx",
          shipment_status: "delivered",
          updated_at: "2026-09-17T01:30:00Z",
        },
      ],
    });
    assert.equal(tracking.tracking_number, "22000310000025");
    assert.equal(tracking.tracking_status, "delivered");
  });
});

describe("buildPosTrackingFieldsFromShopify", () => {
  it("builds POS order fields", () => {
    const fields = buildPosTrackingFieldsFromShopify({
      tracking_number: "22000310000025",
      courier_name: "PostEx",
      tracking_url: "https://example.com/t",
      tracking_status: "delivered",
      shipment_status: "delivered",
    });
    assert.equal(fields.courier_tracking_number, "22000310000025");
    assert.equal(fields.tracking_status, "delivered");
    assert.match(fields.tracking_details, /PostEx/);
  });

  it("returns empty object without tracking number", () => {
    assert.deepEqual(buildPosTrackingFieldsFromShopify(null), {});
    assert.deepEqual(buildPosTrackingFieldsFromShopify({}), {});
  });
});

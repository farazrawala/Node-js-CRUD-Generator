/**
 * Unit tests: OMS order_status → website / Shopify / WooCommerce mappings.
 * Covers every status in todo.txt (Shopify status acc to our status).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mapPosOrderStatusToWebsiteStatus,
  ORDER_WEBSITE_STATUS_VALUES,
} = require("../models/order");
const {
  mapPosOrderStatusToShopifyFulfillmentAction,
  mapPosOrderStatusToWoo,
  mapTrackingStatusToShopifyFulfillmentEvent,
  mapShopifyOrderStatus,
  resolveOrderWebsiteStatus,
} = require("../utils/processHelpers");

/** Spec from todo.txt — POS status → website/Shopify display status. */
const POS_TO_WEBSITE_CASES = [
  ["pending", "pending"],
  ["draft", "pending"],
  ["placed", "confirmed"],
  ["confirmed", "confirmed"],
  ["processing", "processing"],
  ["active", "processing"],
  ["packed", "shipped"],
  ["in_transit", "shipped"],
  ["delivered", "delivered"],
  ["completed", "completed"],
  ["cancelled", "voided"],
  ["duplicate", "voided"],
  ["failed", "failed"],
  ["on_hold", "on-hold"],
  ["products_skipped", "on-hold"],
  ["return", "refunded"],
  ["return_received", "refunded"],
];

/** POS status → Shopify Fulfillment Orders sync action (push_order). */
const POS_TO_SHOPIFY_ACTION_CASES = [
  ["pending", "none"],
  ["draft", "none"],
  ["placed", "release_hold"],
  ["confirmed", "release_hold"],
  ["processing", "release_hold"],
  ["active", "release_hold"],
  ["packed", "ship_with_tracking"],
  ["in_transit", "ship_with_tracking"],
  ["shipped", "ship_with_tracking"],
  ["delivered", "deliver"],
  ["completed", "deliver"],
  ["cancelled", "cancel"],
  ["duplicate", "cancel"],
  ["return", "refund"],
  ["return_received", "refund"],
  ["on_hold", "hold"],
  ["failed", "none"],
  ["products_skipped", "none"],
];

/** POS status → WooCommerce REST order status. */
const POS_TO_WOO_CASES = [
  ["pending", "pending"],
  ["draft", "pending"],
  ["placed", "processing"],
  ["confirmed", "processing"],
  ["processing", "processing"],
  ["active", "processing"],
  ["packed", "processing"],
  ["in_transit", "processing"],
  ["delivered", "completed"],
  ["completed", "completed"],
  ["cancelled", "cancelled"],
  ["duplicate", "cancelled"],
  ["failed", "failed"],
  ["on_hold", "on-hold"],
  ["return", "refunded"],
  ["return_received", "refunded"],
];

describe("POS → website status (Shopify display map)", () => {
  for (const [posStatus, expected] of POS_TO_WEBSITE_CASES) {
    it(`${posStatus} → ${expected}`, () => {
      const mapped = mapPosOrderStatusToWebsiteStatus(posStatus);
      assert.equal(mapped, expected);
      assert.ok(
        ORDER_WEBSITE_STATUS_VALUES.includes(mapped),
        `${mapped} must be a valid order_website_status`,
      );
    });
  }

  it("is case-insensitive and trims", () => {
    assert.equal(
      mapPosOrderStatusToWebsiteStatus("  PROCESSING "),
      "processing",
    );
    assert.equal(mapPosOrderStatusToWebsiteStatus("On_Hold"), "on-hold");
  });

  it("returns null for unknown status", () => {
    assert.equal(mapPosOrderStatusToWebsiteStatus("not_a_real_status"), null);
    assert.equal(mapPosOrderStatusToWebsiteStatus(""), null);
  });
});

describe("POS → Shopify fulfillment action (push_order)", () => {
  for (const [posStatus, expected] of POS_TO_SHOPIFY_ACTION_CASES) {
    it(`${posStatus} → ${expected}`, () => {
      assert.equal(
        mapPosOrderStatusToShopifyFulfillmentAction(posStatus),
        expected,
      );
    });
  }

  it("processing maps to release_hold (not ship)", () => {
    assert.equal(
      mapPosOrderStatusToShopifyFulfillmentAction("processing"),
      "release_hold",
    );
  });
});

describe("POS → WooCommerce order status (push_order)", () => {
  for (const [posStatus, expected] of POS_TO_WOO_CASES) {
    it(`${posStatus} → ${expected}`, () => {
      assert.equal(mapPosOrderStatusToWoo(posStatus), expected);
    });
  }
});

describe("courier tracking → Shopify fulfillment event", () => {
  it("maps common tracking statuses", () => {
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("booked"),
      "confirmed",
    );
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("in_transit"),
      "in_transit",
    );
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("Out For Delivery"),
      "out_for_delivery",
    );
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("delivered"),
      "delivered",
    );
  });

  it("falls back from order_status when tracking is empty", () => {
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("", "in_transit"),
      "in_transit",
    );
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent(null, "delivered"),
      "delivered",
    );
    assert.equal(
      mapTrackingStatusToShopifyFulfillmentEvent("", "placed"),
      null,
    );
  });
});

describe("Shopify remote → POS status (pull/fetch)", () => {
  it("treats fulfilled COD (payment pending) as in transit / shipped", () => {
    assert.equal(
      mapShopifyOrderStatus("pending", "fulfilled", "in_transit"),
      "in_transit",
    );
    assert.equal(
      mapShopifyOrderStatus("pending", "fulfilled", "delivered"),
      "delivered",
    );
    assert.equal(
      resolveOrderWebsiteStatus(
        {
          financial_status: "pending",
          fulfillment_status: "fulfilled",
          fulfillments: [
            {
              status: "success",
              tracking_number: "22000310000025",
              shipment_status: "delivered",
            },
          ],
        },
        "shopify",
      ),
      "delivered",
    );
  });

  it("maps paid unfulfilled to confirmed", () => {
    assert.equal(mapShopifyOrderStatus("paid", null), "confirmed");
    assert.equal(
      resolveOrderWebsiteStatus(
        { financial_status: "paid", fulfillment_status: null },
        "shopify",
      ),
      "confirmed",
    );
  });
});

describe("full matrix smoke (all website statuses covered)", () => {
  it("every mapped website value is unique to the expected set", () => {
    const values = new Set(POS_TO_WEBSITE_CASES.map(([, v]) => v));
    for (const v of values) {
      assert.ok(
        ORDER_WEBSITE_STATUS_VALUES.includes(v),
        `unexpected website status in matrix: ${v}`,
      );
    }
  });
});

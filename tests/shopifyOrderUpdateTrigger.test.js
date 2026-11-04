const test = require("node:test");
const assert = require("node:assert/strict");
const { extractTriggerOrderId } = require("../controllers/shopifyWebhook");
const { webhookEmailSubject } = require("../utils/orderUpdateMail");

test("order update trigger reads the Shopify order id", () => {
  assert.equal(extractTriggerOrderId({ id: 556677 }, {}), "556677");
  assert.equal(
    extractTriggerOrderId({ order_id: "1001" }, {}),
    "1001",
  );
  assert.equal(
    extractTriggerOrderId(
      { admin_graphql_api_id: "gid://shopify/Order/889900" },
      {},
    ),
    "889900",
  );
  assert.equal(extractTriggerOrderId({}, { order_id: "#4421" }), "4421");
});

test("order update trigger ignores a body with no order id", () => {
  assert.equal(extractTriggerOrderId({ topic: "orders/updated" }, {}), "");
});

test("webhook email subject names the order event", () => {
  const body = { order_number: 1099 };
  assert.equal(webhookEmailSubject("orders/create", body), "New Order arrived.");
  assert.equal(webhookEmailSubject("orders/updated", body), "Order Number : 1099 is updated");
  assert.equal(webhookEmailSubject("orders/fulfilled", body), "Order Number : 1099 is fulfilled");
  assert.equal(webhookEmailSubject("orders/cancelled", body), "Order Number : 1099 is cancel");
  assert.equal(
    webhookEmailSubject("orders/partially_fulfilled", body),
    "Order Number : 1099 is partially fulfilled",
  );
});

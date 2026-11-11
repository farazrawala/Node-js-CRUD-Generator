const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RECIPIENT,
  buildTrackingStatusUpdateEmail,
} = require("../src/utils/trackingStatusUpdateMail");

test("builds a tracking status email with the order number and integration logo", () => {
  const email = buildTrackingStatusUpdateEmail({
    orderNo: "ORD-123",
    status: "Shipment - Arrived at Origin",
    integrationImage: "uploads/integration/store.png",
    integrationName: "Example Store",
  });

  assert.equal(RECIPIENT, "johndavid78663@gmail.com");
  assert.equal(
    email.text,
    "Your order NO: ORD-123 delivery status has been updated to: Shipment - Arrived at Origin",
  );
  assert.match(email.html, /src="[^"]*\/uploads\/integration\/store\.png"/);
  assert.match(email.html, /alt="Example Store"/);
});

test("escapes status content and omits the logo when unavailable", () => {
  const email = buildTrackingStatusUpdateEmail({
    orderNo: "ORD-123",
    status: "<Delivered & signed>",
  });

  assert.match(email.html, /&lt;Delivered &amp; signed&gt;/);
  assert.doesNotMatch(email.html, /<img/);
});

test("does not build an email without a tracking status", () => {
  assert.equal(buildTrackingStatusUpdateEmail({ orderNo: "ORD-123", status: "" }), null);
});

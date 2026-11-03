process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY = "unit-test-shopify-token-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

require("@shopify/shopify-api/adapters/node");
const { shopifyApi } = require("@shopify/shopify-api");
const { encryptToken, decryptToken } = require("../src/shopify/tokenCrypto");
const { normalizeShopDomain } = require("../src/shopify/shopDomain");
const { installedScopes, CORE_SCOPES } = require("../src/shopify/constants");
const { oauthMessage, verifyOauthHmac, verifyWebhookHmac } = require("../src/shopify/oauthHmac");
const { mapGraphqlOrder } = require("../src/shopify/orderMapper");
const { shouldApplyRemoteInventory } = require("../src/shopify/inventoryGuard");
const { presentRecord } = require("../src/shopify/present");
const { assertSameCompany } = require("../src/shopify/tenancy");

const COMPANY_A = "64b00000000000000000000a";
const COMPANY_B = "64b00000000000000000000b";

test("shop domains accept myshopify hosts and reject other hosts", () => {
  assert.equal(normalizeShopDomain("My-Store"), "my-store.myshopify.com");
  assert.equal(
    normalizeShopDomain("https://my-store.myshopify.com/admin"),
    "my-store.myshopify.com",
  );
  assert.equal(normalizeShopDomain("https://evil.com"), null);
  assert.equal(normalizeShopDomain("my-store.myshopify.com.evil.com"), null);
  assert.equal(normalizeShopDomain(""), null);
});

test("access tokens encrypt at rest and decrypt for API calls", () => {
  const stored = encryptToken("shpat_test_token_value");
  assert.match(stored, /^enc:v1:/);
  assert.equal(stored.includes("shpat_test_token_value"), false);
  assert.equal(decryptToken(stored), "shpat_test_token_value");
  assert.equal(decryptToken("shpat_plain"), "shpat_plain");
});

test("oauth hmac matches the Shopify library and rejects a bad signature", async () => {
  const secret = "shpss_unit_test_secret";
  const shopify = shopifyApi({
    apiKey: "unit-test-key",
    apiSecretKey: secret,
    scopes: ["read_products"],
    hostName: "example.com",
    apiVersion: "2026-01",
    isEmbeddedApp: false,
  });
  const query = {
    code: "auth-code",
    shop: "demo.myshopify.com",
    state: "state-token",
    timestamp: String(Math.trunc(Date.now() / 1000)),
  };
  query.hmac = crypto.createHmac("sha256", secret).update(oauthMessage(query)).digest("hex");
  assert.equal(verifyOauthHmac(query, secret), true);
  assert.equal(await shopify.utils.validateHmac({ ...query }), true);
  assert.equal(verifyOauthHmac({ ...query, hmac: "0".repeat(64) }, secret), false);
});

test("webhook hmac uses the raw body", () => {
  const secret = "shpss_unit_test_secret";
  const body = Buffer.from(JSON.stringify({ id: 10 }));
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("base64");
  assert.equal(verifyWebhookHmac(body, hmac, secret), true);
  assert.equal(verifyWebhookHmac(body, hmac, "other-secret"), false);
  assert.equal(verifyWebhookHmac(Buffer.from("{}"), hmac, secret), false);
});

test("scopes request reports and fulfillment, not read_analytics", () => {
  const scopes = installedScopes();
  for (const scope of CORE_SCOPES) assert.equal(scopes.includes(scope), true);
  assert.equal(scopes.includes("read_reports"), true);
  assert.equal(scopes.includes("read_merchant_managed_fulfillment_orders"), true);
  assert.equal(scopes.includes("read_analytics"), false);
  assert.equal(scopes.includes("read_all_orders"), false);
});

test("graphql orders become the POS importer shape", () => {
  const remote = mapGraphqlOrder({
    id: "gid://shopify/Order/99",
    legacyResourceId: "99",
    name: "#1001",
    email: "buyer@example.com",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currencyCode: "PKR",
    sourceName: "web",
    paymentGatewayNames: ["Cash on Delivery"],
    totalPriceSet: { shopMoney: { amount: "1500.00" } },
    totalDiscountsSet: { shopMoney: { amount: "100.00" } },
    totalTaxSet: { shopMoney: { amount: "50.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "200.00" } },
    customer: { firstName: "Ayesha", lastName: "Khan", email: "buyer@example.com", phone: "03001234567" },
    shippingAddress: {
      firstName: "Ayesha",
      lastName: "Khan",
      address1: "12 Mall Road",
      city: "Lahore",
      province: "Punjab",
      zip: "54000",
      country: "Pakistan",
      phone: "03001234567",
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          name: "Coat - XL",
          sku: "COAT-XL",
          quantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: "750.00" } },
          product: { legacyResourceId: "55" },
          variant: { legacyResourceId: "77", sku: "COAT-XL", barcode: "100077" },
        },
      ],
    },
    fulfillments: [],
  });
  assert.equal(remote.id, "99");
  assert.equal(remote.order_number, "1001");
  assert.equal(remote.financial_status, "paid");
  assert.equal(remote.line_items[0].product_id, "55");
  assert.equal(remote.line_items[0].variant_id, "77");
  assert.equal(remote.line_items[0].sku, "COAT-XL");
  assert.equal(remote.total_tax, "50.00");
  assert.equal(remote.shipping_address.city, "Lahore");
  assert.deepEqual(remote.payment_gateway_names, ["Cash on Delivery"]);
});

test("cancelled shopify orders map to a cancelled POS financial status", () => {
  const remote = mapGraphqlOrder({
    id: "gid://shopify/Order/5",
    legacyResourceId: "5",
    name: "#5",
    cancelledAt: "2026-10-01T00:00:00Z",
    displayFinancialStatus: "PAID",
    lineItems: { nodes: [] },
  });
  assert.equal(remote.financial_status, "voided");
  assert.ok(remote.cancelled_at);
});

test("pos-led inventory ignores remote quantities and suppresses echoes", () => {
  assert.deepEqual(
    shouldApplyRemoteInventory({ direction: "pos_to_shopify", incomingQty: 4 }),
    { apply: false, reason: "pos_is_source_of_truth" },
  );
  const now = Date.now();
  assert.equal(
    shouldApplyRemoteInventory({
      direction: "bidirectional",
      incomingQty: 8,
      lastPushedQty: 8,
      lastPushedAt: new Date(now - 1000),
      now,
    }).reason,
    "echo_suppressed",
  );
  assert.equal(
    shouldApplyRemoteInventory({
      direction: "shopify_to_pos",
      incomingQty: 3,
      lastPushedQty: 8,
      lastPushedAt: new Date(now - 1000),
      now,
    }).apply,
    true,
  );
});

test("api records omit tokens and block another company", () => {
  const view = presentRecord({
    shop_domain: "demo.myshopify.com",
    access_token_enc: "enc:v1:secret",
    token: "shpat_hidden",
    integration_id: { name: "Demo", secret: "oauth-managed", token: "enc:v1:x" },
  });
  assert.equal(view.shop_domain, "demo.myshopify.com");
  assert.equal(view.access_token_enc, undefined);
  assert.equal(view.token, undefined);
  assert.equal(view.integration_id.secret, undefined);
  assert.equal(view.integration_id.token, undefined);
  assert.throws(() => assertSameCompany({ company_id: COMPANY_A }, COMPANY_B), /not available/);
  assert.equal(String(assertSameCompany({ company_id: COMPANY_A }, COMPANY_A)), COMPANY_A);
});

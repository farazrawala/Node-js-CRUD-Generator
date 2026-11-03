/**
 * App webhook receiver and webhook registration.
 * @module src/shopify/webhooks
 */

const crypto = require("crypto");
const { WEBHOOK_TOPICS } = require("./constants");
const { verifyWebhookHmac } = require("./oauthHmac");
const { normalizeShopDomain } = require("./shopDomain");
const { webhookUrl } = require("./client");
const { adminClient, markUninstalled } = require("./connectionService");
const { ShopifyConnection, ShopifyWebhookEvent } = require("./models");
const { enqueue } = require("./queue");

function header(req, name) {
  const value = req.get?.(name) || req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value || "";
}

async function registerWebhooks(connection) {
  const client = await adminClient(connection);
  const callback = webhookUrl();
  const results = [];
  for (const topic of WEBHOOK_TOPICS) {
    try {
      const data = await client.query(
        `mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $webhook: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhook) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }`,
        {
          topic: topic.graphql,
          webhook: { callbackUrl: callback, format: "JSON" },
        },
      );
      const errors = data?.webhookSubscriptionCreate?.userErrors || [];
      const already = errors.some((error) =>
        /already been taken|already exists/i.test(error.message || ""),
      );
      results.push({
        topic: topic.rest,
        ok: errors.length === 0 || already,
        error: already ? "" : errors.map((error) => error.message).join("; "),
      });
    } catch (error) {
      results.push({ topic: topic.rest, ok: false, error: error.message });
    }
  }
  return results;
}

async function receiveWebhook(req) {
  const secret = String(process.env.SHOPIFY_API_SECRET || "");
  const raw = req.rawBody;
  if (!verifyWebhookHmac(raw, header(req, "x-shopify-hmac-sha256"), secret)) {
    const error = new Error("Invalid Shopify webhook signature.");
    error.status = 401;
    throw error;
  }
  const shop = normalizeShopDomain(header(req, "x-shopify-shop-domain"));
  const topic = String(header(req, "x-shopify-topic") || "");
  const webhookId =
    String(header(req, "x-shopify-webhook-id") || "") ||
    crypto.createHash("sha256").update(raw || Buffer.from("")).digest("hex");

  if (!shop) return { ok: true, ignored: true };

  if (topic === "app/uninstalled" || topic === "shop/redact") {
    await markUninstalled(shop);
    if (topic === "shop/redact") {
      await scrubShop(shop);
    }
    return { ok: true };
  }

  const connection = await ShopifyConnection.findOne({
    shop_domain: shop,
    status: "connected",
  }).lean();
  if (!connection) return { ok: true, ignored: true };

  if (topic === "customers/redact" || topic === "customers/data_request") {
    await ShopifyWebhookEvent.create({
      company_id: connection.company_id,
      shop_domain: shop,
      shopify_id: webhookId,
      topic,
      status: "processed",
      payload: { acknowledged: true },
    }).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
    return { ok: true, acknowledged: true };
  }

  let payload = req.body;
  try {
    const encoded = JSON.stringify(payload || {});
    if (encoded.length > 200000) payload = { truncated: true, id: payload?.id };
  } catch {
    payload = { id: req.body?.id };
  }

  try {
    await ShopifyWebhookEvent.create({
      company_id: connection.company_id,
      shop_domain: shop,
      shopify_id: webhookId,
      topic,
      status: "pending",
      payload,
    });
  } catch (error) {
    if (error?.code === 11000) return { ok: true, duplicate: true };
    throw error;
  }

  await enqueue(
    "process_webhook",
    {
      connectionId: String(connection._id),
      companyId: String(connection.company_id),
      topic,
      webhookId,
    },
    `webhook:${connection.company_id}:${webhookId}`,
  );
  return { ok: true };
}

async function scrubShop(shop) {
  const {
    ShopifyProduct,
    ShopifyOrder,
    ShopifyInventory,
    ShopifyLocation,
    ShopifyFulfillment,
    ShopifySyncLog,
    ShopifyWebhookEvent: Events,
  } = require("./models");
  const filter = { shop_domain: shop };
  await Promise.all([
    ShopifyProduct.deleteMany(filter),
    ShopifyOrder.deleteMany(filter),
    ShopifyInventory.deleteMany(filter),
    ShopifyLocation.deleteMany(filter),
    ShopifyFulfillment.deleteMany(filter),
    ShopifySyncLog.deleteMany(filter),
    Events.deleteMany(filter),
  ]);
}

module.exports = {
  registerWebhooks,
  receiveWebhook,
};

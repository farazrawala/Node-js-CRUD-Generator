/**
 * Official Shopify GraphQL Admin client for an offline OAuth token.
 * @module src/shopify/client
 */

require("@shopify/shopify-api/adapters/node");
const { shopifyApi, Session } = require("@shopify/shopify-api");
const { API_VERSION, installedScopes } = require("./constants");
const { decryptToken } = require("./tokenCrypto");
const { appCredentials } = require("./oauthToken");

let shopify;

function appUrl() {
  const raw = String(
    process.env.SHOPIFY_APP_URL || process.env.BASE_URL || "http://localhost:8000",
  ).trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return new URL(withProtocol);
}

function callbackUrl() {
  const explicit = String(process.env.SHOPIFY_OAUTH_CALLBACK_URL || "").trim();
  if (explicit) return explicit;
  const url = appUrl();
  const path = url.pathname.replace(/\/$/, "");
  const prefix = path.endsWith("/api") ? path : `${path}/api`;
  return `${url.origin}${prefix}/shopify/oauth/callback`;
}

function webhookUrl() {
  const explicit = String(process.env.SHOPIFY_WEBHOOK_URL || "").trim();
  if (explicit) return explicit;
  return callbackUrl().replace(/\/oauth\/callback$/, "/webhooks");
}

function frontendUrl() {
  const raw = String(
    process.env.ORDERS_HUB_APP_URL ||
      process.env.POS_FRONTEND_URL ||
      "http://localhost:5173",
  ).trim();
  return raw.replace(/\/$/, "");
}

function getShopify() {
  if (shopify) return shopify;
  const { clientId, clientSecret } = appCredentials();
  const url = appUrl();
  shopify = shopifyApi({
    apiKey: clientId,
    apiSecretKey: clientSecret,
    scopes: installedScopes(),
    hostName: url.hostname,
    hostScheme: url.protocol.replace(":", "") || "https",
    apiVersion: API_VERSION,
    isEmbeddedApp: false,
    isCustomStoreApp: false,
  });
  return shopify;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphqlRequest(client, query, variables, attempt = 0) {
  try {
    const result = await client.request(query, { variables });
    const errors = result?.errors;
    const list = Array.isArray(errors)
      ? errors
      : errors?.graphQLErrors || [];
    if (list.length) {
      const message = list.map((error) => error.message).join("; ");
      if (/throttl/i.test(message) && attempt < 5) {
        await sleep(1000 * (attempt + 1));
        return graphqlRequest(client, query, variables, attempt + 1);
      }
      const error = new Error(message);
      error.graphqlErrors = list;
      throw error;
    }
    return result?.data || result?.body?.data || null;
  } catch (error) {
    const status = error?.response?.code || error?.response?.statusCode;
    if ((status === 429 || /throttl/i.test(error?.message || "")) && attempt < 5) {
      await sleep(1000 * (attempt + 1));
      return graphqlRequest(client, query, variables, attempt + 1);
    }
    throw error;
  }
}

async function clientForToken(shop, accessToken) {
  const api = getShopify();
  const session = new Session({
    id: api.session.getOfflineId(shop),
    shop,
    state: "offline",
    isOnline: false,
    accessToken,
  });
  const graphql = new api.clients.Graphql({ session });
  return {
    shop,
    accessToken,
    graphql,
    request(query, options = {}) {
      return graphql.request(query, options);
    },
    async query(query, variables) {
      return graphqlRequest(graphql, query, variables);
    },
  };
}

async function clientForConnection(connection) {
  const token = decryptToken(connection?.access_token_enc);
  if (!token) {
    throw new Error("This Shopify store has no access token. Reconnect it.");
  }
  return clientForToken(connection.shop_domain, token);
}

module.exports = {
  API_VERSION,
  appUrl,
  callbackUrl,
  webhookUrl,
  frontendUrl,
  getShopify,
  clientForToken,
  clientForConnection,
  graphqlRequest,
};

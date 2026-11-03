/**
 * Shopify store connections for one OrdersHub company.
 * Access tokens stay encrypted and are omitted from API output.
 * @module src/shopify/connectionService
 */

const crypto = require("crypto");
const Integration = require("../../models/integration");
const { coalesceObjectId } = require("../../utils/modelHelper");
const {
  DEFAULT_SYNC_SETTINGS,
  INVENTORY_DIRECTIONS,
  installedScopes,
} = require("./constants");
const { normalizeShopDomain } = require("./shopDomain");
const { encryptToken, decryptToken } = require("./tokenCrypto");
const {
  appCredentials,
  exchangeAuthorizationCode,
  expiryFrom,
} = require("./oauthToken");
const {
  callbackUrl,
  getShopify,
  clientForConnection,
  clientForToken,
} = require("./client");
const {
  ShopifyConnection,
  ShopifyOauthState,
} = require("./models");
const { presentRecord } = require("./present");
const { assertSameCompany } = require("./tenancy");

const OAUTH_SECRET_PLACEHOLDER = "oauth-managed";

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sanitizeSettings(input = {}, current = {}) {
  const next = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(current || {}),
  };
  if (typeof input.product_sync_enabled === "boolean") {
    next.product_sync_enabled = input.product_sync_enabled;
  }
  if (INVENTORY_DIRECTIONS.includes(input.inventory_sync_direction)) {
    next.inventory_sync_direction = input.inventory_sync_direction;
  }
  if (typeof input.order_import_enabled === "boolean") {
    next.order_import_enabled = input.order_import_enabled;
  }
  if (typeof input.fulfillment_sync_enabled === "boolean") {
    next.fulfillment_sync_enabled = input.fulfillment_sync_enabled;
  }
  if (input.auto_sync_interval_minutes != null) {
    const minutes = Number(input.auto_sync_interval_minutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
      throw httpError(
        "Automatic synchronization interval must be between 0 and 1440 minutes.",
        400,
      );
    }
    next.auto_sync_interval_minutes = Math.round(minutes);
  }
  return next;
}

async function listConnections(companyId) {
  const rows = await ShopifyConnection.find({ company_id: companyId })
    .sort({ updated_at: -1 })
    .lean();
  return rows.map(presentRecord);
}

async function getConnection(companyId, id) {
  const connection = await ShopifyConnection.findOne({
    _id: id,
    company_id: companyId,
  }).select("+access_token_enc +refresh_token_enc");
  if (!connection) throw httpError("Shopify store was not found.", 404);
  assertSameCompany(connection, companyId);
  return connection;
}

async function beginConnect({ companyId, userId, shopInput }) {
  const shop = normalizeShopDomain(shopInput);
  if (!shop) {
    throw httpError(
      "Enter a Shopify store URL, for example mystore.myshopify.com.",
      400,
    );
  }
  const taken = await ShopifyConnection.findOne({
    shop_domain: shop,
    status: "connected",
    company_id: { $ne: companyId },
  })
    .select("_id")
    .lean();
  if (taken) {
    throw httpError(
      "This Shopify store is already connected to another OrdersHub company.",
      409,
    );
  }

  const { clientId } = appCredentials();
  const state = crypto.randomBytes(24).toString("hex");
  await ShopifyOauthState.create({
    company_id: companyId,
    shop_domain: shop,
    shopify_id: state,
    state,
    user_id: coalesceObjectId(userId) || undefined,
    expires_at: new Date(Date.now() + 15 * 60 * 1000),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    scope: installedScopes().join(","),
    redirect_uri: callbackUrl(),
    state,
  });
  getShopify().utils.sanitizeShop(shop, true);
  return {
    shop,
    authorizeUrl: `https://${shop}/admin/oauth/authorize?${params.toString()}`,
  };
}

async function upsertIntegration({
  companyId,
  userId,
  shop,
  shopName,
  tokenData,
}) {
  const token_expiry = expiryFrom(tokenData);
  const set = {
    store_type: "shopify",
    name: shopName || shop,
    url: shop,
    key: process.env.SHOPIFY_API_KEY,
    secret: OAUTH_SECRET_PLACEHOLDER,
    token: encryptToken(tokenData.access_token),
    refresh_token: tokenData.refresh_token
      ? encryptToken(tokenData.refresh_token)
      : "",
    token_expiry,
    auth_mode: "oauth",
    description: "Shopify OAuth connection",
    status: "active",
    deletedAt: null,
    updated_by: coalesceObjectId(userId) || undefined,
  };
  const existing = await Integration.findOne({
    company_id: companyId,
    store_type: "shopify",
    url: shop,
  });
  if (existing) {
    await Integration.updateOne({ _id: existing._id }, { $set: set });
    return existing._id;
  }
  const created = await Integration.create({
    ...set,
    company_id: companyId,
    created_by: coalesceObjectId(userId) || undefined,
  });
  return created._id;
}

async function completeCallback({ shop, code, state }) {
  const domain = normalizeShopDomain(shop);
  if (!domain) throw httpError("Shopify returned an invalid shop domain.", 400);

  const pending = await ShopifyOauthState.findOneAndDelete({
    state: String(state || ""),
    shop_domain: domain,
    expires_at: { $gt: new Date() },
  });
  if (!pending) {
    throw httpError("Shopify authorization expired. Start the connection again.", 400);
  }

  const taken = await ShopifyConnection.findOne({
    shop_domain: domain,
    status: "connected",
    company_id: { $ne: pending.company_id },
  })
    .select("_id")
    .lean();
  if (taken) {
    throw httpError(
      "This Shopify store is already connected to another OrdersHub company.",
      409,
    );
  }

  const tokenData = await exchangeAuthorizationCode(domain, code);
  const client = await clientForToken(domain, tokenData.access_token);
  let shopName = domain;
  let shopifyId = domain;
  try {
    const data = await client.query(`query ShopIdentity {
      shop { id name myshopifyDomain }
    }`);
    shopName = data?.shop?.name || domain;
    shopifyId = String(data?.shop?.id || domain);
  } catch (error) {
    console.warn("[shopify] shop identity lookup failed:", error?.message || error);
  }

  const integrationId = await upsertIntegration({
    companyId: pending.company_id,
    userId: pending.user_id,
    shop: domain,
    shopName,
    tokenData,
  });

  const scopes = String(tokenData.scope || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  let connection;
  try {
    connection = await ShopifyConnection.findOneAndUpdate(
    { company_id: pending.company_id, shop_domain: domain },
    {
      $set: {
        shopify_id: shopifyId,
        shop_name: shopName,
        integration_id: integrationId,
        status: "connected",
        granted_scopes: scopes.length ? scopes : installedScopes(),
        access_token_enc: encryptToken(tokenData.access_token),
        refresh_token_enc: tokenData.refresh_token
          ? encryptToken(tokenData.refresh_token)
          : "",
        token_expires_at: expiryFrom(tokenData),
        installed_by: pending.user_id || undefined,
        installed_at: new Date(),
        uninstalled_at: null,
        last_error: "",
      },
      $setOnInsert: {
        company_id: pending.company_id,
        shop_domain: domain,
        sync_settings: { ...DEFAULT_SYNC_SETTINGS },
      },
    },
    { upsert: true, new: true },
  );
  } catch (error) {
    if (error?.code === 11000) {
      throw httpError(
        "This Shopify store is already connected to another OrdersHub company.",
        409,
      );
    }
    throw error;
  }

  return connection;
}

async function disconnect(companyId, id) {
  const connection = await getConnection(companyId, id);
  const token = decryptToken(connection.access_token_enc);
  if (token && connection.status === "connected") {
    try {
      await fetch(
        `https://${connection.shop_domain}/admin/api_permissions/current.json`,
        {
          method: "DELETE",
          headers: { "X-Shopify-Access-Token": token },
        },
      );
    } catch (error) {
      console.warn("[shopify] token revoke failed:", error?.message || error);
    }
  }
  connection.status = "disconnected";
  connection.access_token_enc = "";
  connection.refresh_token_enc = "";
  connection.token_expires_at = null;
  connection.uninstalled_at = new Date();
  await connection.save();
  if (connection.integration_id) {
    await Integration.updateOne(
      { _id: connection.integration_id, company_id: companyId },
      {
        $set: {
          status: "inactive",
          token: "",
          refresh_token: "",
          token_expiry: null,
        },
      },
    );
  }
  return presentRecord(connection);
}

async function markUninstalled(shopDomain) {
  const shop = normalizeShopDomain(shopDomain);
  if (!shop) return null;
  const connection = await ShopifyConnection.findOne({
    shop_domain: shop,
    status: "connected",
  }).select("+access_token_enc +refresh_token_enc");
  if (!connection) return null;
  connection.status = "uninstalled";
  connection.access_token_enc = "";
  connection.refresh_token_enc = "";
  connection.uninstalled_at = new Date();
  connection.last_error = "App uninstalled in Shopify.";
  await connection.save();
  if (connection.integration_id) {
    await Integration.updateOne(
      { _id: connection.integration_id, company_id: connection.company_id },
      { $set: { status: "inactive", token: "", refresh_token: "" } },
    );
  }
  return connection;
}

async function updateSettings(companyId, id, input) {
  const connection = await getConnection(companyId, id);
  connection.sync_settings = sanitizeSettings(
    input,
    connection.sync_settings?.toObject?.() || connection.sync_settings,
  );
  await connection.save();
  return presentRecord(connection);
}

async function loadActiveConnection(companyId, id) {
  const connection = await getConnection(companyId, id);
  if (connection.status !== "connected") {
    throw httpError("Reconnect this Shopify store before synchronizing.", 409);
  }
  return connection;
}

async function adminClient(connection) {
  assertSameCompany(connection, connection.company_id);
  return clientForConnection(connection);
}

module.exports = {
  sanitizeSettings,
  listConnections,
  getConnection,
  beginConnect,
  completeCallback,
  disconnect,
  markUninstalled,
  updateSettings,
  loadActiveConnection,
  adminClient,
  presentRecord,
};

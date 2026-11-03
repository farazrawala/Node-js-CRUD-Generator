/**
 * Offline OAuth tokens. Decrypts for in-memory Admin API calls and refreshes
 * expiring offline tokens. Plaintext is never written back to MongoDB.
 * @module src/shopify/oauthToken
 */

const Integration = require("../../models/integration");
const { decryptToken, encryptToken } = require("./tokenCrypto");

const REFRESH_SKEW_MS = 2 * 60 * 1000;

function isOauthIntegration(integration) {
  if (!integration) return false;
  if (integration.auth_mode === "oauth") return true;
  const token = String(integration.token || "");
  return token.startsWith("enc:v1:") && integration.secret === "oauth-managed";
}

function appCredentials() {
  const clientId = String(process.env.SHOPIFY_API_KEY || "").trim();
  const clientSecret = String(process.env.SHOPIFY_API_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET.");
  }
  return { clientId, clientSecret };
}

async function postToken(shop, body) {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw };
  }
  if (!response.ok || !data.access_token) {
    const error = new Error(
      data.error_description ||
        data.error ||
        `Shopify token request failed (HTTP ${response.status}).`,
    );
    error.status = response.status === 401 ? 401 : 502;
    throw error;
  }
  return data;
}

async function exchangeAuthorizationCode(shop, code) {
  const { clientId, clientSecret } = appCredentials();
  return postToken(shop, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
}

function expiryFrom(data) {
  const seconds = Number(data?.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Date.now() + seconds * 1000);
}

async function persistRefreshedToken(integrationId, data) {
  if (!integrationId) return;
  const token_expiry = expiryFrom(data);
  await Integration.findByIdAndUpdate(integrationId, {
    $set: {
      token: encryptToken(data.access_token),
      ...(data.refresh_token
        ? { refresh_token: encryptToken(data.refresh_token) }
        : {}),
      token_expiry,
      auth_mode: "oauth",
    },
  });
}

/**
 * Return a plaintext access token for an OAuth integration.
 * Refreshes when Shopify issued an expiring offline token.
 */
async function resolveOauthAccessToken(integration, integrationId = null) {
  const shop = String(integration?.url || "")
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();
  let accessToken = decryptToken(integration?.token);
  let refreshToken = decryptToken(integration?.refresh_token);
  const expiresAt = integration?.token_expiry
    ? new Date(integration.token_expiry).getTime()
    : null;
  const id = integrationId || integration?._id || null;

  if (
    refreshToken &&
    expiresAt &&
    expiresAt - Date.now() < REFRESH_SKEW_MS
  ) {
    const { clientId, clientSecret } = appCredentials();
    const data = await postToken(shop, {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
    accessToken = data.access_token;
    refreshToken = data.refresh_token || refreshToken;
    await persistRefreshedToken(id, data);
  }

  if (!accessToken) {
    throw new Error("Shopify OAuth token is missing. Reconnect the store.");
  }

  return {
    access_token: accessToken,
    scope: (integration?.granted_scopes || []).join(",") || null,
    expires_in: null,
    token_expiry: integration?.token_expiry || null,
    integration: {
      ...integration,
      token: accessToken,
      refresh_token: refreshToken,
      auth_mode: "oauth",
    },
  };
}

module.exports = {
  isOauthIntegration,
  appCredentials,
  exchangeAuthorizationCode,
  expiryFrom,
  resolveOauthAccessToken,
};

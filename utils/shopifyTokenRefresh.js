const Integration = require("../models/integration");

function normalizeShopifyDomain(rawUrl) {
  let shopDomain = String(rawUrl || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");

  if (!shopDomain) return null;

  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
      shopDomain = `${shopDomain}.myshopify.com`;
    } else {
      return null;
    }
  }

  return shopDomain.toLowerCase();
}

function shopifyErrorText(error) {
  const body = error?.response?.body ?? error?.response?.data ?? null;
  const parts = [];

  if (body?.errors != null) {
    parts.push(
      typeof body.errors === "string" ?
        body.errors
      : JSON.stringify(body.errors),
    );
  } else if (typeof body === "string" && body.trim()) {
    parts.push(body);
  } else if (body && typeof body === "object") {
    try {
      parts.push(JSON.stringify(body));
    } catch {
      parts.push(String(body));
    }
  }

  if (error?.message) parts.push(error.message);
  return parts.join(" | ");
}

function isShopifyAuthError(error) {
  const status =
    error?.response?.code ??
    error?.response?.statusCode ??
    error?.statusCode ??
    error?.status ??
    null;

  if (status === 401 || status === 403) return true;

  const text = shopifyErrorText(error);
  return /invalid api key|access token|unrecognized login|wrong password|unauthorized|authentication|expired.*token|token.*expired/i.test(
    text,
  );
}

function formatShopifyErrorPayload(error, fallback = "Shopify request failed") {
  const text = shopifyErrorText(error);
  return text || fallback;
}

function resolveShopifyClientCredentials(integration) {
  const clientId =
    integration?.key || integration?.api_key || integration?.public_key;
  const clientSecret =
    integration?.secret ||
    integration?.secret_key ||
    integration?.private_key ||
    integration?.client_secret;
  return { clientId, clientSecret };
}

/**
 * Request a new Admin API access token via Shopify client credentials grant.
 * Updates integration.token in MongoDB when integrationId is provided.
 */
async function refreshShopifyAccessToken(integration, integrationId = null) {
  const shopDomain = normalizeShopifyDomain(integration?.url);
  const { clientId, clientSecret } =
    resolveShopifyClientCredentials(integration);

  if (!shopDomain) {
    throw new Error("Shopify store URL is missing or invalid for token refresh.");
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      "Shopify client_id (key) and client_secret (secret) are required for token refresh.",
    );
  }

  const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
  const formBody = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: String(clientId),
    client_secret: String(clientSecret),
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody.toString(),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { raw };
  }

  if (!response.ok) {
    throw new Error(
      `Shopify token refresh failed (HTTP ${response.status}): ${raw || response.statusText}`,
    );
  }

  const accessToken = data.access_token;
  if (!accessToken) {
    throw new Error("Shopify token refresh returned no access_token.");
  }

  const id = integrationId || integration?._id || integration?.id;
  if (id) {
    const updated = await Integration.findByIdAndUpdate(
      id,
      { $set: { token: accessToken } },
      { new: true },
    ).select("_id token");
    if (!updated) {
      throw new Error(
        `Shopify token refresh succeeded but integration ${id} was not found to update.`,
      );
    }
  }

  return {
    access_token: accessToken,
    scope: data.scope || null,
    expires_in: data.expires_in || null,
  };
}

module.exports = {
  normalizeShopifyDomain,
  isShopifyAuthError,
  formatShopifyErrorPayload,
  resolveShopifyClientCredentials,
  refreshShopifyAccessToken,
};

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

function trimCredential(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function resolveShopifyClientCredentials(integration) {
  const clientId = trimCredential(
    integration?.key || integration?.api_key || integration?.public_key,
  );
  const clientSecret = trimCredential(
    integration?.secret ||
      integration?.secret_key ||
      integration?.private_key ||
      integration?.client_secret,
  );
  const accessToken = trimCredential(
    integration?.token || integration?.access_token || integration?.password,
  );
  return { clientId, clientSecret, accessToken };
}

/**
 * Prefer a fresh Mongo document so refresh never uses a stale/partial populate.
 */
async function loadFreshShopifyIntegration(integration, integrationId = null) {
  const id =
    integrationId ||
    integration?._id ||
    integration?.id ||
    null;

  let doc = null;
  if (id) {
    doc = await Integration.findById(id).lean();
  }

  if (!doc && integration) {
    doc =
      typeof integration.toObject === "function" ?
        integration.toObject()
      : { ...integration };
  }

  if (!doc) return null;

  const { clientId, clientSecret, accessToken } =
    resolveShopifyClientCredentials(doc);

  return {
    ...doc,
    key: clientId || doc.key,
    secret: clientSecret || doc.secret,
    token: accessToken || doc.token || null,
    _resolved: { clientId, clientSecret, accessToken },
  };
}

function describeCredentialShape(value) {
  if (!value) return "missing";
  const text = String(value);
  if (/^shpat_/i.test(text)) return "looks_like_admin_access_token(shpat_)";
  if (/^shpca_/i.test(text)) return "looks_like_custom_app_token(shpca_)";
  if (/^shpss_/i.test(text)) return "looks_like_api_secret(shpss_)";
  if (/^[0-9a-f]{32}$/i.test(text)) return "looks_like_api_key_hex";
  return `opaque(len=${text.length})`;
}

async function postShopifyTokenRequest(shopDomain, clientId, clientSecret) {
  const tokenUrl = `https://${shopDomain}/admin/oauth/access_token`;
  const attempts = [
    {
      label: "form-urlencoded",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: String(clientId),
        client_secret: String(clientSecret),
      }).toString(),
    },
    {
      label: "json",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: String(clientId),
        client_secret: String(clientSecret),
      }),
    },
  ];

  let lastFailure = null;

  for (const attempt of attempts) {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: attempt.headers,
      body: attempt.body,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      data = { raw };
    }

    if (response.ok && data.access_token) {
      return { data, raw, contentType: attempt.label };
    }

    lastFailure = {
      status: response.status,
      raw: raw || response.statusText,
      contentType: attempt.label,
      data,
    };

    // Retry alternate encoding only for request-format style failures.
    const desc = String(data?.error_description || data?.error || raw || "");
    if (
      response.status === 400 &&
      /missing or invalid client secret|invalid_request/i.test(desc) &&
      attempt.label === "form-urlencoded"
    ) {
      continue;
    }
    break;
  }

  return { error: lastFailure };
}

/**
 * Request a new Admin API access token via Shopify client credentials grant.
 * Updates integration.token in MongoDB when integrationId is provided.
 */
async function refreshShopifyAccessToken(integration, integrationId = null) {
  const fresh = await loadFreshShopifyIntegration(integration, integrationId);
  const shopDomain = normalizeShopifyDomain(fresh?.url);
  const { clientId, clientSecret } = resolveShopifyClientCredentials(fresh);

  if (!shopDomain) {
    throw new Error("Shopify store URL is missing or invalid for token refresh.");
  }
  if (!clientId || !clientSecret) {
    throw new Error(
      "Shopify client_id (integration.key) and client_secret (integration.secret) are required for token refresh. Update them from Shopify Dev Dashboard → Settings (or Develop apps → API credentials).",
    );
  }

  // Access tokens must never be sent as client_secret.
  if (/^shpat_|^shpca_/i.test(clientSecret)) {
    throw new Error(
      "integration.secret looks like an Admin API access token. Put the Client Secret / API secret key in `secret`, and the Admin API access token in `token`.",
    );
  }

  const result = await postShopifyTokenRequest(
    shopDomain,
    clientId,
    clientSecret,
  );

  if (result.error) {
    const desc = String(
      result.error.data?.error_description ||
        result.error.data?.error ||
        result.error.raw ||
        "",
    );
    const hint =
      /missing or invalid client secret|invalid_client/i.test(desc) ?
        ` Check Admin → Integration: key=${describeCredentialShape(clientId)}, secret=${describeCredentialShape(clientSecret)}. Use Client ID in key and Client Secret (often shpss_…) in secret from Shopify Dev Dashboard / custom app API credentials — not the Admin API access token.`
      : /shop_not_permitted|client credentials/i.test(desc) ?
        " This shop may not allow client-credentials refresh (legacy custom apps often use a static Admin API token). Paste a fresh Admin API access token into integration.token instead."
      : "";

    throw new Error(
      `Shopify token refresh failed (HTTP ${result.error.status}): ${result.error.raw || result.error.status}${hint}`,
    );
  }

  const accessToken = result.data.access_token;
  if (!accessToken) {
    throw new Error("Shopify token refresh returned no access_token.");
  }

  const id = integrationId || fresh?._id || fresh?.id;
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
    scope: result.data.scope || null,
    expires_in: result.data.expires_in || null,
    integration: {
      ...fresh,
      token: accessToken,
    },
  };
}

module.exports = {
  normalizeShopifyDomain,
  isShopifyAuthError,
  formatShopifyErrorPayload,
  resolveShopifyClientCredentials,
  loadFreshShopifyIntegration,
  refreshShopifyAccessToken,
};

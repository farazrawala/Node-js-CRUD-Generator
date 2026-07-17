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

function isShopifyAccessToken(value) {
  return /^shpat_|^shpca_/i.test(String(value || ""));
}

function isShopifyClientSecret(value) {
  const text = String(value || "");
  if (!text) return false;
  if (isShopifyAccessToken(text)) return false;
  // API secret key from custom apps / Dev Dashboard
  if (/^shpss_/i.test(text)) return true;
  // Opaque secrets are still valid client secrets
  return true;
}

/**
 * Normalize integration credentials, including a common misconfig:
 * Admin API access token stored in `secret` instead of `token`.
 */
function resolveShopifyClientCredentials(integration) {
  const clientId = trimCredential(
    integration?.key || integration?.api_key || integration?.public_key,
  );

  const rawSecret = trimCredential(
    integration?.secret ||
      integration?.secret_key ||
      integration?.private_key ||
      integration?.client_secret,
  );
  const rawToken = trimCredential(
    integration?.token || integration?.access_token || integration?.password,
  );

  let accessToken = rawToken;
  let clientSecret = rawSecret;
  let secretHeldAccessToken = false;

  // Misfiled: secret is actually the Admin API access token.
  if (isShopifyAccessToken(rawSecret)) {
    secretHeldAccessToken = true;
    if (!accessToken || !isShopifyAccessToken(accessToken)) {
      accessToken = rawSecret;
    }
    clientSecret = null;
  } else if (rawSecret && !isShopifyClientSecret(rawSecret)) {
    clientSecret = null;
  }

  // Token field sometimes holds the API secret by mistake.
  if (accessToken && /^shpss_/i.test(accessToken) && !clientSecret) {
    clientSecret = accessToken;
    accessToken = isShopifyAccessToken(rawSecret) ? rawSecret : null;
  }

  return {
    clientId,
    clientSecret,
    accessToken,
    secretHeldAccessToken,
    canRefreshWithClientCredentials: Boolean(clientId && clientSecret),
  };
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

  const resolved = resolveShopifyClientCredentials(doc);

  return {
    ...doc,
    key: resolved.clientId || doc.key,
    // Keep original secret in doc for reference; resolved secret is the real client secret.
    secret: resolved.clientSecret || (resolved.secretHeldAccessToken ? null : doc.secret),
    token: resolved.accessToken || doc.token || null,
    _resolved: resolved,
  };
}

/**
 * If access token was stored under `secret`, copy it into `token` once.
 */
/** Shopify client-credentials tokens are treated as valid for 12 hours from issue/repair. */
function buildShopifyTokenExpiry(fromDate = new Date()) {
  return new Date(fromDate.getTime() + 12 * 60 * 60 * 1000);
}

async function repairMisfiledShopifyAccessToken(integrationId, accessToken) {
  if (!integrationId || !accessToken) return false;
  const token_expiry = buildShopifyTokenExpiry();
  const updated = await Integration.findByIdAndUpdate(
    integrationId,
    { $set: { token: accessToken, token_expiry } },
    { new: true },
  ).select("_id token token_expiry");
  return Boolean(updated);
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
 *
 * If `secret` holds an access token (common misconfig), copies it to `token`
 * and returns that instead of calling client-credentials.
 */
async function refreshShopifyAccessToken(integration, integrationId = null) {
  const fresh = await loadFreshShopifyIntegration(integration, integrationId);
  const shopDomain = normalizeShopifyDomain(fresh?.url);
  const resolved =
    fresh?._resolved || resolveShopifyClientCredentials(fresh);
  const id = integrationId || fresh?._id || fresh?.id;

  if (!shopDomain) {
    throw new Error("Shopify store URL is missing or invalid for token refresh.");
  }

  // Recover from misfiled Admin API token in `secret`.
  if (resolved.secretHeldAccessToken && resolved.accessToken) {
    const token_expiry = buildShopifyTokenExpiry();
    if (id) {
      await repairMisfiledShopifyAccessToken(id, resolved.accessToken);
      console.warn(
        `Shopify integration ${id}: moved Admin API access token from secret → token.`,
      );
    }
    return {
      access_token: resolved.accessToken,
      scope: null,
      expires_in: null,
      token_expiry,
      repaired_from_secret: true,
      integration: {
        ...fresh,
        token: resolved.accessToken,
        token_expiry,
      },
    };
  }

  const { clientId, clientSecret, accessToken } = resolved;

  if (!clientId || !clientSecret) {
    if (accessToken) {
      throw new Error(
        "Shopify Admin API token is present but client-credentials refresh is unavailable (integration.secret is missing or is not a Client Secret). For legacy custom apps, paste a fresh Admin API access token into integration.token. For Dev Dashboard apps, put Client ID in key and Client Secret (shpss_…) in secret.",
      );
    }
    throw new Error(
      "Shopify client_id (integration.key) and client_secret (integration.secret) are required for token refresh. Update them from Shopify Dev Dashboard → Settings (or Develop apps → API credentials).",
    );
  }

  if (isShopifyAccessToken(clientSecret)) {
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
        ` Check Admin → Integration: key=${describeCredentialShape(clientId)}, secret=${describeCredentialShape(clientSecret)}. Use Client ID in key and Client Secret (often shpss_…) in secret — not the Admin API access token.`
      : /shop_not_permitted|client credentials/i.test(desc) ?
        " This shop may not allow client-credentials refresh (legacy custom apps often use a static Admin API token). Paste a fresh Admin API access token into integration.token instead."
      : "";

    throw new Error(
      `Shopify token refresh failed (HTTP ${result.error.status}): ${result.error.raw || result.error.status}${hint}`,
    );
  }

  const newAccessToken = result.data.access_token;
  if (!newAccessToken) {
    throw new Error("Shopify token refresh returned no access_token.");
  }

  const token_expiry = buildShopifyTokenExpiry();

  if (id) {
    const updated = await Integration.findByIdAndUpdate(
      id,
      { $set: { token: newAccessToken, token_expiry } },
      { new: true },
    ).select("_id token token_expiry");
    if (!updated) {
      throw new Error(
        `Shopify token refresh succeeded but integration ${id} was not found to update.`,
      );
    }
  }

  return {
    access_token: newAccessToken,
    scope: result.data.scope || null,
    expires_in: result.data.expires_in || null,
    token_expiry,
    integration: {
      ...fresh,
      token: newAccessToken,
      token_expiry,
    },
  };
}

module.exports = {
  normalizeShopifyDomain,
  isShopifyAuthError,
  formatShopifyErrorPayload,
  isShopifyAccessToken,
  resolveShopifyClientCredentials,
  loadFreshShopifyIntegration,
  repairMisfiledShopifyAccessToken,
  refreshShopifyAccessToken,
  buildShopifyTokenExpiry,
};

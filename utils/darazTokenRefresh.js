const crypto = require("crypto");
const Integration = require("../models/integration");

/** Pakistan Daraz Open Platform only. Do not use other country gateways. */
const DARAZ_PK_REST_BASE = "https://api.daraz.pk/rest";
const DARAZ_PK_AUTHORIZE_BASE = "https://api.daraz.pk/oauth/authorize";
const DARAZ_SIGN_METHOD = "sha256";

/**
 * Must match the Callback URL saved on the Daraz Open Platform app.
 * After login Daraz appends &code=4_506036_… (not 0_…).
 * https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz
 */
const DARAZ_PK_DEFAULT_CALLBACK =
  String(process.env.DARAZ_PK_REDIRECT_URI || "").trim() ||
  "https://testv3.websitedemolynk.com/pos_webhook/webhook.php?callback=daraz";

const CREATE_TOKEN_PATH = "/auth/token/create";
const REFRESH_TOKEN_PATH = "/auth/token/refresh";

/** Daraz PK refresh_token is treated as valid for 24 hours from generate/refresh. */
const DARAZ_REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function trimCredential(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function maskToken(value) {
  const text = trimCredential(value);
  if (!text) return null;
  if (text.length <= 8) return "[set]";
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

/**
 * Live PK codes look like 4_506036_…. Docs examples use 0_….
 * Shape is {digits}_{appKey_or_token}[_more].
 */
const DARAZ_AUTH_CODE_RE = /^\d+_[A-Za-z0-9._-]+$/;

const DARAZ_MISSING_SELLER_CODE_MESSAGE =
  "Click Generate Token, authorize on Daraz Pakistan, then paste the seller code from the webhook email or callback URL (code=4_506036_... or code=0_...).";

const DARAZ_CALLBACK_WITHOUT_CODE_MESSAGE =
  "That is your Daraz webhook URL, not a seller code. Click Generate Token, sign in on Daraz, then paste the callback URL or email that contains code=4_... (not webhook.php?hello=test).";

function looksLikeDarazAuthCode(value) {
  return Boolean(extractDarazSellerCode(value));
}

function takeDarazAuthCode(value) {
  const text = trimCredential(value);
  if (!text) return null;
  const token = text.split(/[\s&#?"'<>]/)[0];
  return DARAZ_AUTH_CODE_RE.test(token) ? token : null;
}

/**
 * Pull a Daraz seller code (`4_506036_…` or `0_…`) from Token, a callback URL, or `?code=`.
 */
function extractDarazSellerCode(value) {
  const text = trimCredential(value);
  if (!text) return null;

  const asCode = takeDarazAuthCode(text);
  if (asCode) return asCode;

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const qs =
        parsed?.captured?.query_string ||
        parsed?.query_string ||
        parsed?.captured?.query ||
        null;
      if (qs) {
        return extractDarazSellerCode(
          String(qs).includes("=") && !String(qs).includes("://")
            ? `https://callback.local/?${qs}`
            : qs,
        );
      }
      const nested =
        parsed?.code ||
        parsed?.get?.code ||
        parsed?.captured?.code ||
        parsed?.captured?.get?.code ||
        parsed?.data?.code ||
        null;
      if (nested) return extractDarazSellerCode(nested);
    } catch (_) {
      /* not JSON */
    }
  }

  try {
    if (text.includes("://") || text.startsWith("http")) {
      const url = new URL(text);
      const fromQuery = takeDarazAuthCode(url.searchParams.get("code"));
      if (fromQuery) return fromQuery;
    }
  } catch (_) {
    /* not a URL */
  }

  const queryMatch = text.match(/[?&]code=(\d+_[A-Za-z0-9._-]+)/i);
  if (queryMatch) return queryMatch[1];

  const embedded = text.match(/(?:^|[^A-Za-z0-9])(\d+_[A-Za-z0-9._-]+)/);
  if (embedded) return embedded[1];

  if (/^[^=&]*&?[^=]+=/.test(text) && /code=/i.test(text)) {
    return extractDarazSellerCode(`https://callback.local/?${text}`);
  }

  return null;
}

function isDarazCallbackUrlWithoutCode(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (extractDarazSellerCode(text)) return false;
  return /webhook\.php|pos_webhook|callback/i.test(text);
}

/**
 * Resolve first-time generate vs later refresh from POS "Refresh token".
 * A seller code pasted into Token (4_… / 0_…) always generates, even if a
 * refresh_token is already stored.
 */
function resolveDarazTokenAction({
  code,
  refreshToken,
  storedRefreshToken,
  storedAccessToken,
} = {}) {
  const explicitCode = extractDarazSellerCode(code);
  if (explicitCode) {
    return { action: "create", code: explicitCode };
  }

  const tokenAsCode = extractDarazSellerCode(storedAccessToken);
  if (tokenAsCode) {
    return { action: "create", code: tokenAsCode };
  }

  const storedToken = trimCredential(storedAccessToken);

  const explicitRefresh =
    trimCredential(refreshToken) || trimCredential(storedRefreshToken);
  if (explicitRefresh) {
    return { action: "refresh", refreshToken: explicitRefresh };
  }

  if (storedToken) {
    return { action: "refresh", refreshToken: storedToken };
  }

  return { action: "missing", message: DARAZ_MISSING_SELLER_CODE_MESSAGE };
}

function expiryFromSeconds(expiresIn, fromDate = new Date()) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(fromDate.getTime() + seconds * 1000);
}

function buildDarazRefreshTokenExpiry(fromDate = new Date()) {
  return new Date(fromDate.getTime() + DARAZ_REFRESH_TOKEN_TTL_MS);
}

/**
 * HMAC-SHA256 sign for Daraz/Lazada REST.
 * Sort params by ASCII name, concatenate name+value, prepend API path,
 * HMAC-SHA256 with app secret, uppercase hex.
 *
 * Official algorithm:
 * https://open.daraz.com/doc/api.htm
 */
function signDarazRequest(apiPath, params, appSecret) {
  const path = String(apiPath || "");
  const secret = String(appSecret || "");
  const pairs = Object.keys(params || {})
    .filter(
      (key) => key !== "sign" && params[key] != null && params[key] !== "",
    )
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");

  return crypto
    .createHmac("sha256", secret)
    .update(`${path}${pairs}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

function buildDarazAuthorizeUrl({
  appKey,
  redirectUri,
  state,
  forceAuth = true,
}) {
  const clientId = trimCredential(appKey);
  const callback = trimCredential(redirectUri);
  if (!clientId || !callback) {
    throw new Error(
      "app_key and redirect_uri are required to build the Daraz PK authorize URL.",
    );
  }

  const query = new URLSearchParams({
    response_type: "code",
    redirect_uri: callback,
    client_id: clientId,
  });
  if (forceAuth) query.set("force_auth", "true");
  if (state) query.set("state", String(state));

  return `${DARAZ_PK_AUTHORIZE_BASE}?${query.toString()}`;
}

function compactDarazParams(params) {
  return Object.fromEntries(
    Object.entries(params || {}).filter(
      ([, value]) => value != null && String(value).trim() !== "",
    ),
  );
}

/**
 * Official Open Platform methodType: `/…/get` and trace are GET.
 * Token, create, update, pack, RTS, cancel, image migrate are POST.
 * https://open.daraz.com/doc/api.htm
 */
function darazHttpMethod(apiPath) {
  const path = String(apiPath || "").toLowerCase();
  if (path.startsWith("/auth/token/")) return "POST";
  if (path.endsWith("/get") || path.includes("/trace")) return "GET";
  return "POST";
}

function buildDarazRequest({
  apiPath,
  appKey,
  appSecret,
  apiParams = {},
  timestamp,
  httpMethod,
}) {
  const path = String(apiPath || "");
  const key = trimCredential(appKey);
  const secret = trimCredential(appSecret);

  if (!path.startsWith("/")) {
    throw new Error("Daraz API path must start with '/'.");
  }
  if (!key || !secret) {
    throw new Error(
      "Daraz app_key (integration.key) and app_secret (integration.secret) are required.",
    );
  }

  const method = String(httpMethod || darazHttpMethod(path)).toUpperCase();
  const ts = timestamp == null ? String(Date.now()) : String(timestamp);
  const merged = compactDarazParams({
    app_key: key,
    timestamp: ts,
    sign_method: DARAZ_SIGN_METHOD,
    ...apiParams,
  });

  const sign = signDarazRequest(path, merged, secret);
  const sysParams = {
    app_key: key,
    timestamp: ts,
    sign_method: DARAZ_SIGN_METHOD,
    sign,
  };

  if (method === "GET") {
    const query = new URLSearchParams({ ...merged, sign });
    return {
      url: `${DARAZ_PK_REST_BASE}${path}?${query.toString()}`,
      body: "",
      method: "GET",
      sign,
      sysParams,
      apiParams,
      apiPath: path,
    };
  }

  const bodyParams = compactDarazParams(
    Object.fromEntries(
      Object.entries(apiParams || {}).filter(([key]) => key !== "access_token"),
    ),
  );
  const queryParams = { ...sysParams };
  const accessToken = trimCredential(apiParams?.access_token);
  if (accessToken) queryParams.access_token = accessToken;
  const body = new URLSearchParams(bodyParams).toString();
  return {
    url: `${DARAZ_PK_REST_BASE}${path}?${new URLSearchParams(queryParams).toString()}`,
    body,
    method: "POST",
    sign,
    sysParams,
    apiParams,
    apiPath: path,
  };
}

function collectDarazErrorDetails(value, acc = []) {
  if (value == null) return acc;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) acc.push(text);
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDarazErrorDetails(item, acc));
    return acc;
  }
  if (typeof value === "object") {
    const field = value.field || value.Field || value.attribute || value.name;
    const message =
      value.message ||
      value.Message ||
      value.msg ||
      value.error ||
      value.detail;
    if (field && message) {
      acc.push(`${field}: ${message}`);
    } else if (message && typeof message !== "object") {
      acc.push(String(message));
    }
    for (const key of ["detail", "details", "errors", "Errors", "sub_msg", "sub_message"]) {
      if (value[key] != null && value[key] !== message) {
        collectDarazErrorDetails(value[key], acc);
      }
    }
  }
  return acc;
}

function darazErrorText(payload, fallback = "Daraz request failed") {
  if (!payload) return fallback;
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  const code = payload.code || payload.type || null;
  const message = payload.message || payload.msg || payload.error || null;
  const requestId = payload.request_id || payload._trace_id_ || null;
  const parts = [];
  if (code) parts.push(String(code));
  if (message) parts.push(String(message));
  const details = [
    ...collectDarazErrorDetails(payload.detail),
    ...collectDarazErrorDetails(payload.details),
    ...collectDarazErrorDetails(payload.data),
  ].filter((item, index, all) => item && all.indexOf(item) === index && item !== String(message || ""));
  if (details.length) parts.push(details.join("; "));
  if (String(code) === "4139") {
    parts.push(
      "Main image is required — product images must be migrated to Daraz CDN first",
    );
  }
  if (requestId) parts.push(`request_id=${requestId}`);
  return parts.length ? parts.join(": ") : fallback;
}

function isDarazSuccess(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.access_token) return true;
  const code = String(payload.code || "").toLowerCase();
  return code === "0" || code === "success";
}

async function callDarazRest({
  apiPath,
  appKey,
  appSecret,
  apiParams = {},
  timestamp,
  fetchImpl = fetch,
}) {
  const request = buildDarazRequest({
    apiPath,
    appKey,
    appSecret,
    apiParams,
    timestamp,
  });

  const headers = { Accept: "application/json" };
  const fetchOptions = { method: request.method || "POST", headers };
  if (request.method !== "GET") {
    headers["Content-Type"] =
      "application/x-www-form-urlencoded;charset=utf-8";
    fetchOptions.body = request.body;
  }

  const response = await fetchImpl(request.url, fetchOptions);

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { raw };
  }

  if (!response.ok || !isDarazSuccess(data)) {
    const status = response.status;
    console.error(
      `[daraz] ${apiPath} failed HTTP ${status}:`,
      String(raw || "").slice(0, 2000),
    );
    throw new Error(
      `Daraz ${apiPath} failed (HTTP ${status}): ${darazErrorText(data, raw || response.statusText)}`,
    );
  }

  return { data, raw, request };
}

function mimeFromFilename(filename) {
  const ext = String(filename || "")
    .toLowerCase()
    .split(".")
    .pop();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

async function callDarazImageUpload({
  appKey,
  appSecret,
  accessToken,
  fileBuffer,
  filename = "product.jpg",
  fetchImpl = fetch,
}) {
  const apiPath = "/image/upload";
  const key = trimCredential(appKey);
  const secret = trimCredential(appSecret);
  const token = trimCredential(accessToken);
  if (!key || !secret || !token) {
    throw new Error("Daraz image upload requires app_key, app_secret, and access_token.");
  }
  const ts = String(Date.now());
  const merged = compactDarazParams({
    app_key: key,
    timestamp: ts,
    sign_method: DARAZ_SIGN_METHOD,
    access_token: token,
  });
  const sign = signDarazRequest(apiPath, merged, secret);
  const url = `${DARAZ_PK_REST_BASE}${apiPath}?${new URLSearchParams({
    ...merged,
    sign,
  }).toString()}`;

  const form = new FormData();
  const bytes =
    fileBuffer instanceof Uint8Array ? fileBuffer : Buffer.from(fileBuffer);
  const type = mimeFromFilename(filename);
  const blob =
    typeof File === "function"
      ? new File([bytes], filename, { type })
      : new Blob([bytes], { type });
  form.append("image", blob, filename);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { raw };
  }
  if (!response.ok || !isDarazSuccess(data)) {
    console.error(
      `[daraz] ${apiPath} failed HTTP ${response.status}:`,
      String(raw || "").slice(0, 2000),
    );
    throw new Error(
      `Daraz ${apiPath} failed (HTTP ${response.status}): ${darazErrorText(data, raw || response.statusText)}`,
    );
  }
  return darazResultData({ data, raw });
}

/** Business APIs return `{ code: "0", data: { ... } }`. */
function darazResultData(result) {
  const payload = result?.data;
  if (payload && typeof payload === "object" && payload.data != null) {
    return payload.data;
  }
  return payload || {};
}

function tokenPatchFromDarazPayload(payload, fromDate = new Date()) {
  const accessToken = trimCredential(payload?.access_token);
  const refreshToken = trimCredential(payload?.refresh_token);
  if (!accessToken) {
    throw new Error("Daraz token response did not include access_token.");
  }

  const patch = {
    token: accessToken,
    token_expiry: expiryFromSeconds(payload.expires_in, fromDate),
  };

  if (refreshToken) {
    patch.refresh_token = refreshToken;
    patch.refresh_token_expiry = buildDarazRefreshTokenExpiry(fromDate);
  }

  return patch;
}

async function persistDarazTokens(integrationId, payload) {
  if (!integrationId) return null;
  const patch = tokenPatchFromDarazPayload(payload);
  const updated = await Integration.findByIdAndUpdate(
    integrationId,
    { $set: patch },
    { new: true },
  ).select("_id token token_expiry refresh_token refresh_token_expiry");

  if (!updated) {
    throw new Error(
      `Daraz token request succeeded but integration ${integrationId} was not found to update.`,
    );
  }

  return { patch, integration: updated };
}

function publicTokenResult(payload, integrationId = null) {
  return {
    integration_id: integrationId ? String(integrationId) : null,
    country: "pk",
    gateway: DARAZ_PK_REST_BASE,
    access_token_masked: maskToken(payload.access_token),
    refresh_token_masked: maskToken(payload.refresh_token),
    expires_in: payload.expires_in ?? null,
    refresh_expires_in:
      payload.refresh_token ?
        DARAZ_REFRESH_TOKEN_TTL_MS / 1000
      : (payload.refresh_expires_in ?? null),
    token_expiry: expiryFromSeconds(payload.expires_in),
    refresh_token_expiry:
      payload.refresh_token ? buildDarazRefreshTokenExpiry() : null,
    account: payload.account || null,
    country_user_info: payload.country_user_info || null,
  };
}

async function createDarazAccessToken({
  appKey,
  appSecret,
  code,
  uuid,
  integrationId = null,
  fetchImpl = fetch,
}) {
  const authCode = trimCredential(code);
  if (!authCode) {
    throw new Error(
      "Authorization code is required to generate a Daraz access token. Sellers must authorize the app first.",
    );
  }

  const apiParams = { code: authCode };
  const uuidValue = trimCredential(uuid);
  if (uuidValue) apiParams.uuid = uuidValue;

  const { data } = await callDarazRest({
    apiPath: CREATE_TOKEN_PATH,
    appKey,
    appSecret,
    apiParams,
    fetchImpl,
  });

  const persisted = await persistDarazTokens(integrationId, data);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in ?? null,
    refresh_expires_in: data.refresh_expires_in ?? null,
    payload: data,
    integration: persisted?.integration || null,
  };
}

async function refreshDarazAccessToken({
  appKey,
  appSecret,
  refreshToken,
  integrationId = null,
  fetchImpl = fetch,
}) {
  const token = trimCredential(refreshToken);
  if (!token) {
    throw new Error(
      "refresh_token is required. Generate a token first (seller authorization), then refresh before access_token expires.",
    );
  }

  const { data } = await callDarazRest({
    apiPath: REFRESH_TOKEN_PATH,
    appKey,
    appSecret,
    apiParams: { refresh_token: token },
    fetchImpl,
  });

  const persisted = await persistDarazTokens(integrationId, data);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_in: data.expires_in ?? null,
    refresh_expires_in: data.refresh_expires_in ?? null,
    payload: data,
    integration: persisted?.integration || null,
  };
}

module.exports = {
  DARAZ_PK_REST_BASE,
  DARAZ_PK_AUTHORIZE_BASE,
  DARAZ_PK_DEFAULT_CALLBACK,
  CREATE_TOKEN_PATH,
  REFRESH_TOKEN_PATH,
  trimCredential,
  maskToken,
  looksLikeDarazAuthCode,
  extractDarazSellerCode,
  isDarazCallbackUrlWithoutCode,
  resolveDarazTokenAction,
  DARAZ_MISSING_SELLER_CODE_MESSAGE,
  DARAZ_CALLBACK_WITHOUT_CODE_MESSAGE,
  DARAZ_REFRESH_TOKEN_TTL_MS,
  expiryFromSeconds,
  buildDarazRefreshTokenExpiry,
  signDarazRequest,
  darazHttpMethod,
  buildDarazAuthorizeUrl,
  buildDarazRequest,
  callDarazRest,
  callDarazImageUpload,
  darazResultData,
  darazErrorText,
  tokenPatchFromDarazPayload,
  publicTokenResult,
  createDarazAccessToken,
  refreshDarazAccessToken,
};

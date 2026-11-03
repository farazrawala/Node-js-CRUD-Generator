/**
 * Embedded Shopify app.
 *
 * A merchant installs it on their store (Shopify managed install, scopes in
 * shopify.app.toml). When they open it in Shopify admin, App Bridge sends a
 * session token. This server exchanges that token for an expiring offline
 * access token and shows the POS integration values for that store.
 */
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { installedScopes } = require("./scopes");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SHOPS_FILE = path.join(DATA_DIR, "shops.json");
const INDEX_FILE = path.join(ROOT, "public", "index.html");

loadEnv(path.join(ROOT, ".env"));

const CLIENT_ID = String(process.env.SHOPIFY_API_KEY || "").trim();
const CLIENT_SECRET = String(process.env.SHOPIFY_API_SECRET || "").trim();
const PORT = Number(process.env.PORT || 3456);
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/auth/callback")) {
        return sendHtml(res, renderIndex(), url.searchParams.get("shop"));
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        const body = await readBody(req);
        return await handleSession(req, res, body);
      }
      if (req.method === "POST" && url.pathname === "/webhooks") {
        const body = await readBody(req);
        return handleWebhook(req, res, body);
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "App request failed" });
    }
  });
}

async function handleSession(req, res) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return sendJson(res, 500, {
      error: "Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET in shopify_plugin/.env, then restart.",
    });
  }

  const header = String(req.headers.authorization || "");
  const idToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  let shop;
  try {
    const payload = verifySessionToken(idToken, CLIENT_SECRET, CLIENT_ID);
    shop = shopFromDest(payload.dest);
  } catch {
    res.setHeader("X-Shopify-Retry-Invalid-Session-Request", "1");
    return sendJson(res, 401, { error: "Invalid Shopify session. Reopen the app from Shopify admin." });
  }

  sendJson(res, 200, {
    shop,
    scopes: installedScopes(),
    connectPath: "/settings/integrations/shopify",
    message:
      "This store can be connected from OrdersHub. Access tokens are not shown here.",
  });
}

function handleWebhook(req, res, rawBody) {
  if (!CLIENT_SECRET) return sendJson(res, 401, { error: "App secret is not configured" });
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!verifyWebhookHmac(rawBody, hmac, CLIENT_SECRET)) {
    return sendJson(res, 401, { error: "Invalid webhook signature" });
  }

  const topic = String(req.headers["x-shopify-topic"] || "");
  const shop = normalizeShop(req.headers["x-shopify-shop-domain"]);
  if (shop && (topic === "app/uninstalled" || topic === "shop/redact")) {
    deleteShop(shop);
  }
  // This app does not store customer records. customers/data_request and
  // customers/redact are acknowledged so Shopify can complete the request.
  console.log(`[shopify] webhook ${topic || "unknown"} shop=${shop || "n/a"}`);
  sendJson(res, 200, { ok: true });
}

async function ensureOfflineToken(shop, idToken) {
  const current = loadShop(shop);
  if (current?.accessToken && current.expiresAt && current.expiresAt - Date.now() > TOKEN_REFRESH_SKEW_MS) {
    return current;
  }
  if (current?.refreshToken) {
    const refreshed = await refreshOfflineToken(shop, current.refreshToken);
    if (refreshed) return refreshed;
  }
  return exchangeOfflineToken(shop, idToken);
}

async function exchangeOfflineToken(shop, idToken) {
  const data = await postToken(shop, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: idToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
    expiring: "1",
  });
  return saveTokenResult(shop, data, loadShop(shop));
}

async function refreshOfflineToken(shop, refreshToken) {
  try {
    const data = await postToken(shop, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    });
    return saveTokenResult(shop, data, loadShop(shop));
  } catch (error) {
    if (error.statusCode === 401) {
      deleteShop(shop);
      return null;
    }
    throw error;
  }
}

async function postToken(shop, params) {
  let response;
  try {
    response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    const failure = new Error("Could not reach Shopify.");
    failure.statusCode = 503;
    throw failure;
  }

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { error: raw };
  }

  if (response.status === 400 && params.grant_type !== "refresh_token") {
    const failure = new Error("Shopify session expired. Reopen the app from Shopify admin.");
    failure.statusCode = 401;
    throw failure;
  }
  if (!response.ok || !data.access_token) {
    const failure = new Error(
      data.error_description || data.error || `Shopify token request failed (HTTP ${response.status}).`,
    );
    failure.statusCode = response.status === 401 ? 401 : 502;
    throw failure;
  }
  return data;
}

function saveTokenResult(shop, data, previous) {
  const record = {
    shop,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previous?.refreshToken || "",
    expiresAt: expiresAtFrom(data.expires_in),
    scope: data.scope || previous?.scope || "",
    installedAt: previous?.installedAt || new Date().toISOString(),
  };
  const all = loadShops();
  all[shop] = record;
  saveShops(all);
  return record;
}

function expiresAtFrom(expiresIn) {
  const seconds = Number(expiresIn);
  return seconds > 0 ? Date.now() + seconds * 1000 : null;
}

function verifySessionToken(token, secret, clientId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid session token");
  const [headerB64, payloadB64, signatureB64] = parts;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = decodeBase64Url(signatureB64);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid session token");
  }
  const header = JSON.parse(decodeBase64Url(headerB64).toString("utf8"));
  if (header.alg !== "HS256") throw new Error("Invalid session token");
  const payload = JSON.parse(decodeBase64Url(payloadB64).toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now - 10) {
    throw new Error("Expired session token");
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 10) {
    throw new Error("Session token not active");
  }
  const audience = payload.aud;
  const audienceOk =
    audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  if (!audienceOk) throw new Error("Invalid audience");
  const issuerHost = new URL(payload.iss).hostname;
  const destHost = new URL(payload.dest).hostname;
  if (issuerHost !== destHost) throw new Error("Issuer mismatch");
  return payload;
}

function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  const provided = String(hmacHeader || "");
  if (!provided || !secret) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function shopFromDest(dest) {
  let host = "";
  try {
    host = new URL(dest).hostname;
  } catch {
    host = "";
  }
  const shop = normalizeShop(host);
  if (!shop) throw new Error("Invalid shop");
  return shop;
}

function normalizeShop(value) {
  const text = String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(text)) return "";
  return text;
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function renderIndex() {
  const items = installedScopes().map(
    (scope) => `<li data-scope="${escapeHtml(scope)}">${escapeHtml(scope)}</li>`,
  ).join("");
  return fs
    .readFileSync(INDEX_FILE, "utf8")
    .replaceAll("%SHOPIFY_API_KEY%", escapeHtml(CLIENT_ID))
    .replaceAll("%SCOPE_ITEMS%", items);
}

function loadShops() {
  try {
    return JSON.parse(fs.readFileSync(SHOPS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function loadShop(shop) {
  return loadShops()[shop] || null;
}

function saveShops(shops) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SHOPS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shops, null, 2));
  fs.renameSync(tmp, SHOPS_FILE);
}

function deleteShop(shop) {
  const all = loadShops();
  if (!all[shop]) return;
  delete all[shop];
  saveShops(all);
}

function loadEnv(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendHtml(res, html, shop) {
  const ancestors = ["https://admin.shopify.com"];
  const normalized = normalizeShop(shop);
  if (normalized) ancestors.unshift(`https://${normalized}`);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `frame-ancestors ${ancestors.join(" ")};`,
  });
  res.end(html);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = createServer();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`POS Connector listening on port ${PORT}`);
    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.log("Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET in shopify_plugin/.env");
    }
  });
}

module.exports = {
  verifySessionToken,
  verifyWebhookHmac,
  shopFromDest,
  server,
};

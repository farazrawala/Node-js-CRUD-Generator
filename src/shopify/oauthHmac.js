/**
 * OAuth callback HMAC, matching @shopify/shopify-api (sorted query, SHA-256 hex).
 * The library rejects callbacks older than 90 seconds, which drops merchants
 * who spend longer on Shopify's permission screen. This check uses the same
 * signature and a 24 hour replay window. State nonces are single-use.
 * Webhook HMAC is base64 over the raw body.
 * @module src/shopify/oauthHmac
 */

const crypto = require("crypto");

const MAX_OAUTH_AGE_SEC = 24 * 60 * 60;

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function oauthMessage(query) {
  const params = new URLSearchParams();
  Object.keys(query || {})
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => {
      const value = query[key];
      if (Array.isArray(value)) {
        value.forEach((item) => params.append(key, String(item)));
      } else if (value != null) {
        params.append(key, String(value));
      }
    });
  return params.toString();
}

function verifyOauthHmac(query, secret, nowSec = Math.trunc(Date.now() / 1000)) {
  const provided = String(query?.hmac || "");
  const key = String(secret || "");
  if (!provided || !key) return false;
  const timestamp = Number(query.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSec - timestamp) > MAX_OAUTH_AGE_SEC) return false;
  const digest = crypto
    .createHmac("sha256", key)
    .update(oauthMessage(query))
    .digest("hex");
  return timingSafeEqualText(digest, provided);
}

function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  const provided = String(hmacHeader || "");
  const key = String(secret || "");
  if (!provided || !key || rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const digest = crypto.createHmac("sha256", key).update(body).digest("base64");
  return timingSafeEqualText(digest, provided);
}

module.exports = {
  MAX_OAUTH_AGE_SEC,
  oauthMessage,
  verifyOauthHmac,
  verifyWebhookHmac,
};

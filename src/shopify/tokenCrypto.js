/**
 * AES-256-GCM for Shopify offline access tokens and refresh tokens.
 * Production must set SHOPIFY_TOKEN_ENCRYPTION_KEY. Development falls back
 * to COURIER_ENCRYPTION_KEY, then a process-local dev key.
 * @module src/shopify/tokenCrypto
 */

const crypto = require("crypto");

const ENC_PREFIX = "enc:v1:";

function encryptionKey() {
  const raw =
    process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY ||
    process.env.COURIER_ENCRYPTION_KEY ||
    "";
  if (raw) {
    return crypto.createHash("sha256").update(String(raw)).digest();
  }
  const live =
    process.env.NODE_ENV === "production" ||
    String(process.env.APP_ENV || "").toLowerCase() === "live";
  if (live) {
    throw new Error(
      "Set SHOPIFY_TOKEN_ENCRYPTION_KEY before storing Shopify access tokens.",
    );
  }
  return crypto
    .createHash("sha256")
    .update("dev-only-shopify-token-key")
    .digest();
}

function encryptToken(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const text = String(plaintext);
  if (text.startsWith(ENC_PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptToken(stored) {
  if (stored == null || stored === "") return stored ?? null;
  const text = String(stored);
  if (!text.startsWith(ENC_PREFIX)) return text;
  try {
    const payload = Buffer.from(text.slice(ENC_PREFIX.length), "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const data = payload.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch (error) {
    const err = new Error(
      "Unable to decrypt the Shopify access token. Check SHOPIFY_TOKEN_ENCRYPTION_KEY.",
    );
    err.cause = error;
    throw err;
  }
}

module.exports = {
  ENC_PREFIX,
  encryptToken,
  decryptToken,
};

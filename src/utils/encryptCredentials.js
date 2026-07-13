/**
 * AES-256-GCM helpers for courier API credentials at rest.
 * Set COURIER_ENCRYPTION_KEY (32-byte hex or any passphrase — hashed to 32 bytes).
 * @module src/utils/encryptCredentials
 */

const crypto = require("crypto");

const ENC_PREFIX = "enc:v1:";

function resolveKey() {
  const raw =
    process.env.COURIER_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    "dev-only-courier-encryption-key-change-me";
  return crypto.createHash("sha256").update(String(raw)).digest();
}

/**
 * Encrypt a plaintext secret for DB storage.
 * @param {string|null|undefined} plaintext
 * @returns {string|null}
 */
function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  const text = String(plaintext);
  if (text.startsWith(ENC_PREFIX)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolveKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]).toString("base64");
  return `${ENC_PREFIX}${payload}`;
}

/**
 * Decrypt a stored secret. Plaintext (legacy) values pass through.
 * @param {string|null|undefined} stored
 * @returns {string|null}
 */
function decryptSecret(stored) {
  if (stored == null || stored === "") return stored ?? null;
  const text = String(stored);
  if (!text.startsWith(ENC_PREFIX)) return text;

  const payload = Buffer.from(text.slice(ENC_PREFIX.length), "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const data = payload.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", resolveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * Encrypt known secret fields on a provider config object (mutates a clone).
 * @param {object} config
 * @returns {object}
 */
function encryptProviderSecrets(config) {
  if (!config || typeof config !== "object") return config;
  const out = { ...config };
  for (const key of ["api_key", "secret", "password", "username"]) {
    if (out[key] != null && out[key] !== "") {
      out[key] = encryptSecret(out[key]);
    }
  }
  return out;
}

/**
 * Decrypt known secret fields for runtime use.
 * @param {object} config
 * @returns {object}
 */
function decryptProviderSecrets(config) {
  if (!config || typeof config !== "object") return config;
  const out = { ...(config.toObject ? config.toObject() : config) };
  for (const key of ["api_key", "secret", "password", "username"]) {
    if (out[key] != null && out[key] !== "") {
      try {
        out[key] = decryptSecret(out[key]);
      } catch {
        // leave as-is if decryption fails (wrong key / corrupt)
      }
    }
  }
  return out;
}

/**
 * Mask secrets for logs / API responses.
 * @param {*} value
 * @returns {*}
 */
function maskSensitive(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length <= 4) return "****";
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  if (Array.isArray(value)) return value.map(maskSensitive);
  if (typeof value === "object") {
    const SENSITIVE = new Set([
      "password",
      "secret",
      "api_key",
      "apikey",
      "clientsecret",
      "client_secret",
      "accesstoken",
      "access_token",
      "token",
      "authorization",
      "username",
      "login",
    ]);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE.has(String(k).toLowerCase())) {
        out[k] = "[REDACTED]";
      } else if (v && typeof v === "object") {
        out[k] = maskSensitive(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  return value;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  encryptProviderSecrets,
  decryptProviderSecrets,
  maskSensitive,
  ENC_PREFIX,
};

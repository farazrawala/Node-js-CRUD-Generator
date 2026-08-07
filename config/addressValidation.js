const fs = require("fs");
const path = require("path");
const defaults = require("./addressValidation.defaults");

const OVERRIDE_PATH = path.join(__dirname, "addressValidation.json");

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function mergeConfig(base, override) {
  const out = { ...base };
  if (!isPlainObject(override)) return out;

  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith("_") || value == null) continue;
    if (Array.isArray(value)) {
      // Empty array in JSON means "no extra entries"; non-empty appends unique
      if (value.length === 0) continue;
      if (Array.isArray(out[key])) {
        const set = new Set(
          [...out[key], ...value].map((x) => String(x).toLowerCase()),
        );
        out[key] = [...set];
      } else {
        out[key] = value;
      }
      continue;
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...out[key], ...value };
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load address validation config (defaults + optional JSON overrides).
 * Pass `overrides` for per-request / per-company customization.
 */
function loadAddressValidationConfig(overrides = null) {
  let cfg = { ...defaults };
  try {
    if (fs.existsSync(OVERRIDE_PATH)) {
      const raw = fs.readFileSync(OVERRIDE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      cfg = mergeConfig(cfg, parsed);
    }
  } catch (err) {
    console.warn(
      "[addressValidation] failed to load addressValidation.json:",
      err?.message || err,
    );
  }
  if (overrides) {
    cfg = mergeConfig(cfg, overrides);
  }
  return cfg;
}

module.exports = {
  loadAddressValidationConfig,
  mergeConfig,
  OVERRIDE_PATH,
};

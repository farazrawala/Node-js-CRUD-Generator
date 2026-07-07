const { SHOPIFY_IMPORT_COLUMNS } = require("./columns");

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapShopifyHeaderIndexes(headers) {
  const normalized = headers.map(normalizeHeader);
  const indexes = {};

  for (const [field, aliases] of Object.entries(SHOPIFY_IMPORT_COLUMNS)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    const idx = normalized.findIndex((h) => aliasSet.has(h));
    if (idx >= 0) indexes[field] = idx;
  }

  return indexes;
}

module.exports = {
  normalizeHeader,
  mapShopifyHeaderIndexes,
};

const crypto = require("crypto");
const Product = require("../models/product");
const {
  generateProductBarcode,
  calculateEAN13CheckDigit,
} = require("./barcodeGenerator");

const WOO_BARCODE_META_KEYS = new Set([
  "barcode",
  "_barcode",
  "ean",
  "_ean",
  "upc",
  "_upc",
  "gtin",
  "_gtin",
  "global_unique_id",
  "_global_unique_id",
]);

/** Another non-deleted product in the company already holding this barcode. */
async function findBarcodeConflict(barcode, companyId, excludeId = null) {
  const trimmed = String(barcode || "").trim();
  if (!trimmed) return null;

  const filter = {
    company_id: companyId,
    barcode: trimmed,
    deletedAt: null,
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  return Product.findOne(filter).select("_id product_name barcode").lean();
}

/**
 * Generate a random EAN13 barcode unique within company (and optional batch set).
 */
async function generateUniqueProductBarcode(
  companyId,
  { assignedInRun = null, excludeId = null } = {},
) {
  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateProductBarcode();
    if (assignedInRun?.has(candidate)) continue;

    const conflict = await findBarcodeConflict(candidate, companyId, excludeId);
    if (!conflict) {
      assignedInRun?.add(candidate);
      return candidate;
    }
  }

  const fallback =
    `2${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 12);
  const base = fallback.padStart(12, "0").slice(0, 12);
  const barcode = `${base}${calculateEAN13CheckDigit(base)}`;
  assignedInRun?.add(barcode);
  return barcode;
}

function ensureAssignedBarcodeSet(stats) {
  if (!stats) return new Set();
  if (!(stats._assignedBarcodes instanceof Set)) {
    stats._assignedBarcodes = new Set();
  }
  return stats._assignedBarcodes;
}

/**
 * Resolve barcode for store → POS product import.
 * Prefer remote barcode when available and unused; keep existing POS barcode;
 * otherwise auto-generate a unique EAN13.
 */
async function resolveFetchProductBarcode({
  remoteBarcode,
  existingProduct,
  companyId,
  stats = null,
} = {}) {
  const assignedInRun = ensureAssignedBarcodeSet(stats);
  const existingBarcode = String(existingProduct?.barcode || "").trim();
  const raw = String(remoteBarcode || "").trim();

  if (raw) {
    const conflict = await findBarcodeConflict(
      raw,
      companyId,
      existingProduct?._id,
    );
    if (!conflict && !assignedInRun.has(raw)) {
      assignedInRun.add(raw);
      return raw;
    }
  }

  if (existingBarcode) {
    return existingBarcode;
  }

  return generateUniqueProductBarcode(companyId, {
    assignedInRun,
    excludeId: existingProduct?._id,
  });
}

/** Shopify Admin REST variants expose `barcode`. */
function extractShopifyBarcode(variant) {
  return String(variant?.barcode || "").trim();
}

/**
 * WooCommerce: `global_unique_id` (core) or common barcode meta keys from plugins.
 */
function extractWooBarcode(remote) {
  const direct = String(
    remote?.global_unique_id || remote?.barcode || "",
  ).trim();
  if (direct) return direct;

  const meta = Array.isArray(remote?.meta_data) ? remote.meta_data : [];
  for (const entry of meta) {
    const key = String(entry?.key || "")
      .trim()
      .toLowerCase();
    if (!WOO_BARCODE_META_KEYS.has(key)) continue;
    const value = String(entry?.value || "").trim();
    if (value) return value;
  }

  return "";
}

module.exports = {
  findBarcodeConflict,
  generateUniqueProductBarcode,
  resolveFetchProductBarcode,
  extractShopifyBarcode,
  extractWooBarcode,
};

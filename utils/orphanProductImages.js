/**
 * Detect product image files on disk that no product document references.
 */

const fs = require("fs");
const path = require("path");
const Product = require("../models/product");
const {
  deleteLocalUploadFiles,
  toAbsolutePath,
} = require("./productImageThumbnail");
const { toPublicUploadUrl } = require("./basePath");

const IMAGE_FIELDS = [
  "product_image",
  "product_image_thumbnail_url",
  "multi_images",
  "multi_image_thumbnails",
];

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = [
  path.join(ROOT, "uploads", "products"),
  path.join(ROOT, "uploads", "product"),
];

function toRelativeUploadKey(value) {
  let text = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    try {
      text = new URL(text).pathname || "";
    } catch {
      return null;
    }
  }

  text = text.replace(/^\/+/, "");
  const idx = text.indexOf("uploads/");
  if (idx === -1) return null;
  return text.slice(idx);
}

function isAllowedOrphanKey(key) {
  const normalized = String(key || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return (
    normalized.startsWith("uploads/products/") ||
    normalized.startsWith("uploads/product/")
  );
}

function collectReferencedKeys(product) {
  const keys = new Set();
  for (const field of IMAGE_FIELDS) {
    const raw = product[field];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      const key = toRelativeUploadKey(v);
      if (key) keys.add(key);
    }
  }
  return keys;
}

async function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function absoluteToRelativeKey(absPath) {
  const rel = path.relative(ROOT, absPath).replace(/\\/g, "/");
  return toRelativeUploadKey(rel);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @param {{ companyId?: string|null, activeOnly?: boolean }} [options]
 * @returns {Promise<{
 *   productsScanned: number,
 *   filesOnDisk: number,
 *   linkedPaths: number,
 *   orphans: Array<{
 *     key: string,
 *     abs: string,
 *     fileName: string,
 *     size: number,
 *     sizeLabel: string,
 *     mtime: Date|null,
 *     companyId: string|null,
 *     productId: string|null,
 *     url: string,
 *   }>
 * }>}
 */
async function findOrphanProductImages(options = {}) {
  const companyId = options.companyId ? String(options.companyId).trim() : null;
  const activeOnly = Boolean(options.activeOnly);

  const query = {};
  if (activeOnly) query.deletedAt = null;
  if (companyId) query.company_id = companyId;

  const products = await Product.find(query)
    .select(IMAGE_FIELDS.join(" "))
    .lean();

  const linked = new Set();
  for (const product of products) {
    for (const key of collectReferencedKeys(product)) {
      linked.add(key);
    }
  }

  const onDisk = [];
  for (const scanDir of SCAN_DIRS) {
    await walkFiles(scanDir, onDisk);
  }

  const orphans = [];
  for (const abs of onDisk) {
    const key = absoluteToRelativeKey(abs);
    if (!key || !isAllowedOrphanKey(key)) continue;

    const parts = key.split("/");
    // uploads/products/<companyId>/<productId>/file
    // uploads/product/<productId>/file (legacy)
    let fileCompanyId = null;
    let fileProductId = null;
    if (parts[1] === "products" && parts.length >= 5) {
      fileCompanyId = parts[2];
      fileProductId = parts[3];
      if (companyId && fileCompanyId !== companyId) continue;
    } else if (parts[1] === "product" && parts.length >= 4) {
      fileProductId = parts[2];
    }

    if (linked.has(key)) continue;

    let size = 0;
    let mtime = null;
    try {
      const stat = await fs.promises.stat(abs);
      size = stat.size;
      mtime = stat.mtime;
    } catch {
      // ignore missing race
    }

    orphans.push({
      key,
      abs,
      fileName: path.basename(abs),
      size,
      sizeLabel: formatBytes(size),
      mtime,
      companyId: fileCompanyId,
      productId: fileProductId,
      url: toPublicUploadUrl(key),
    });
  }

  orphans.sort((a, b) => a.key.localeCompare(b.key));

  return {
    productsScanned: products.length,
    filesOnDisk: onDisk.length,
    linkedPaths: linked.size,
    orphans,
  };
}

/**
 * Delete orphan keys from disk. Only paths under uploads/products|product.
 * Re-checks against DB so a newly linked file is not removed.
 */
async function deleteOrphanProductImages(keys, options = {}) {
  const requested = (
    Array.isArray(keys) ? keys : [keys]
  )
    .map((k) => toRelativeUploadKey(k))
    .filter((k) => k && isAllowedOrphanKey(k));

  if (!requested.length) {
    return { deleted: [], skipped: [], errors: [] };
  }

  const scan = await findOrphanProductImages({
    companyId: options.companyId || null,
    activeOnly: options.activeOnly,
  });
  const orphanSet = new Set(scan.orphans.map((o) => o.key));

  const deleted = [];
  const skipped = [];
  const errors = [];

  for (const key of requested) {
    if (!orphanSet.has(key)) {
      skipped.push({ key, reason: "not_orphan_or_missing" });
      continue;
    }
    const abs = toAbsolutePath(key);
    if (!abs || !fs.existsSync(abs)) {
      skipped.push({ key, reason: "missing_on_disk" });
      continue;
    }
    try {
      // Do not cascade to companion thumbs — delete only what was selected.
      await deleteLocalUploadFiles(key, { alsoDeleteThumbnails: false });
      deleted.push(key);
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  }

  return { deleted, skipped, errors };
}

module.exports = {
  IMAGE_FIELDS,
  toRelativeUploadKey,
  isAllowedOrphanKey,
  formatBytes,
  findOrphanProductImages,
  deleteOrphanProductImages,
};

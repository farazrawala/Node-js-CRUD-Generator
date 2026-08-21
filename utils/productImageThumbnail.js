const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const DEFAULT_THUMB_WIDTH = Number(process.env.PRODUCT_THUMB_WIDTH) || 100;

/** Fields that store full-size product images (not dedicated thumb columns). */
const PRODUCT_ORIGINAL_IMAGE_FIELDS = new Set([
  "product_image",
  "multi_images",
]);

function isRemoteImagePath(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isThumbnailPath(value) {
  const text = String(value || "")
    .trim()
    .replace(/\\/g, "/");
  if (!text) return false;
  const base = path.posix.basename(text, path.posix.extname(text));
  return /_thumb$/i.test(base);
}

function toAbsolutePath(relativePath) {
  const normalized = String(relativePath || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized || isRemoteImagePath(normalized)) return null;

  if (normalized.startsWith("uploads/")) {
    return path.join(__dirname, "..", normalized);
  }
  if (normalized.startsWith("/uploads/")) {
    return path.join(__dirname, "..", normalized.replace(/^\//, ""));
  }
  return null;
}

function thumbnailRelativePath(sourceRelativePath) {
  const normalized = String(sourceRelativePath || "")
    .trim()
    .replace(/\\/g, "/");
  if (!normalized || isThumbnailPath(normalized)) return normalized;

  const dir = path.posix.dirname(normalized);
  const ext = path.posix.extname(normalized) || ".jpg";
  const base = path.posix.basename(normalized, ext);
  return path.posix.join(dir, `${base}_thumb${ext}`);
}

/**
 * Create a resized thumbnail next to the source image.
 * @returns {Promise<string|null>} uploads/products/<company_id>/<product_id>/file_thumb.jpg
 */
async function createProductImageThumbnail(
  sourceRelativePath,
  { width = DEFAULT_THUMB_WIDTH, force = false } = {},
) {
  const normalized = String(sourceRelativePath || "")
    .trim()
    .replace(/\\/g, "/");
  if (
    !normalized ||
    isRemoteImagePath(normalized) ||
    isThumbnailPath(normalized)
  ) {
    return null;
  }

  const absSource = toAbsolutePath(normalized);
  if (!absSource || !fs.existsSync(absSource)) {
    return null;
  }

  const relativeThumb = thumbnailRelativePath(normalized);
  const absThumb = toAbsolutePath(relativeThumb);
  if (!absThumb) return null;

  try {
    if (!force && fs.existsSync(absThumb)) {
      const sourceStat = await fs.promises.stat(absSource);
      const thumbStat = await fs.promises.stat(absThumb);
      if (thumbStat.mtimeMs >= sourceStat.mtimeMs) {
        return relativeThumb;
      }
    }

    await fs.promises.mkdir(path.dirname(absThumb), { recursive: true });
    await sharp(absSource)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .toFile(absThumb);

    return relativeThumb;
  } catch (error) {
    console.warn(
      "⚠️ Failed to create product image thumbnail:",
      normalized,
      error.message,
    );
    return null;
  }
}

async function createProductImageThumbnails(
  sourceRelativePaths = [],
  options = {},
) {
  const thumbs = [];
  for (const sourcePath of sourceRelativePaths) {
    thumbs.push(await createProductImageThumbnail(sourcePath, options));
  }
  return thumbs;
}

/**
 * Build thumbnail DB fields from featured + gallery image paths.
 */
async function buildProductThumbnailFields(product = {}, options = {}) {
  const out = {};
  const productImage = String(product.product_image || "").trim();

  if (productImage) {
    const thumb = await createProductImageThumbnail(productImage, options);
    if (thumb) out.product_image_thumbnail_url = thumb;
  } else {
    out.product_image_thumbnail_url = "";
  }

  const multiImages =
    Array.isArray(product.multi_images) ?
      product.multi_images
        .map((img) => String(img || "").trim())
        .filter(Boolean)
    : [];

  if (multiImages.length) {
    const thumbs = await createProductImageThumbnails(multiImages, options);
    out.multi_image_thumbnails = thumbs.map((thumb) => thumb || "");
  } else {
    out.multi_image_thumbnails = [];
  }

  return out;
}

async function syncProductImageThumbnails(record, options = {}) {
  if (!record) return null;

  const thumbFields = await buildProductThumbnailFields(
    {
      product_image: record.product_image,
      multi_images: record.multi_images,
    },
    options,
  );

  let changed = false;
  for (const [field, value] of Object.entries(thumbFields)) {
    const current = record[field];
    const same =
      Array.isArray(current) && Array.isArray(value) ?
        JSON.stringify(current) === JSON.stringify(value)
      : String(current || "") === String(value || "");
    if (!same) {
      record[field] = value;
      changed = true;
    }
  }

  if (changed && typeof record.save === "function") {
    record._syncingThumbnails = true;
    await record.save({ validateBeforeSave: false });
    record._syncingThumbnails = false;
  }

  return thumbFields;
}

/**
 * company.allow_upload_product_image_original (default false).
 * true  → keep full-size product_image / multi_images
 * false → store only thumb-sized files for those fields
 */
async function companyAllowsOriginalProductImages(companyId) {
  if (!companyId) return false;
  try {
    const Company = require("../models/company");
    const company = await Company.findById(companyId)
      .select("allow_upload_product_image_original")
      .lean();
    return Boolean(company?.allow_upload_product_image_original);
  } catch (error) {
    console.warn(
      "⚠️ Failed to load allow_upload_product_image_original:",
      error.message,
    );
    return false;
  }
}

async function replaceLocalImageWithThumbnail(
  relativePath,
  { width = DEFAULT_THUMB_WIDTH } = {},
) {
  const absPath = toAbsolutePath(relativePath);
  if (!absPath || !fs.existsSync(absPath)) return relativePath;

  const tmpPath = `${absPath}.resize-tmp`;
  try {
    await sharp(absPath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .toFile(tmpPath);
    await fs.promises.unlink(absPath);
    await fs.promises.rename(tmpPath, absPath);
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
    } catch (_) {
      /* ignore cleanup errors */
    }
    console.warn(
      "⚠️ Failed to downscale product image to thumbnail size:",
      relativePath,
      error.message,
    );
  }
  return relativePath;
}

const UPLOADS_ROOT = path.resolve(path.join(__dirname, "..", "uploads"));

function resolveSafeUploadAbsolute(relativePath) {
  const abs = toAbsolutePath(relativePath);
  if (!abs) return null;
  const resolved = path.resolve(abs);
  const rootWithSep = UPLOADS_ROOT.endsWith(path.sep)
    ? UPLOADS_ROOT
    : UPLOADS_ROOT + path.sep;
  if (resolved !== UPLOADS_ROOT && !resolved.startsWith(rootWithSep)) {
    return null;
  }
  return resolved;
}

/**
 * Delete local upload file(s) from disk. Skips remote URLs.
 * Also removes companion `*_thumb` files when `alsoDeleteThumbnails` is true.
 * @param {string|string[]|null|undefined} relativePathOrPaths
 * @param {{ alsoDeleteThumbnails?: boolean }} [options]
 * @returns {Promise<string[]>} deleted absolute paths
 */
async function deleteLocalUploadFiles(
  relativePathOrPaths,
  { alsoDeleteThumbnails = true } = {},
) {
  const inputs = (
    Array.isArray(relativePathOrPaths) ? relativePathOrPaths : (
      [relativePathOrPaths]
    )
  )
    .map((p) => String(p || "").trim().replace(/\\/g, "/"))
    .filter(Boolean);

  const candidates = new Set();
  for (const rel of inputs) {
    if (isRemoteImagePath(rel)) continue;
    candidates.add(rel);
    if (alsoDeleteThumbnails && !isThumbnailPath(rel)) {
      const thumb = thumbnailRelativePath(rel);
      if (thumb) candidates.add(thumb);
    }
  }

  const deleted = [];
  for (const rel of candidates) {
    const abs = resolveSafeUploadAbsolute(rel);
    if (!abs) continue;
    try {
      if (fs.existsSync(abs)) {
        await fs.promises.unlink(abs);
        deleted.push(abs);
        console.log(`🗑️ Deleted upload file: ${rel}`);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to delete upload file ${rel}:`, error.message);
    }
  }
  return deleted;
}

/**
 * Diff old vs new image field values and delete files that are no longer referenced.
 */
async function deleteOrphanedUploadFiles(previousValue, nextValue, options = {}) {
  const prev = (
    Array.isArray(previousValue) ? previousValue : (
      previousValue ? [previousValue] : []
    )
  )
    .map((p) => String(p || "").trim())
    .filter(Boolean);
  const next = new Set(
    (
      Array.isArray(nextValue) ? nextValue : nextValue ? [nextValue] : []
    )
      .map((p) => String(p || "").trim())
      .filter(Boolean),
  );
  const orphans = prev.filter((p) => !next.has(p));
  if (!orphans.length) return [];
  return deleteLocalUploadFiles(orphans, options);
}

/**
 * When company disallows originals, replace uploaded product_image / multi_images
 * files on disk with thumb-sized versions. Thumbnail columns are unchanged.
 */
async function enforceProductImageOriginalPolicy(
  relativePathOrPaths,
  { companyId, fieldName, allowOriginal = null } = {},
) {
  if (!PRODUCT_ORIGINAL_IMAGE_FIELDS.has(String(fieldName || ""))) {
    return relativePathOrPaths;
  }

  const allow =
    allowOriginal != null ?
      Boolean(allowOriginal)
    : await companyAllowsOriginalProductImages(companyId);
  if (allow) return relativePathOrPaths;

  if (Array.isArray(relativePathOrPaths)) {
    const out = [];
    for (const p of relativePathOrPaths) {
      out.push(await replaceLocalImageWithThumbnail(p));
    }
    return out;
  }

  return replaceLocalImageWithThumbnail(relativePathOrPaths);
}

module.exports = {
  DEFAULT_THUMB_WIDTH,
  PRODUCT_ORIGINAL_IMAGE_FIELDS,
  createProductImageThumbnail,
  createProductImageThumbnails,
  buildProductThumbnailFields,
  syncProductImageThumbnails,
  thumbnailRelativePath,
  isThumbnailPath,
  toAbsolutePath,
  companyAllowsOriginalProductImages,
  enforceProductImageOriginalPolicy,
  replaceLocalImageWithThumbnail,
  deleteLocalUploadFiles,
  deleteOrphanedUploadFiles,
};

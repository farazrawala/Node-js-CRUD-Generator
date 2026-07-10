const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

const DEFAULT_THUMB_WIDTH = Number(process.env.PRODUCT_THUMB_WIDTH) || 70;

function isRemoteImagePath(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isThumbnailPath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
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
  if (!normalized || isRemoteImagePath(normalized) || isThumbnailPath(normalized)) {
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

  const multiImages = Array.isArray(product.multi_images) ?
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

module.exports = {
  DEFAULT_THUMB_WIDTH,
  createProductImageThumbnail,
  createProductImageThumbnails,
  buildProductThumbnailFields,
  syncProductImageThumbnails,
  thumbnailRelativePath,
  isThumbnailPath,
};

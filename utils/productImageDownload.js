const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const {
  buildProductImageAbsoluteDir,
  buildProductImageRelativePath,
  toIdString,
} = require("./productImagePaths");
const {
  companyAllowsOriginalProductImages,
  replaceLocalImageWithThumbnail,
} = require("./productImageThumbnail");

function sanitizeFileName(baseName, fallbackExt = ".jpg") {
  if (!baseName || typeof baseName !== "string") {
    return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${fallbackExt}`;
  }

  const nameWithoutQuery = baseName.split("?")[0].split("#")[0];
  const extension = path.extname(nameWithoutQuery) || fallbackExt;
  const rawName = path.basename(nameWithoutQuery, extension);
  const sanitized =
    rawName
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") ||
    `image-${crypto.randomBytes(4).toString("hex")}`;

  return `${sanitized}-${crypto.randomBytes(4).toString("hex")}${extension.toLowerCase()}`;
}

function resolveRedirectUrl(currentUrl, redirectLocation) {
  if (!redirectLocation) return null;
  try {
    return new URL(redirectLocation, currentUrl).toString();
  } catch (error) {
    console.warn(
      "⚠️ Failed to resolve redirect URL:",
      redirectLocation,
      error.message,
    );
    return null;
  }
}

function downloadImageToFile(imageUrl, destinationPath, redirectCount = 0) {
  const MAX_REDIRECTS = 5;

  return new Promise((resolve, reject) => {
    if (!imageUrl) {
      return reject(new Error("Image URL is required"));
    }

    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error("Too many redirects while downloading image"));
    }

    let urlObject;
    try {
      urlObject = new URL(imageUrl);
    } catch (error) {
      return reject(new Error(`Invalid image URL: ${imageUrl}`));
    }

    const httpModule = urlObject.protocol === "https:" ? https : http;

    const request = httpModule.get(urlObject, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        const redirectUrl = resolveRedirectUrl(
          urlObject,
          response.headers.location,
        );
        response.resume();
        if (!redirectUrl) {
          return reject(
            new Error("Failed to resolve redirect URL for image download"),
          );
        }
        return resolve(
          downloadImageToFile(redirectUrl, destinationPath, redirectCount + 1),
        );
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(
          new Error(
            `Failed to download image. Status code: ${response.statusCode}`,
          ),
        );
      }

      const fileStream = fs.createWriteStream(destinationPath);
      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close(() => resolve(destinationPath));
      });

      fileStream.on("error", (error) => {
        fileStream.close(() => {
          fs.unlink(destinationPath, () => reject(error));
        });
      });
    });

    request.on("error", (error) => reject(error));
  });
}

function extensionFromImageUrl(imageUrl) {
  try {
    const urlObject = new URL(imageUrl);
    const ext = path.extname(urlObject.pathname.split("?")[0]);
    if (ext && ext.length <= 6) return ext.toLowerCase();
  } catch (_) {
    /* ignore */
  }
  return ".jpg";
}

function normalizeImageUrlList(urls) {
  const out = [];
  const seen = new Set();
  for (const raw of urls || []) {
    const url = String(raw || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/**
 * Download remote image URLs into uploads/products/<company_id>/<product_id>/
 * and return relative paths.
 * Reuses the same cached file when the same URL is imported again for one product in a run.
 */
async function saveProductImagesFromUrls(
  imageUrls = [],
  { productId = null, companyId = null, urlCache = null } = {},
) {
  const normalized = normalizeImageUrlList(imageUrls);
  const productIdString = toIdString(productId);
  const companyIdString = toIdString(companyId);
  if (!normalized.length || !productIdString || !companyIdString) return null;

  const uploadRoot = buildProductImageAbsoluteDir(
    companyIdString,
    productIdString,
  );
  if (!uploadRoot) return null;
  await fs.promises.mkdir(uploadRoot, { recursive: true });

  const allowOriginal =
    await companyAllowsOriginalProductImages(companyIdString);
  const savedPaths = [];

  for (const sourceUrl of normalized) {
    const cacheKey = `${companyIdString}:${productIdString}:${sourceUrl}`;
    if (urlCache?.has(cacheKey)) {
      savedPaths.push(urlCache.get(cacheKey));
      continue;
    }

    const hash = crypto.createHash("md5").update(sourceUrl).digest("hex");
    const ext = extensionFromImageUrl(sourceUrl);
    const fileName = `${hash}${ext}`;
    const targetPath = path.join(uploadRoot, fileName);
    const relativePath = buildProductImageRelativePath(
      companyIdString,
      productIdString,
      fileName,
    );

    try {
      if (!fs.existsSync(targetPath)) {
        await downloadImageToFile(sourceUrl, targetPath);
      }
      // Skip keeping full-size originals when company setting is false
      if (!allowOriginal) {
        await replaceLocalImageWithThumbnail(relativePath);
      }
      urlCache?.set(cacheKey, relativePath);
      savedPaths.push(relativePath);
    } catch (error) {
      console.warn(
        "⚠️ Failed to download product image:",
        sourceUrl,
        error.message,
      );
    }
  }

  if (!savedPaths.length) return null;

  return {
    featured: savedPaths[0],
    gallery: savedPaths.slice(1),
  };
}

module.exports = {
  downloadImageToFile,
  saveProductImagesFromUrls,
  normalizeImageUrlList,
};

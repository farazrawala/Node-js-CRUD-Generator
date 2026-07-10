const Product = require("../models/product");
const { saveProductImagesFromUrls } = require("./productImageDownload");
const { buildProductThumbnailFields } = require("./productImageThumbnail");
const { isLocalProductAssetPath, toIdString } = require("./productImagePaths");

function extractWooImageUrls(remote = {}, { isVariation = false } = {}) {
  if (isVariation) {
    const src =
      typeof remote?.image === "object" ?
        String(remote.image?.src || "").trim()
      : String(remote?.image || "").trim();
    return src ? [src] : [];
  }

  const urls = [];

  if (Array.isArray(remote?.images)) {
    for (const image of remote.images) {
      const src = String(image?.src || "").trim();
      if (src) urls.push(src);
    }
  }

  if (!urls.length) {
    const single =
      typeof remote?.image === "string" ? remote.image.trim()
      : typeof remote?.image?.src === "string" ? remote.image.src.trim()
      : "";
    if (single) urls.push(single);
  }

  return urls;
}

function extractShopifyImageUrls(
  remoteProduct = {},
  { variant = null, isVariation = false } = {},
) {
  const images = Array.isArray(remoteProduct?.images) ? remoteProduct.images : [];

  if (isVariation && variant?.image_id) {
    const match = images.find(
      (img) => Number(img?.id) === Number(variant.image_id),
    );
    const src = String(match?.src || "").trim();
    return src ? [src] : [];
  }

  if (!isVariation) {
    return images
      .map((img) => String(img?.src || "").trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Download remote store image URLs into uploads/products/<company_id>/<product_id>/
 * and update the product row.
 * Skips when the product already has a locally stored featured image.
 */
async function syncFetchProductImages(
  productId,
  imageUrls,
  existingProduct = null,
) {
  if (!productId || !imageUrls?.length) {
    return false;
  }

  const productIdStr = String(productId);
  const companyId =
    toIdString(existingProduct?.company_id) ||
    toIdString(
      (
        await Product.findById(productId)
          .select("company_id product_image")
          .lean()
      )?.company_id,
    );

  if (!companyId) {
    console.warn(
      "⚠️ syncFetchProductImages skipped: missing company_id for product",
      productIdStr,
    );
    return false;
  }

  const currentFeatured = existingProduct?.product_image || "";
  if (isLocalProductAssetPath(currentFeatured, productIdStr, companyId)) {
    return false;
  }

  const saved = await saveProductImagesFromUrls(imageUrls, {
    productId,
    companyId,
  });
  if (!saved?.featured) {
    return false;
  }

  const update = {
    product_image: saved.featured,
    multi_images: saved.gallery || [],
  };
  const thumbFields = await buildProductThumbnailFields(update);
  Object.assign(update, thumbFields);

  await Product.updateOne({ _id: productId }, { $set: update });
  return true;
}

module.exports = {
  extractWooImageUrls,
  extractShopifyImageUrls,
  isLocalProductAssetPath,
  syncFetchProductImages,
};

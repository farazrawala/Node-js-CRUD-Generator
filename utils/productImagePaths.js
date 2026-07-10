const path = require("path");

/**
 * Product images live under:
 *   uploads/products/<company_id>/<product_id>/
 * Legacy (still recognized for reads):
 *   uploads/product/<product_id>/
 */

function toIdString(value) {
  if (value == null || value === "") return null;

  // Mongoose ObjectId (has toHexString) — do not walk ._id (it self-references)
  if (typeof value === "object" && typeof value.toHexString === "function") {
    return value.toHexString();
  }

  // Populated doc shape: { _id: ObjectId, ... }
  if (
    typeof value === "object" &&
    value._id != null &&
    value._id !== value
  ) {
    return toIdString(value._id);
  }

  const str = String(value).trim();
  if (!str || str === "[object Object]") return null;
  return str;
}

function isProductUploadModel(modelName) {
  const name = String(modelName || "")
    .trim()
    .toLowerCase();
  return name === "product" || name === "products";
}

/**
 * Relative dir: uploads/products/<company_id>/<product_id>
 */
function buildProductImageRelativeDir(companyId, productId) {
  const companyIdString = toIdString(companyId);
  const productIdString = toIdString(productId);
  if (!companyIdString || !productIdString) return null;
  return path.posix.join("uploads", "products", companyIdString, productIdString);
}

/**
 * Absolute filesystem dir for a product's images.
 */
function buildProductImageAbsoluteDir(companyId, productId) {
  const relative = buildProductImageRelativeDir(companyId, productId);
  if (!relative) return null;
  return path.join(__dirname, "..", ...relative.split("/"));
}

/**
 * Relative path for a file inside the product image dir.
 */
function buildProductImageRelativePath(companyId, productId, fileName) {
  const dir = buildProductImageRelativeDir(companyId, productId);
  if (!dir || !fileName) return null;
  return path.posix.join(dir, String(fileName));
}

/**
 * True when value points at a local product asset for this product
 * (new company-scoped path or legacy uploads/product/{id}/).
 */
function isLocalProductAssetPath(value, productId, companyId = null) {
  if (!value || typeof value !== "string" || !productId) {
    return false;
  }

  const normalizedValue = value.replace(/\\/g, "/");
  const productIdString = toIdString(productId);
  if (!productIdString) return false;

  const companyIdString = toIdString(companyId);
  if (companyIdString) {
    const scopedPrefix = `uploads/products/${companyIdString}/${productIdString}/`;
    if (normalizedValue.startsWith(scopedPrefix)) return true;
  }

  // Any company folder for this product id
  if (
    new RegExp(`^uploads/products/[^/]+/${productIdString}/`).test(
      normalizedValue,
    )
  ) {
    return true;
  }

  // Legacy path
  return normalizedValue.startsWith(`uploads/product/${productIdString}/`);
}

/**
 * Resolve upload dir segments for handleImageUpload / admin CRUD.
 * Products → uploads/products/<company_id>/<product_id>
 * Other models → uploads/<modelName>/<recordId>
 */
function resolveUploadDirSegments(modelName, recordId, companyId = null) {
  if (isProductUploadModel(modelName)) {
    const companyIdString = toIdString(companyId);
    const productIdString = toIdString(recordId);
    if (companyIdString && productIdString) {
      return ["uploads", "products", companyIdString, productIdString];
    }
  }

  return ["uploads", String(modelName), String(recordId)];
}

module.exports = {
  toIdString,
  isProductUploadModel,
  buildProductImageRelativeDir,
  buildProductImageAbsoluteDir,
  buildProductImageRelativePath,
  isLocalProductAssetPath,
  resolveUploadDirSegments,
};

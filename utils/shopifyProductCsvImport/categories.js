function resolveCategory(vendor, productCategory, type) {
  const cat = String(productCategory || "").trim();
  if (cat) return cat;
  const ven = String(vendor || "").trim();
  if (ven) return ven;
  const typ = String(type || "").trim();
  if (typ) return typ;
  return "Shopify";
}

/** Split Shopify breadcrumb paths: `A > B > C` → [`A`, `B`, `C`]. */
function splitShopifyCategoryPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return ["Shopify"];
  const parts = raw
    .split(/\s*>\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : ["Shopify"];
}

function resolveCategoryNames(vendor, productCategory, type) {
  const cat = String(productCategory || "").trim();
  if (cat) return splitShopifyCategoryPath(cat);
  const ven = String(vendor || "").trim();
  if (ven) return splitShopifyCategoryPath(ven);
  const typ = String(type || "").trim();
  if (typ) return splitShopifyCategoryPath(typ);
  return ["Shopify"];
}

module.exports = {
  resolveCategory,
  splitShopifyCategoryPath,
  resolveCategoryNames,
};

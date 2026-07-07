function buildVariantLabel(optionValues) {
  const parts = optionValues.map((v) => String(v || "").trim()).filter(Boolean);
  return parts.join(" / ");
}

function buildProductName(baseTitle, variantLabel) {
  const title = String(baseTitle || "").trim();
  if (!title) return "";
  if (!variantLabel) return title;
  return `${title} - ${variantLabel}`;
}

module.exports = {
  buildVariantLabel,
  buildProductName,
};

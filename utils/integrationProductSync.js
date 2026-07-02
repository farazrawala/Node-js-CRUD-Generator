const { categorySlugFromName } = require("./processHelpers");

const SYNC_TOGGLE_KEYS = [
  "sync_product_name",
  "sync_product_slug",
  "sync_product_image",
  "sync_product_price",
  "sync_product_description",
  "sync_product_status",
];

function isIntegrationSyncEnabled(integration, fieldKey) {
  if (!fieldKey) return true;
  const raw = integration?.[fieldKey];
  if (raw == null || raw === "") return true;
  return String(raw).trim().toLowerCase() !== "no";
}

function resolvePosProductSku(product) {
  return (
    (typeof product?.sku === "string" && product.sku.trim()) ||
    (typeof product?.product_code === "string" && product.product_code.trim()) ||
    (product?._id ? String(product._id) : "")
  );
}

function resolvePublicAssetUrl(assetPath) {
  if (assetPath == null) return "";
  const trimmed = String(assetPath).trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const base = String(process.env.BASE_URL || "http://localhost:8000").replace(
    /\/$/,
    "",
  );
  return `${base}/${trimmed.replace(/^\/+/, "")}`;
}

function mapPosStatusToWoo(status) {
  return String(status || "active").toLowerCase() === "active" ?
      "publish"
    : "draft";
}

function mapPosStatusToShopify(status) {
  return String(status || "active").toLowerCase() === "active" ?
      "active"
    : "draft";
}

function buildWooCommerceProductSyncPayload(product, integration, options = {}) {
  const mode = options.mode === "create" ? "create" : "update";
  const payload = {};

  const allowName =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_name");
  const allowSlug =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_slug");
  const allowPrice =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_price");
  const allowDescription =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_description");
  const allowStatus =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_status");
  const allowImage =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_image");

  if (allowName && product?.product_name) {
    payload.name = product.product_name;
  }
  if (allowSlug) {
    const slug =
      product?.product_slug ||
      categorySlugFromName(product?.product_name || "");
    if (slug) payload.slug = slug;
  }
  if (allowPrice) {
    payload.regular_price =
      product?.product_price !== undefined && product?.product_price !== null ?
        String(product.product_price)
      : "0";
  }
  if (allowDescription) {
    payload.description = product?.product_description || "";
    payload.short_description = product?.product_description || "";
  }
  if (allowStatus) {
    payload.status = mapPosStatusToWoo(product?.status);
  }
  if (allowImage && product?.product_image) {
    const src = resolvePublicAssetUrl(product.product_image);
    if (src) payload.images = [{ src }];
  }

  if (product?.weight !== undefined && product?.weight !== null) {
    payload.weight = String(product.weight);
  }

  return payload;
}

function buildShopifyProductSyncPayload(product, integration, options = {}) {
  const mode = options.mode === "create" ? "create" : "update";
  const payload = {};

  const allowName =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_name");
  const allowSlug =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_slug");
  const allowDescription =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_description");
  const allowStatus =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_status");
  const allowImage =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_image");

  if (allowName && product?.product_name) {
    payload.title = product.product_name;
  }
  if (allowSlug) {
    const handle =
      product?.product_slug ||
      categorySlugFromName(product?.product_name || "");
    if (handle) payload.handle = handle;
  }
  if (allowDescription) {
    payload.body_html = product?.product_description || "";
  }
  if (allowStatus) {
    payload.status = mapPosStatusToShopify(product?.status);
  }
  if (allowImage && product?.product_image) {
    const src = resolvePublicAssetUrl(product.product_image);
    if (src) payload.images = [{ src }];
  }

  if (product?.product_type) {
    payload.product_type = product.product_type;
  }

  return payload;
}

function buildShopifyVariantSyncPayload(product, integration, options = {}) {
  const mode = options.mode === "create" ? "create" : "update";
  const allowPrice =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_price");
  if (!allowPrice) return null;

  const variantPayload = {
    price:
      product?.product_price !== undefined && product?.product_price !== null ?
        String(product.product_price)
      : "0.00",
  };

  if (product?.weight !== undefined && product?.weight !== null) {
    const numericWeight = Number(product.weight);
    if (!Number.isNaN(numericWeight)) {
      variantPayload.weight = numericWeight;
      variantPayload.weight_unit = "g";
    }
  }

  return variantPayload;
}

function hasSyncPayloadFields(payload) {
  return payload && typeof payload === "object" && Object.keys(payload).length > 0;
}

function parsePosVariationLabel(child, parentSku) {
  const name = String(child?.product_name || "");
  const bracket = name.match(/\[([^\]]+)\]\s*$/);
  if (bracket?.[1]) {
    return String(bracket[1]).trim();
  }

  const parent = String(parentSku || "").trim();
  const childSku = resolvePosProductSku(child);
  if (parent && childSku.startsWith(`${parent}-`)) {
    return childSku.slice(parent.length + 1);
  }

  return "";
}

function mapLabelToWooVariationAttributes(label, remoteParentAttributes) {
  const parts = String(label || "")
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return [];
  }

  const attrs = Array.isArray(remoteParentAttributes) ? remoteParentAttributes : [];
  const matched = [];
  const usedParts = new Set();

  for (const remoteAttr of attrs) {
    const options = Array.isArray(remoteAttr?.options) ? remoteAttr.options : [];
    for (const option of options) {
      const optionText = String(option || "").trim();
      if (!optionText) {
        continue;
      }
      const normalizedOption = optionText.toUpperCase().replace(/\s+/g, "-");
      const partIndex = parts.findIndex(
        (part, index) =>
          !usedParts.has(index) &&
          (part.toUpperCase() === normalizedOption ||
            part.toUpperCase() === optionText.toUpperCase()),
      );
      if (partIndex < 0) {
        continue;
      }

      const entry = { option: optionText };
      if (remoteAttr?.id != null) {
        entry.id = remoteAttr.id;
      } else if (remoteAttr?.name) {
        entry.name = remoteAttr.name;
      }
      matched.push(entry);
      usedParts.add(partIndex);
      break;
    }
  }

  return matched;
}

function buildWooCommerceVariationSyncPayload(
  child,
  integration,
  remoteParent,
  parentSku,
  options = {},
) {
  const mode = options.mode === "create" ? "create" : "update";
  const payload = {};

  const allowPrice =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_price");
  const allowStatus =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_status");

  const childSku = resolvePosProductSku(child);
  if (childSku) {
    payload.sku = childSku;
  }

  if (allowPrice) {
    payload.regular_price =
      child?.product_price !== undefined && child?.product_price !== null ?
        String(child.product_price)
      : "0";
  }

  if (allowStatus) {
    payload.status = mapPosStatusToWoo(child?.status);
  }

  if (child?.weight !== undefined && child?.weight !== null) {
    payload.weight = String(child.weight);
  }

  const label = parsePosVariationLabel(child, parentSku);
  const variationAttributes = mapLabelToWooVariationAttributes(
    label,
    remoteParent?.attributes,
  );
  if (variationAttributes.length) {
    payload.attributes = variationAttributes;
  }

  return payload;
}

module.exports = {
  SYNC_TOGGLE_KEYS,
  isIntegrationSyncEnabled,
  resolvePosProductSku,
  resolvePublicAssetUrl,
  buildWooCommerceProductSyncPayload,
  buildWooCommerceVariationSyncPayload,
  buildShopifyProductSyncPayload,
  buildShopifyVariantSyncPayload,
  hasSyncPayloadFields,
  parsePosVariationLabel,
  mapLabelToWooVariationAttributes,
};

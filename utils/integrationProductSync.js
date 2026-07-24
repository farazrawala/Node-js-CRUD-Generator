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
  if (raw === false || raw === 0) return false;
  const normalized = String(raw).trim().toLowerCase();
  return !(
    normalized === "no" ||
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off"
  );
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

/**
 * Prefer sync_product.sync_price when > 0; otherwise product.product_price.
 * @param {object|null|undefined} product
 * @param {object|number|null|undefined} syncRowOrPrice - mapping row or numeric override
 * @returns {string}
 */
function resolveSyncProductPrice(product, syncRowOrPrice) {
  let override = null;
  if (syncRowOrPrice != null && typeof syncRowOrPrice === "object") {
    override = syncRowOrPrice.sync_price;
  } else if (syncRowOrPrice != null && syncRowOrPrice !== "") {
    override = syncRowOrPrice;
  }

  const syncPrice = Number(override);
  if (Number.isFinite(syncPrice) && syncPrice > 0) {
    return String(syncPrice);
  }

  if (product?.product_price !== undefined && product?.product_price !== null) {
    return String(product.product_price);
  }
  return "0";
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
  // Image sync must honor the toggle on create and update (Woo/Shopify fetch remote URLs).
  const allowImage = isIntegrationSyncEnabled(
    integration,
    "sync_product_image",
  );

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
    payload.regular_price = resolveSyncProductPrice(
      product,
      options.syncRow ?? options.syncPrice,
    );
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

  applyWooStockToPayload(payload, integration, options.stockQuantity, mode);

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
  // Image sync must honor the toggle on create and update (remote URL fetch).
  const allowImage = isIntegrationSyncEnabled(
    integration,
    "sync_product_image",
  );

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
    price: resolveSyncProductPrice(
      product,
      options.syncRow ?? options.syncPrice,
    ),
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

/**
 * Build WooCommerce stock fields from a POS on-hand quantity. Returns null when
 * the quantity isn't a finite number (so callers can skip stock entirely).
 */
function buildWooStockPayloadFields(quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) {
    return null;
  }
  return {
    manage_stock: true,
    stock_quantity: qty,
    stock_status: qty > 0 ? "instock" : "outofstock",
  };
}

function applyWooStockToPayload(payload, integration, quantity, mode) {
  const allowStock =
    mode === "create" ||
    isIntegrationSyncEnabled(integration, "sync_product_stock");
  if (!allowStock) {
    return;
  }
  const stockFields = buildWooStockPayloadFields(quantity);
  if (stockFields) {
    Object.assign(payload, stockFields);
  }
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

/**
 * Split a POS variation label into its positional attribute values.
 * POS builds labels like "large - Red" (UI) or "NAVY-L" (WooCommerce import).
 * Prefer the spaced " - " separator when present so multi-word / dashed values
 * (e.g. "extra-large") stay intact; otherwise fall back to a plain "-".
 */
function parsePosVariationValues(child, parentSku) {
  const label = parsePosVariationLabel(child, parentSku);
  if (!label) {
    return [];
  }
  const parts =
    label.includes(" - ") ? label.split(" - ") : label.split("-");
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Build the attribute plan for a variable product from its POS children.
 *
 * POS does not persist structured attribute data on products/variations — the
 * only signal is the positional values embedded in each child name. This derives
 * the parent-level `attributes` array (with `variation: true`) that WooCommerce
 * needs to render variation dropdowns, plus the per-child attribute selections.
 *
 * @param {Array} children POS variation child products.
 * @param {string} parentSku Parent SKU used as a label fallback.
 * @param {Array<string|null>} positionNames Resolved attribute name per position
 *   (e.g. ["Size", "Colors"]). Missing entries fall back to "Attribute N".
 */
function buildWooVariableAttributePlan(children, parentSku, positionNames = []) {
  const rows = (Array.isArray(children) ? children : []).map((child) => ({
    child,
    values: parsePosVariationValues(child, parentSku),
  }));

  const positionCount = rows.reduce(
    (max, row) => Math.max(max, row.values.length),
    0,
  );

  const names = [];
  const optionsByPosition = [];
  const seenByPosition = [];
  for (let i = 0; i < positionCount; i += 1) {
    const resolved = positionNames?.[i] && String(positionNames[i]).trim();
    names[i] = resolved || `Attribute ${i + 1}`;
    optionsByPosition[i] = [];
    seenByPosition[i] = new Set();
  }

  for (const row of rows) {
    row.values.forEach((value, i) => {
      const key = value.toLowerCase();
      if (!seenByPosition[i].has(key)) {
        seenByPosition[i].add(key);
        optionsByPosition[i].push(value);
      }
    });
  }

  const parentAttributes = names.map((name, i) => ({
    name,
    position: i,
    visible: true,
    variation: true,
    options: optionsByPosition[i],
  }));

  const childAttributesById = new Map();
  for (const row of rows) {
    const attrs = row.values
      .map((value, i) => ({ name: names[i], option: value }))
      .filter((attr) => attr.name && attr.option);
    childAttributesById.set(String(row.child?._id), attrs);
  }

  return { parentAttributes, childAttributesById };
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
    payload.regular_price = resolveSyncProductPrice(
      child,
      options.syncRow ?? options.syncPrice,
    );
  }

  if (allowStatus) {
    payload.status = mapPosStatusToWoo(child?.status);
  }

  if (child?.weight !== undefined && child?.weight !== null) {
    payload.weight = String(child.weight);
  }

  applyWooStockToPayload(payload, integration, options.stockQuantity, mode);

  // Prefer attributes derived from the POS attribute plan (works even when the
  // WooCommerce parent has no attributes yet); fall back to matching the label
  // against the remote parent's existing attributes.
  const planAttributes =
    Array.isArray(options.variationAttributes) ?
      options.variationAttributes.filter((attr) => attr?.name && attr?.option)
    : [];
  if (planAttributes.length) {
    payload.attributes = planAttributes;
  } else {
    const label = parsePosVariationLabel(child, parentSku);
    const variationAttributes = mapLabelToWooVariationAttributes(
      label,
      remoteParent?.attributes,
    );
    if (variationAttributes.length) {
      payload.attributes = variationAttributes;
    }
  }

  return payload;
}

module.exports = {
  SYNC_TOGGLE_KEYS,
  isIntegrationSyncEnabled,
  resolvePosProductSku,
  resolvePublicAssetUrl,
  resolveSyncProductPrice,
  buildWooCommerceProductSyncPayload,
  buildWooCommerceVariationSyncPayload,
  buildShopifyProductSyncPayload,
  buildShopifyVariantSyncPayload,
  hasSyncPayloadFields,
  buildWooStockPayloadFields,
  parsePosVariationLabel,
  parsePosVariationValues,
  buildWooVariableAttributePlan,
  mapLabelToWooVariationAttributes,
};

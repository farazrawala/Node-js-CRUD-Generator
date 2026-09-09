const fs = require("fs");
const path = require("path");
const { categorySlugFromName } = require("./processHelpers");
const { toPublicUploadUrl } = require("./basePath");

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
    (typeof product?.product_code === "string" &&
      product.product_code.trim()) ||
    (product?._id ? String(product._id) : "")
  );
}

function resolvePublicAssetUrl(assetPath, req = null) {
  return toPublicUploadUrl(assetPath, req);
}

function collectPosProductImagePaths(product) {
  const paths = [];
  const seen = new Set();
  const add = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    paths.push(trimmed);
  };
  add(product?.product_image);
  if (Array.isArray(product?.multi_images)) {
    product.multi_images.forEach(add);
  }
  return paths;
}

function resolveUploadFileOnDisk(assetPath) {
  const raw = String(assetPath || "")
    .trim()
    .replace(/\\/g, "/");
  if (!raw) return null;

  let relative = raw;
  if (/^https?:\/\//i.test(raw)) {
    const marker = raw.toLowerCase().indexOf("/uploads/");
    if (marker < 0) return null;
    relative = raw.slice(marker + 1);
  } else {
    relative = raw.replace(/^\/+/, "");
  }

  if (!relative.startsWith("uploads/") || relative.includes("..")) {
    return null;
  }

  const abs = path.join(__dirname, "..", ...relative.split("/"));
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  } catch {
    return null;
  }
  return null;
}

/**
 * Shopify fetches `src` from its servers (localhost /api/uploads URLs fail)
 * and PUT product.images appends instead of replacing the featured image.
 * Prefer the local POS file as a base64 attachment so the store gets the
 * same image the POS shows.
 */
function buildShopifyImageResource(assetPath) {
  const abs = resolveUploadFileOnDisk(assetPath);
  if (abs) {
    const filename = path.basename(abs) || "product.jpg";
    return {
      attachment: fs.readFileSync(abs).toString("base64"),
      filename,
    };
  }
  const src = resolvePublicAssetUrl(assetPath);
  return src ? { src } : null;
}

function buildShopifyImageResources(product) {
  return collectPosProductImagePaths(product)
    .map(buildShopifyImageResource)
    .filter(Boolean);
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

function buildWooCommerceProductSyncPayload(
  product,
  integration,
  options = {},
) {
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
  // Images are uploaded separately (attachment + replace). Shopify PUT
  // `product.images` appends and keeps the old featured image.

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

  const variantPayload = {
    inventory_management: "shopify",
  };

  if (allowPrice) {
    variantPayload.price = resolveSyncProductPrice(
      product,
      options.syncRow ?? options.syncPrice,
    );
  }

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
  return (
    payload && typeof payload === "object" && Object.keys(payload).length > 0
  );
}

/**
 * Build WooCommerce stock fields from a POS on-hand quantity. Returns null when
 * the quantity isn't a finite number (so callers can skip stock entirely).
 *
 * WooCommerce REST API validates `stock_quantity` as integer — decimals like
 * 150.8 fail with "Invalid parameter(s): stock_quantity". Floor so the store
 * never shows more stock than POS on-hand; negatives become 0 (outofstock).
 */
function buildWooStockPayloadFields(quantity) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) {
    return null;
  }
  const stockQty = Math.max(0, Math.floor(qty));
  return {
    manage_stock: true,
    stock_quantity: stockQty,
    stock_status: stockQty > 0 ? "instock" : "outofstock",
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
  const parts = label.includes(" - ") ? label.split(" - ") : label.split("-");
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
function buildWooVariableAttributePlan(
  children,
  parentSku,
  positionNames = [],
) {
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

/**
 * POS stores labels like "LARGE - BLUE"; Shopify variant names should be
 * `large-blue` / `large-red` (one option value, not size + color).
 */
function formatShopifyVariantOptionValue(label, fallback = "") {
  const raw = String(label || fallback || "").trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Shopify REST options + per-child option1 from the full POS variation label.
 * Unlabeled children fall back to SKU / name so every child still becomes a variant.
 */
function buildShopifyVariableOptionPlan(
  children,
  parentSku,
  _positionNames = [],
) {
  const list = Array.isArray(children) ? children : [];
  const rows = list.map((child, index) => {
    const label = parsePosVariationLabel(child, parentSku);
    const fallback =
      resolvePosProductSku(child) ||
      String(child?.product_name || "").trim() ||
      `Variant ${index + 1}`;
    const value =
      formatShopifyVariantOptionValue(label, fallback) ||
      formatShopifyVariantOptionValue(fallback) ||
      `variant-${index + 1}`;
    return { child, values: [value] };
  });

  const usedCombo = new Set();
  for (const row of rows) {
    let combo = row.values[0];
    if (usedCombo.has(combo)) {
      const sku =
        resolvePosProductSku(row.child) || String(row.child?._id || "");
      const suffix = formatShopifyVariantOptionValue(sku) || String(row.child?._id || "");
      row.values[0] = `${combo}-${suffix}`.replace(/-+/g, "-");
      combo = row.values[0];
    }
    usedCombo.add(combo);
  }

  const values = [];
  const seen = new Set();
  for (const row of rows) {
    const value = row.values[0];
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }

  const options = [{ name: "Title", values }];
  const variantOptionsByChildId = new Map();
  for (const row of rows) {
    variantOptionsByChildId.set(String(row.child?._id), {
      option1: row.values[0],
    });
  }

  return { options, variantOptionsByChildId };
}

async function resolveVariationAttributePositionNames(
  children,
  parentSku,
  companyId,
) {
  const valueRows = (Array.isArray(children) ? children : []).map((child) =>
    parsePosVariationValues(child, parentSku),
  );
  const positionCount = valueRows.reduce(
    (max, values) => Math.max(max, values.length),
    0,
  );
  if (!positionCount) {
    return [];
  }

  const valueSetsByPosition = [];
  for (let i = 0; i < positionCount; i += 1) {
    const set = new Set();
    for (const values of valueRows) {
      if (values[i]) {
        set.add(values[i].toLowerCase());
      }
    }
    valueSetsByPosition.push(set);
  }

  let attributeDefs = [];
  try {
    const Attribute = require("../models/attribute");
    const attributes = await Attribute.find({
      company_id: companyId,
      deletedAt: null,
    }).lean();
    attributeDefs = attributes.map((attr) => ({
      name: attr?.name,
      values: new Set(
        (attr?.attribute_values || [])
          .map((value) => String(value?.name || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    }));
  } catch (error) {
    console.warn(
      "Failed to load attribute definitions for variation sync:",
      error?.message,
    );
    attributeDefs = [];
  }

  return valueSetsByPosition.map((valueSet) => {
    const values = [...valueSet];
    if (!values.length) {
      return null;
    }
    let bestName = null;
    let bestScore = -1;
    for (const def of attributeDefs) {
      if (!def.name || !def.values.size) {
        continue;
      }
      const covered = values.filter((value) => def.values.has(value)).length;
      if (covered !== values.length) {
        continue;
      }
      const score = 1000 - (def.values.size - covered);
      if (score > bestScore) {
        bestScore = score;
        bestName = def.name;
      }
    }
    return bestName;
  });
}

function mapLabelToWooVariationAttributes(label, remoteParentAttributes) {
  const parts = String(label || "")
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return [];
  }

  const attrs =
    Array.isArray(remoteParentAttributes) ? remoteParentAttributes : [];
  const matched = [];
  const usedParts = new Set();

  for (const remoteAttr of attrs) {
    const options =
      Array.isArray(remoteAttr?.options) ? remoteAttr.options : [];
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
  buildShopifyImageResources,
  buildShopifyVariantSyncPayload,
  hasSyncPayloadFields,
  buildWooStockPayloadFields,
  parsePosVariationLabel,
  parsePosVariationValues,
  formatShopifyVariantOptionValue,
  buildWooVariableAttributePlan,
  buildShopifyVariableOptionPlan,
  resolveVariationAttributePositionNames,
  mapLabelToWooVariationAttributes,
};

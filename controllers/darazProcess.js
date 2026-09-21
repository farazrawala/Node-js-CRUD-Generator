/**
 * Daraz Pakistan process handlers (same actions as woocommerceProcess / shopifyProcess).
 * REST host is always https://api.daraz.pk/rest — signed with HMAC-SHA256.
 * Price/stock updates use /product/price_quantity/update (not /product/price/sell/update).
 */
const {
  extractDarazImageUrls,
  syncFetchProductImages,
} = require("../utils/fetchProductImages");
const { resolveFetchProductBarcode } = require("../utils/fetchProductBarcode");
const Category = require("../models/category");
const Brand = require("../models/brands");
const Product = require("../models/product");
const OrderItem = require("../models/order_item");
const { recordOrderStatusUpdate } = require("../utils/orderStatusHistory");
const SyncProduct = require("../models/sync_product");
const SyncCategory = require("../models/sync_category");
const SyncBrand = require("../models/sync_brand");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  upsertSyncProductMapping,
  findPosProductBySyncReference,
  resolveBatchPagination,
  resolveLatestOrderBatchLimit,
  findExistingCategory,
  findExistingBrand,
  findExistingProduct,
  findExistingProductBySku,
  finishFetchCategoryBatch,
  finishFetchBrandBatch,
  finishFetchProductBatch,
  finishFetchOrderBatch,
  finishFetchLatestOrderBatch,
  failFetchCategoryBatch,
  failFetchBrandBatch,
  failFetchProductBatch,
  failFetchOrderBatch,
  markProcessOutcome,
  coalesceObjectId,
  orderExternalRef,
  findExistingImportedOrder,
  createImportedPosOrderOrGetExisting,
  resolveIntegrationOrderId,
  buildPosOrderLineItemsFromRemote,
  backfillPosOrderLinesIfEmpty,
  resolveFetchOrderImportStatus,
  mapDarazOrderStatus,
  resolveOrderWebsiteStatus,
  createFetchOrderStats,
  createPullOrderStats,
  recordOrderSkip,
  formatFetchOrderBatchRemarks,
  formatFetchLatestOrderRemarks,
  formatPullOrderBatchRemarks,
  logFetchOrderBatchFailed,
  findOrCreatePosCustomerFromBilling,
  mapRemoteOrderAddressFields,
  isIncompleteOrderAddress,
  applyIncompleteAddressTagIfNeeded,
  remoteOrderCustomerNote,
  resolveSyncStockTotals,
  syncStockQuantity,
  formatSyncStockFieldRemark,
  updatePosOrderFromRemote,
  resolveCompanyDefaultCashAccountId,
  resolveRemoteOrderIdFromPosOrder,
  finishPullOrderBatch,
  failPullOrderBatch,
  resolvePosOrderTrackingForPush,
} = require("../utils/processHelpers");
const {
  resolvePosProductSku,
  resolveSyncProductPrice,
  formatProductSyncFieldRemarks,
  isIntegrationSyncEnabled,
  resolvePublicAssetUrl,
  resolveUploadFileOnDisk,
} = require("../utils/integrationProductSync");
const {
  trimCredential,
  callDarazRest,
  callDarazImageUpload,
  darazResultData,
} = require("../utils/darazTokenRefresh");
const path = require("path");

function toPlainIntegration(integration) {
  if (!integration) return null;
  if (typeof integration.toObject === "function") {
    return integration.toObject();
  }
  return { ...integration };
}

function validateDarazIntegration(integration, res) {
  const storeType = String(integration?.store_type || "").toLowerCase();
  if (storeType !== "daraz") {
    res.status(400).json({
      success: false,
      message: `Daraz process handlers require store_type=daraz (got ${integration?.store_type || "n/a"}).`,
    });
    return false;
  }
  return true;
}

function buildDarazClient(integration) {
  const row = toPlainIntegration(integration) || {};
  const appKey = trimCredential(row.key);
  const appSecret = trimCredential(row.secret);
  const accessToken = trimCredential(row.token);

  if (!appKey || !appSecret) {
    return {
      error:
        "Incomplete Daraz credentials. Set integration.key (app_key) and integration.secret (app_secret).",
    };
  }
  if (!accessToken) {
    return {
      error:
        "Daraz access token is missing. Click Generate Token, authorize the seller, then retry.",
    };
  }

  async function call(apiPath, apiParams = {}) {
    const result = await callDarazRest({
      apiPath,
      appKey,
      appSecret,
      apiParams: { access_token: accessToken, ...apiParams },
    });
    return darazResultData(result);
  }

  return { client: { call, appKey, appSecret, accessToken } };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function flattenDarazCategoryTree(nodes, parentId = null, acc = []) {
  for (const node of asArray(nodes)) {
    const categoryId = node?.category_id ?? node?.categoryId ?? node?.id;
    if (categoryId == null) continue;
    acc.push({
      category_id: String(categoryId),
      name: String(node?.name || node?.var || "").trim(),
      leaf: Boolean(node?.leaf),
      parent_id: parentId,
    });
    if (node?.children) {
      flattenDarazCategoryTree(node.children, String(categoryId), acc);
    }
  }
  return acc;
}

function isDarazCategoryId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function normalizeDarazCategoryName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function firstDarazLeafUnder(nodes, parentId) {
  const children = (nodes || []).filter(
    (node) => String(node.parent_id || "") === String(parentId || ""),
  );
  for (const child of children) {
    if (child.leaf) return child;
    const nested = firstDarazLeafUnder(nodes, child.category_id);
    if (nested) return nested;
  }
  return null;
}

function findDarazLeafForName(nodes, name) {
  const target = normalizeDarazCategoryName(name);
  if (!target || !nodes?.length) return null;

  const exactLeaf = nodes.find(
    (node) =>
      node.leaf && normalizeDarazCategoryName(node.name) === target,
  );
  if (exactLeaf) return exactLeaf;

  const exact = nodes.find(
    (node) => normalizeDarazCategoryName(node.name) === target,
  );
  if (exact) {
    if (exact.leaf) return exact;
    return firstDarazLeafUnder(nodes, exact.category_id);
  }

  if (target.length < 4) return null;
  const partial = nodes.filter((node) => {
    const nname = normalizeDarazCategoryName(node.name);
    return nname.includes(target) || target.includes(nname);
  });
  const partialLeaf = partial.find((node) => node.leaf);
  if (partialLeaf) return partialLeaf;
  if (partial[0]) {
    if (partial[0].leaf) return partial[0];
    return firstDarazLeafUnder(nodes, partial[0].category_id);
  }
  return null;
}

async function loadDarazCategoryTree(client) {
  if (client?._darazCategoryTree) return client._darazCategoryTree;
  const data = await client.call("/category/tree/get", {});
  const tree = data?.category_list || data?.data || data;
  const all = flattenDarazCategoryTree(tree);
  if (client) client._darazCategoryTree = all;
  return all;
}

function darazProductName(remote) {
  return String(
    remote?.attributes?.name ||
      remote?.name ||
      remote?.product_name ||
      "",
  ).trim();
}

function darazSellerSku(sku) {
  return String(
    sku?.SellerSku || sku?.seller_sku || sku?.shop_sku || sku?.SkuId || "",
  ).trim();
}

function darazSkuPrice(sku) {
  const sale = Number(sku?.salePrice ?? sku?.SalePrice);
  if (Number.isFinite(sale) && sale > 0) return sale;
  const price = Number(sku?.price ?? sku?.Price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function darazSkuQty(sku) {
  const qty = Number(sku?.quantity ?? sku?.Quantity ?? sku?.sellableStock);
  return Number.isFinite(qty) ? qty : 0;
}

function darazItemId(remote) {
  const id = remote?.item_id ?? remote?.itemId ?? remote?.product_id;
  return id != null && String(id).trim() ? String(id).trim() : "";
}

function darazSkus(remote) {
  const raw = remote?.skus || remote?.Skus || remote?.sku || [];
  return asArray(raw);
}

async function recordProductSyncMapping(
  process,
  companyId,
  posProductId,
  websiteProductId,
  stats,
) {
  const row = await upsertSyncProductMapping({
    productId: posProductId,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId: websiteProductId,
    createdBy: process.created_by?._id || process.created_by,
  });
  if (row && stats) {
    stats.sync_product_mapped = (stats.sync_product_mapped || 0) + 1;
  }
  return row;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlCdata(value) {
  return String(value ?? "").replace(/]]>/g, "]]&gt;");
}

function parseDarazSyncRef(referenceId) {
  const raw = String(referenceId || "").trim();
  if (!raw) return { itemId: "", skuId: "" };
  if (raw.includes(":")) {
    const [itemId, skuId] = raw.split(":");
    return {
      itemId: String(itemId || "").trim(),
      skuId: String(skuId || "").trim(),
    };
  }
  return { itemId: raw, skuId: "" };
}

function darazStockSyncEnabled(integration) {
  if (
    integration?.sync_product_quantity != null &&
    String(integration.sync_product_quantity).trim() !== ""
  ) {
    return isIntegrationSyncEnabled(integration, "sync_product_quantity");
  }
  return isIntegrationSyncEnabled(integration, "sync_product_stock");
}

function posProductDescription(product) {
  return String(product?.product_description || product?.product_name || "").trim();
}

function collectDarazImageUrls(product) {
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
  const out = [];
  for (const asset of paths) {
    addToList(out, asset);
    if (!/^https?:\/\//i.test(asset)) {
      addToList(out, resolvePublicAssetUrl(asset));
    }
  }
  return out;
}

function addToList(list, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || list.includes(trimmed)) return;
  list.push(trimmed);
}

function isDarazHostedImage(url) {
  return /slatic\.net|lazcdn\.com|daraz\.(pk|com)/i.test(String(url || ""));
}

function darazMigratedImageUrl(data) {
  return String(
    data?.image?.url ||
      data?.image?.Url ||
      data?.image?.url_online ||
      (typeof data?.image === "string" ? data.image : "") ||
      data?.url ||
      data?.image_url ||
      "",
  ).trim();
}

function darazImageMigratePayload(url) {
  return `<?xml version="1.0" encoding="UTF-8"?><Request><Image><Url>${xmlEscape(url)}</Url></Image></Request>`;
}

function isUnreachableDarazSourceUrl(url) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|via\.placeholder/i.test(
    String(url || ""),
  );
}

async function prepareDarazImageUpload(abs) {
  const sharp = require("sharp");
  const maxBytes = 900 * 1024;
  let buffer = await sharp(abs)
    .resize(800, 800, { fit: "inside", withoutEnlargement: false })
    .jpeg({ quality: 85 })
    .toBuffer();
  if (buffer.length > maxBytes) {
    buffer = await sharp(buffer).jpeg({ quality: 70 }).toBuffer();
  }
  const filename = `${path.basename(abs, path.extname(abs)) || "product"}.jpg`;
  return { buffer, filename };
}

async function buildDarazPlaceholderImageBuffer() {
  const sharp = require("sharp");
  return sharp({
    create: {
      width: 800,
      height: 800,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function uploadDarazPlaceholderImage(client) {
  if (!client?.appKey || !client?.appSecret || !client?.accessToken) return "";
  const buffer = await buildDarazPlaceholderImageBuffer();
  const data = await callDarazImageUpload({
    appKey: client.appKey,
    appSecret: client.appSecret,
    accessToken: client.accessToken,
    fileBuffer: buffer,
    filename: "placeholder.jpg",
  });
  return darazMigratedImageUrl(data);
}

async function uploadLocalDarazImage(client, asset) {
  if (!client?.appKey || !client?.appSecret || !client?.accessToken) return "";
  const abs = resolveUploadFileOnDisk(asset);
  if (!abs) return "";
  const { buffer, filename } = await prepareDarazImageUpload(abs);
  const data = await callDarazImageUpload({
    appKey: client.appKey,
    appSecret: client.appSecret,
    accessToken: client.accessToken,
    fileBuffer: buffer,
    filename,
  });
  return darazMigratedImageUrl(data);
}

async function migrateDarazImages(client, urls) {
  const migrated = [];
  for (const url of urls.slice(0, 8)) {
    if (isDarazHostedImage(url)) {
      migrated.push(url);
      continue;
    }

    try {
      const uploaded = await uploadLocalDarazImage(client, url);
      if (uploaded) {
        migrated.push(uploaded);
        continue;
      }
    } catch (err) {
      console.warn(`Daraz image/upload failed for ${url}:`, err?.message || err);
    }

    if (!/^https?:\/\//i.test(url) || isUnreachableDarazSourceUrl(url)) {
      console.warn(`Skip Daraz image/migrate for unreachable URL ${url}`);
      continue;
    }

    try {
      let data = await client.call("/image/migrate", {
        payload: darazImageMigratePayload(url),
      });
      if (!data?.image && url) {
        data = await client.call("/image/migrate", { url });
      }
      const hosted = darazMigratedImageUrl(data);
      if (hosted) migrated.push(hosted);
      else {
        console.warn(`Daraz image/migrate returned no URL for ${url}`);
      }
    } catch (err) {
      console.warn(
        `Daraz image/migrate failed for ${url}:`,
        err?.message || err,
      );
    }
  }
  return migrated.filter(Boolean);
}

async function resolveDarazCreateImages(client, product, companyId, options = {}) {
  const imageSyncEnabled = options.imageSyncEnabled !== false;
  if (imageSyncEnabled) {
    const images = await migrateDarazImages(
      client,
      collectDarazImageUrls(product),
    );
    if (images.length) return images;
  }
  const placeholder = await uploadDarazPlaceholderImage(client);
  return placeholder ? [placeholder] : [];
}

function isDarazAttrOn(value) {
  return (
    value === 1 ||
    value === true ||
    value === "1" ||
    String(value || "").toLowerCase() === "true"
  );
}

function darazAttrName(attr) {
  return String(attr?.name || attr?.attribute || "").trim();
}

function darazAttrInputType(attr) {
  return String(attr?.input_type || attr?.inputType || "").toLowerCase();
}

function darazAttrOptions(attr) {
  return asArray(attr?.options || attr?.options_list);
}

function darazFirstOptionName(attr) {
  const opt = darazAttrOptions(attr)[0];
  return String(opt?.name || opt?.en_name || opt?.label || "").trim();
}

function pickDarazEnumValue(attr, preferred) {
  const options = darazAttrOptions(attr)
    .map((opt) => String(opt?.name || opt?.en_name || opt?.label || "").trim())
    .filter(Boolean);
  if (!options.length) return preferred || "";
  const prefs = asArray(preferred)
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const hit = options.find((name) => prefs.includes(name.toLowerCase()));
  return hit || options[0];
}

function isDarazSkuAttribute(attr) {
  const type = String(attr?.attribute_type || attr?.attributeType || "").toLowerCase();
  return (
    type === "sku" ||
    isDarazAttrOn(attr?.is_sale_prop) ||
    isDarazAttrOn(attr?.isSaleProp)
  );
}

function isDarazMandatoryAttribute(attr) {
  return (
    isDarazAttrOn(attr?.is_mandatory) ||
    isDarazAttrOn(attr?.isMandatory) ||
    isDarazAttrOn(attr?.is_sale_prop) ||
    isDarazAttrOn(attr?.isSaleProp)
  );
}

const DARAZ_SKU_STRUCTURAL_ATTRS = new Set([
  "sellersku",
  "quantity",
  "price",
  "special_price",
  "special_from_date",
  "special_to_date",
  "package_length",
  "package_height",
  "package_width",
  "package_weight",
  "package_content",
  "images",
  "barcode_ean",
  "tax_class",
]);

const DARAZ_PRODUCT_STRUCTURAL_ATTRS = new Set([
  "name",
  "name_en",
  "title",
  "description",
  "description_en",
  "short_description",
  "short_description_en",
  "brand",
  "brand_id",
]);

function darazRichText(value) {
  const text = String(value || "").trim();
  if (!text) return "<ul><li>N/A</li></ul>";
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return `<ul><li>${xmlEscape(text)}</li></ul>`;
}

async function fetchDarazCategoryAttributes(client, categoryId) {
  const data = await client.call("/category/attributes/get", {
    primary_category_id: String(categoryId),
  });
  return asArray(
    Array.isArray(data) ? data : data?.attributes || data?.attribute || data,
  );
}

function isValidDarazAttrKey(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""));
}

function darazIntegerPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "1";
  return String(Math.round(n));
}

function sanitizeDarazSellerSku(sku) {
  const cleaned = String(sku || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 64);
}

function valueForDarazAttribute(attr, ctx) {
  const name = darazAttrName(attr);
  const input = darazAttrInputType(attr);
  if (!name || input === "img" || input === "date") return "";
  const known = ctx.known[name] ?? ctx.known[name.toLowerCase()];
  if (
    input.includes("select") ||
    input.includes("enum") ||
    input === "multiselect"
  ) {
    return pickDarazEnumValue(attr, known);
  }
  if (known != null && String(known).trim() !== "") return String(known);
  if (input === "numeric") return "1";
  if (input === "richtext") return ctx.richText;
  if (name === "model") return ctx.model || ctx.sku || "";
  if (/^(name|title|name_en)$/i.test(name)) return ctx.name || ctx.sku || "";
  return "";
}

function buildDarazAttributeObject(attrs, ctx, skuLevel) {
  const out = {};
  for (const attr of attrs || []) {
    const name = darazAttrName(attr);
    if (!name || !isValidDarazAttrKey(name)) continue;
    const key = name.toLowerCase();
    if (skuLevel) {
      if (DARAZ_SKU_STRUCTURAL_ATTRS.has(key)) continue;
      if (!(isDarazSkuAttribute(attr) && isDarazMandatoryAttribute(attr))) continue;
    } else {
      if (isDarazSkuAttribute(attr)) continue;
      if (DARAZ_PRODUCT_STRUCTURAL_ATTRS.has(key)) continue;
      if (!isDarazMandatoryAttribute(attr)) continue;
    }
    const value = valueForDarazAttribute(attr, ctx);
    if (value) out[name] = value;
  }
  return out;
}

function buildDarazAttributeXml(attrs, ctx, skuLevel) {
  const obj = buildDarazAttributeObject(attrs, ctx, skuLevel);
  return Object.entries(obj)
    .map(([name, value]) => `        <${name}>${xmlEscape(value)}</${name}>`)
    .join("\n");
}

function buildDarazProductCreatePayload({
  primaryCategory,
  name,
  description,
  brand,
  extraAttributes,
  extraSkuAttributes,
  images,
  skus,
}) {
  const imageList = (images || []).filter(Boolean);
  const skuList = (skus || []).map((sku) => {
    const sellerSku =
      sanitizeDarazSellerSku(sku.sellerSku) || sanitizeDarazSellerSku(name) || "SKU";
    const price = Number(sku.price);
    const quantity = Number(sku.quantity);
    return {
      SellerSku: sellerSku,
      quantity: String(Number.isFinite(quantity) && quantity >= 0 ? quantity : 0),
      price: darazIntegerPrice(sku.price),
      package_length: "10",
      package_height: "10",
      package_width: "10",
      package_weight: "1",
      package_content: String(sku.packageContent || sellerSku),
      ...(extraSkuAttributes || {}),
      Images: { Image: imageList },
    };
  });
  const highlights = String(description || name || "").replace(/<[^>]+>/g, " ").trim().slice(0, 255);
  return {
    Request: {
      Product: {
        PrimaryCategory: String(primaryCategory),
        Images: { Image: imageList },
        Attributes: {
          name: String(name || sellerNameFallback(skus)),
          name_en: String(name || sellerNameFallback(skus)),
          title: String(name || sellerNameFallback(skus)),
          description: String(description || name || ""),
          description_en: darazRichText(description || name),
          short_description: highlights || String(name || ""),
          short_description_en: highlights || String(name || ""),
          brand: String(brand || "No Brand"),
          ...(extraAttributes || {}),
        },
        Skus: { Sku: skuList },
      },
    },
  };
}

function sellerNameFallback(skus) {
  return sanitizeDarazSellerSku(skus?.[0]?.sellerSku) || "Product";
}

function buildDarazSkuXml(sku, extraSkuXml = "", images = []) {
  const price = Number(sku.price);
  const quantity = Number(sku.quantity);
  const imageXml = (images || [])
    .map((url) => `            <Image>${xmlEscape(url)}</Image>`)
    .join("\n");
  return `        <Sku>
          <SellerSku>${xmlEscape(sku.sellerSku)}</SellerSku>
          <quantity>${xmlEscape(Number.isFinite(quantity) && quantity >= 0 ? quantity : 0)}</quantity>
          <price>${xmlEscape(darazIntegerPrice(sku.price))}</price>
          <package_length>10</package_length>
          <package_height>10</package_height>
          <package_width>10</package_width>
          <package_weight>1</package_weight>
          <package_content>${xmlEscape(sku.packageContent || sku.sellerSku)}</package_content>
${extraSkuXml}
          <Images>
${imageXml}
          </Images>
        </Sku>`;
}

function buildDarazProductCreateXml({
  primaryCategory,
  name,
  description,
  brand,
  extraAttributeXml,
  extraSkuXml,
  images,
  skus,
}) {
  const imageXml = (images || [])
    .map((url) => `        <Image>${xmlEscape(url)}</Image>`)
    .join("\n");
  const skuXml = (skus || [])
    .map((sku) => buildDarazSkuXml(sku, extraSkuXml, images))
    .join("\n");
  const highlights = darazRichText(String(description || name).slice(0, 255));
  const body = darazRichText(description || name);
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <PrimaryCategory>${xmlEscape(primaryCategory)}</PrimaryCategory>
    <Images>
${imageXml}
    </Images>
    <Attributes>
      <name>${xmlEscape(name)}</name>
      <name_en>${xmlEscape(name)}</name_en>
      <title>${xmlEscape(name)}</title>
      <description><![CDATA[${xmlCdata(body)}]]></description>
      <short_description>${xmlEscape(String(description || name || "").replace(/<[^>]+>/g, " ").trim().slice(0, 255) || name)}</short_description>
      <short_description_en>${xmlEscape(String(description || name || "").replace(/<[^>]+>/g, " ").trim().slice(0, 255) || name)}</short_description_en>
      <description_en><![CDATA[${xmlCdata(body)}]]></description_en>
      <brand>${xmlEscape(brand || "No Brand")}</brand>
${extraAttributeXml || ""}
    </Attributes>
    <Skus>
${skuXml}
    </Skus>
  </Product>
</Request>`;
}

function normalizeDarazUpdateSkus(skus = [], fallbackImages = []) {
  return (skus || [])
    .map((sku) => {
      const sellerSku =
        sanitizeDarazSellerSku(sku.sellerSku || sku.SellerSku) ||
        String(sku.sellerSku || sku.SellerSku || "").trim();
      const skuId = String(sku.skuId || sku.SkuId || sku.sku_id || "").trim();
      if (!sellerSku && !skuId) return null;
      const quantity = Number(sku.quantity);
      return {
        sellerSku,
        skuId,
        price: darazIntegerPrice(sku.price),
        quantity: String(
          Number.isFinite(quantity) && quantity >= 0 ? quantity : 1,
        ),
        images: (sku.images || fallbackImages || []).filter(Boolean),
      };
    })
    .filter(Boolean);
}

function buildDarazProductUpdateXml({
  itemId,
  name,
  description,
  images,
  skus = [],
}) {
  const attrs = [];
  if (name) {
    attrs.push(`        <name>${xmlEscape(name)}</name>`);
    attrs.push(`        <name_en>${xmlEscape(name)}</name_en>`);
  }
  if (description) {
    const highlights = String(description || name || "")
      .replace(/<[^>]+>/g, " ")
      .trim()
      .slice(0, 255);
    const body = darazRichText(description);
    attrs.push(
      `        <short_description>${xmlEscape(highlights || name || "")}</short_description>`,
    );
    attrs.push(
      `        <description><![CDATA[${xmlCdata(body)}]]></description>`,
    );
  }
  const imageXml =
    (images || []).length ?
      `    <Images>
${images.map((url) => `      <Image>${xmlEscape(url)}</Image>`).join("\n")}
    </Images>`
    : "";
  const skuRows = normalizeDarazUpdateSkus(skus, images);
  const skuXml = skuRows
    .map((sku) => {
      const skuImageXml = sku.images.length
        ? `          <Images>
${sku.images.map((url) => `            <Image>${xmlEscape(url)}</Image>`).join("\n")}
          </Images>`
        : "          <Images></Images>";
      return `        <Sku>
          ${sku.skuId ? `<SkuId>${xmlEscape(sku.skuId)}</SkuId>` : ""}
          <SellerSku>${xmlEscape(sku.sellerSku)}</SellerSku>
          <quantity>${xmlEscape(sku.quantity)}</quantity>
          <price>${xmlEscape(sku.price)}</price>
          <package_length>10</package_length>
          <package_height>10</package_height>
          <package_width>10</package_width>
          <package_weight>1</package_weight>
${skuImageXml}
        </Sku>`;
    })
    .join("\n");
  if (!skuXml) {
    throw new Error("Daraz /product/update requires at least one Sku (SellerSku or SkuId).");
  }
  return `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <ItemId>${xmlEscape(itemId)}</ItemId>
${imageXml}
    <Attributes>
${attrs.join("\n")}
    </Attributes>
    <Skus>
${skuXml}
    </Skus>
  </Product>
</Request>`;
}

function buildDarazProductUpdatePayload({
  itemId,
  name,
  description,
  images,
  skus = [],
}) {
  const skuRows = normalizeDarazUpdateSkus(skus, images);
  if (!skuRows.length) {
    throw new Error("Daraz /product/update requires at least one Sku (SellerSku or SkuId).");
  }
  const attributes = {};
  if (name) {
    attributes.name = name;
    attributes.name_en = name;
  }
  if (description) {
    attributes.short_description = String(description)
      .replace(/<[^>]+>/g, " ")
      .trim()
      .slice(0, 255);
    attributes.description = darazRichText(description);
  }
  return {
    Request: {
      Product: {
        ItemId: String(itemId),
        ...(images?.length ? { Images: { Image: images } } : {}),
        Attributes: attributes,
        Skus: {
          Sku: skuRows.map((sku) => ({
            ...(sku.skuId ? { SkuId: sku.skuId } : {}),
            SellerSku: sku.sellerSku,
            quantity: sku.quantity,
            price: sku.price,
            package_length: "10",
            package_height: "10",
            package_width: "10",
            package_weight: "1",
            ...(sku.images.length ? { Images: { Image: sku.images } } : {}),
          })),
        },
      },
    },
  };
}

async function rememberDarazCategoryMapping(
  process,
  companyId,
  posCategoryId,
  remoteId,
) {
  if (!process || !posCategoryId || !isDarazCategoryId(remoteId)) return;
  try {
    await recordCategorySyncMapping(
      process,
      companyId,
      posCategoryId,
      remoteId,
    );
  } catch (err) {
    console.warn(
      `Daraz category mapping ${posCategoryId} → ${remoteId} failed:`,
      err?.message || err,
    );
  }
}

async function resolveDarazPrimaryCategoryId(
  product,
  integrationId,
  companyId,
  { client, process } = {},
) {
  const cats = Array.isArray(product?.category_id)
    ? product.category_id
    : product?.category_id
      ? [product.category_id]
      : [];
  const ids = cats.map(coalesceObjectId).filter(Boolean);
  const posCategories = ids.length
    ? await Category.find({
        _id: { $in: ids },
        deletedAt: null,
      })
        .select("name slug")
        .lean()
    : [];

  if (ids.length) {
    const mapped = await SyncCategory.find({
      category_id: { $in: ids },
      integration_id: integrationId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    }).lean();
    for (const row of mapped) {
      const ref = String(row?.refference_id || "")
        .replace(/^daraz-/i, "")
        .trim();
      if (isDarazCategoryId(ref)) return ref;
    }
  }

  for (const cat of posCategories) {
    const fromSlug = String(cat.slug || "")
      .replace(/^daraz-/i, "")
      .trim();
    if (isDarazCategoryId(fromSlug)) {
      await rememberDarazCategoryMapping(
        process,
        companyId,
        cat._id,
        fromSlug,
      );
      return fromSlug;
    }
  }

  if (posCategories.length) {
    const allMaps = await SyncCategory.find({
      integration_id: integrationId,
      company_id: companyId,
      status: "active",
      deletedAt: null,
    }).lean();
    if (allMaps.length) {
      const mappedCats = await Category.find({
        _id: { $in: allMaps.map((row) => row.category_id).filter(Boolean) },
        deletedAt: null,
      })
        .select("name")
        .lean();
      const byName = new Map(
        mappedCats.map((row) => [
          normalizeDarazCategoryName(row.name),
          String(row._id),
        ]),
      );
      for (const cat of posCategories) {
        const mappedId = byName.get(normalizeDarazCategoryName(cat.name));
        if (!mappedId) continue;
        const row = allMaps.find(
          (item) => String(item.category_id) === mappedId,
        );
        const ref = String(row?.refference_id || "")
          .replace(/^daraz-/i, "")
          .trim();
        if (!isDarazCategoryId(ref)) continue;
        await rememberDarazCategoryMapping(process, companyId, cat._id, ref);
        return ref;
      }
    }
  }

  if (client && posCategories.length) {
    try {
      const tree = await loadDarazCategoryTree(client);
      for (const cat of posCategories) {
        const node = findDarazLeafForName(tree, cat.name);
        const remoteId = String(node?.category_id || "").trim();
        if (!isDarazCategoryId(remoteId)) continue;
        await rememberDarazCategoryMapping(
          process,
          companyId,
          cat._id,
          remoteId,
        );
        return remoteId;
      }
    } catch (err) {
      console.warn(
        "Daraz category tree lookup failed:",
        err?.message || err,
      );
    }
  }

  if (client) {
    try {
      const mapped = await SyncCategory.findOne({
        integration_id: integrationId,
        company_id: companyId,
        status: "active",
        deletedAt: null,
        refference_id: { $nin: [null, ""] },
      })
        .sort({ updatedAt: -1 })
        .lean();
      const mappedRef = String(mapped?.refference_id || "")
        .replace(/^daraz-/i, "")
        .trim();
      if (isDarazCategoryId(mappedRef)) return mappedRef;
    } catch (err) {
      console.warn(
        "Daraz uncategorized product mapping lookup failed:",
        err?.message || err,
      );
    }

    try {
      const tree = await loadDarazCategoryTree(client);
      const fromName = findDarazLeafForName(tree, product?.product_name);
      const fromNameId = String(fromName?.category_id || "").trim();
      if (isDarazCategoryId(fromNameId)) return fromNameId;
      const pet = findDarazLeafForName(tree, "Pet Supplies");
      const petId = String(pet?.category_id || "").trim();
      if (isDarazCategoryId(petId)) return petId;
    } catch (err) {
      console.warn(
        "Daraz uncategorized product tree lookup failed:",
        err?.message || err,
      );
    }
  }

  return "";
}

async function resolveDarazBrandForCreate(product, integrationId, companyId) {
  const brandId = coalesceObjectId(product?.brand_id);
  let name = "No Brand";
  if (!brandId) return { brand: name };
  const brand = await Brand.findById(brandId).select("name").lean();
  if (brand?.name) name = String(brand.name).trim() || name;
  const mapped = await SyncBrand.findOne({
    brand_id: brandId,
    integration_id: integrationId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
  }).lean();
  const ref = String(mapped?.refference_id || "").trim();
  if (ref && /^\d+$/.test(ref)) {
    return { brand: name, brand_id: ref };
  }
  return { brand: name };
}

async function findDarazProductBySellerSku(client, sku, productName = "") {
  const candidates = [
    ...new Set(
      [String(sku || "").trim(), sanitizeDarazSellerSku(sku)].filter(Boolean),
    ),
  ];
  const searches = [];
  for (const candidate of candidates) {
    searches.push({
      filter: "all",
      sku_seller_list: JSON.stringify([candidate]),
    });
    searches.push({ filter: "all", search: candidate });
    searches.push({ filter: "pending", search: candidate });
  }
  const name = String(productName || "").trim();
  if (name) searches.push({ filter: "all", search: name });

  const matchesCandidate = (skuRow, candidate) => {
    const remote = darazSellerSku(skuRow);
    return (
      remote === candidate ||
      sanitizeDarazSellerSku(remote) === sanitizeDarazSellerSku(candidate)
    );
  };

  for (const params of searches) {
    try {
      const found = await client.call("/products/get", {
        ...params,
        limit: "20",
        offset: "0",
      });
      const products = asArray(found?.products || found?.product);
      const skuMatch = products.find((row) =>
        darazSkus(row).some((skuRow) =>
          candidates.some((candidate) => matchesCandidate(skuRow, candidate)),
        ),
      );
      const nameMatch =
        name &&
        products.find(
          (row) =>
            normalizeDarazCategoryName(darazProductName(row)) ===
            normalizeDarazCategoryName(name),
        );
      const match =
        skuMatch ||
        (params.sku_seller_list ? products[0] : null) ||
        nameMatch;
      if (!match) continue;
      const itemId = darazItemId(match);
      if (!itemId) continue;
      const skuRow =
        darazSkus(match).find((row) =>
          candidates.some((candidate) => matchesCandidate(row, candidate)),
        ) || darazSkus(match)[0];
      return {
        item: match,
        itemId,
        skuId: String(skuRow?.SkuId || skuRow?.sku_id || "").trim(),
      };
    } catch (err) {
      console.warn(
        "Daraz product lookup failed:",
        params,
        err?.message || err,
      );
    }
  }
  return null;
}

async function resolveDarazSyncRootProduct(product, companyId) {
  const productId = coalesceObjectId(product?._id);
  if (!productId) return { rootProduct: product };

  if (
    typeof product?.product_type === "string" &&
    product.product_type.toLowerCase() === "variable"
  ) {
    return { rootProduct: product };
  }

  const parentId = coalesceObjectId(product?.parent_product_id);
  if (!parentId || String(parentId) === String(productId)) {
    return { rootProduct: product };
  }

  const parent = await Product.findOne({
    _id: parentId,
    company_id: companyId,
    deletedAt: null,
  }).lean();

  if (
    parent &&
    typeof parent.product_type === "string" &&
    parent.product_type.toLowerCase() === "variable"
  ) {
    return { rootProduct: parent };
  }

  return { rootProduct: product };
}

async function loadPosVariationChildren(parentProductId, companyId) {
  const parentId = coalesceObjectId(parentProductId);
  if (!parentId) return [];
  return Product.find({
    company_id: companyId,
    parent_product_id: parentId,
    deletedAt: null,
    product_type: "Single",
    _id: { $ne: parentId },
  })
    .sort({ product_name: 1 })
    .lean();
}

function parseDarazCreateSkuList(created) {
  return asArray(created?.sku_list || created?.skuList || created?.skus);
}

function darazCreatedItemId(created) {
  return String(
    created?.item_id || created?.itemId || created?.product_id || "",
  ).trim();
}

function skuIdFromCreateList(skuList, sellerSku) {
  const want = sanitizeDarazSellerSku(sellerSku) || String(sellerSku || "").trim();
  const row = skuList.find((sku) => {
    const remote = darazSellerSku(sku);
    return (
      remote === sellerSku ||
      sanitizeDarazSellerSku(remote) === want
    );
  });
  return String(row?.sku_id || row?.SkuId || "").trim();
}

async function applyDarazPriceStockUpdates({
  client,
  integration,
  itemId,
  skuId,
  sellerSku,
  product,
  syncRow,
  stockMap,
  productId,
}) {
  const did = { price: false, stock: false };
  const priceOn = isIntegrationSyncEnabled(integration, "sync_product_price");
  const stockOn = darazStockSyncEnabled(integration);
  if (!itemId || (!skuId && !sellerSku) || (!priceOn && !stockOn)) return did;

  const price = Number(resolveSyncProductPrice(product, syncRow));
  const quantity = syncStockQuantity(stockMap, productId);
  const wantPrice = priceOn && Number.isFinite(price) && price > 0;
  const wantStock = stockOn && Number.isFinite(quantity) && quantity >= 0;
  if (!wantPrice && !wantStock) return did;

  const safeSku = sanitizeDarazSellerSku(sellerSku) || String(sellerSku || "").trim();
  const skuInner = [
    itemId ? `          <ItemId>${xmlEscape(itemId)}</ItemId>` : "",
    skuId ? `          <SkuId>${xmlEscape(skuId)}</SkuId>` : "",
    safeSku ? `          <SellerSku>${xmlEscape(safeSku)}</SellerSku>` : "",
    wantPrice ? `          <Price>${xmlEscape(darazIntegerPrice(price))}</Price>` : "",
    wantStock ? `          <Quantity>${xmlEscape(quantity)}</Quantity>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const priceQtyXml = `<?xml version="1.0" encoding="UTF-8" ?>
<Request>
  <Product>
    <Skus>
      <Sku>
${skuInner}
      </Sku>
    </Skus>
  </Product>
</Request>`;
  const updateXml = buildDarazProductUpdateXml({
    itemId,
    skus: [
      {
        sellerSku: safeSku,
        skuId,
        price: wantPrice ? price : undefined,
        quantity: wantStock ? quantity : undefined,
      },
    ],
  });

  const attempts = [
    ["/product/price_quantity/update", { payload: priceQtyXml }],
    ["/product/update", { payload: updateXml }],
  ];
  for (const [apiPath, params] of attempts) {
    try {
      await client.call(apiPath, params);
      did.price = wantPrice;
      did.stock = wantStock;
      return did;
    } catch (err) {
      console.warn(
        `Daraz ${apiPath} failed:`,
        err?.message || err,
      );
    }
  }
  return did;
}

async function applyDarazProductAttributeUpdate({
  client,
  integration,
  itemId,
  product,
  sellerSku,
  skuId,
  skus,
}) {
  const nameOn = isIntegrationSyncEnabled(integration, "sync_product_name");
  const descOn = isIntegrationSyncEnabled(
    integration,
    "sync_product_description",
  );
  const imageOn = isIntegrationSyncEnabled(integration, "sync_product_image");
  if (!nameOn && !descOn && !imageOn) return false;

  let images = [];
  if (imageOn) {
    images = await migrateDarazImages(client, collectDarazImageUrls(product));
  }
  if (!nameOn && !descOn && !images.length) return false;

  const skuList =
    Array.isArray(skus) && skus.length
      ? skus
      : sellerSku || skuId
        ? [{ sellerSku, skuId }]
        : [];
  if (!skuList.length) {
    const found = await findDarazProductBySellerSku(
      client,
      sellerSku || resolvePosProductSku(product),
      product?.product_name,
    ).catch(() => null);
    if (found?.itemId) {
      skuList.push({
        sellerSku: sellerSku || resolvePosProductSku(product),
        skuId: found.skuId,
      });
      if (!itemId) itemId = found.itemId;
    }
  }
  if (!skuList.length) {
    const err = new Error(
      "Daraz /product/update requires a SellerSku. Re-run sync after the listing exists.",
    );
    err.statusCode = 400;
    throw err;
  }

  const pricedSkus = skuList.map((row) => ({
    ...row,
    price: row.price ?? resolveSyncProductPrice(product),
    quantity: row.quantity,
  }));
  const xml = buildDarazProductUpdateXml({
    itemId,
    name: nameOn ? product.product_name : "",
    description: descOn ? posProductDescription(product) : "",
    images,
    skus: pricedSkus,
  });
  try {
    await client.call("/product/update", { payload: xml });
    return true;
  } catch (xmlErr) {
    const json = buildDarazProductUpdatePayload({
      itemId,
      name: nameOn ? product.product_name : "",
      description: descOn ? posProductDescription(product) : "",
      images,
      skus: pricedSkus,
    });
    try {
      await client.call("/product/update", {
        payload: JSON.stringify(json),
      });
      return true;
    } catch (jsonErr) {
      console.warn(
        "[daraz] /product/update failed; continuing without attribute update:",
        xmlErr?.message || xmlErr,
      );
      return false;
    }
  }
}

async function createDarazListing({
  client,
  integration,
  product,
  companyId,
  integrationId,
  skus,
  process,
  primaryCategoryId,
}) {
  const primaryCategory =
    (isDarazCategoryId(primaryCategoryId) && String(primaryCategoryId).trim()) ||
    (await resolveDarazPrimaryCategoryId(
      product,
      integrationId,
      companyId,
      { client, process },
    ));
  if (!primaryCategory) {
    const hasCategory =
      product?.category_id &&
      (Array.isArray(product.category_id)
        ? product.category_id.length
        : true);
    const err = new Error(
      hasCategory
        ? "Cannot create a Daraz listing: this product's POS category did not match a Daraz leaf category. Assign a Daraz marketplace category (or a POS category with the same name), then sync again."
        : "Cannot create a Daraz listing without a category. Assign a POS category that matches a Daraz leaf, then sync again.",
    );
    err.statusCode = 400;
    throw err;
  }

  const brand = await resolveDarazBrandForCreate(
    product,
    integrationId,
    companyId,
  );
  let brandName = brand.brand || "No Brand";
  try {
    const brandData = await client.call("/brands/get", {
      offset: "0",
      limit: "200",
    });
    const remoteBrands = asArray(
      brandData?.brands || brandData?.brand || (Array.isArray(brandData) ? brandData : []),
    );
    const want = normalizeDarazCategoryName(brandName);
    const hit =
      remoteBrands.find(
        (row) => normalizeDarazCategoryName(row?.name || row?.brand_name) === want,
      ) ||
      remoteBrands.find((row) =>
        /no brand/i.test(String(row?.name || row?.brand_name || "")),
      );
    if (hit?.name || hit?.brand_name) {
      brandName = String(hit.name || hit.brand_name).trim();
    }
  } catch (err) {
    console.warn("Daraz brands/get failed:", err?.message || err);
  }

  let images = [];
  try {
    images = await resolveDarazCreateImages(client, product, companyId, {
      imageSyncEnabled: isIntegrationSyncEnabled(
        integration,
        "sync_product_image",
      ),
    });
  } catch (err) {
    console.warn("Daraz image migrate failed:", err?.message || err);
  }
  if (!images.length) {
    console.warn(
      `Daraz create: no product image for "${product?.product_name || skus[0]?.sellerSku}"; continuing without one.`,
    );
  }

  let attributes = [];
  try {
    attributes = await fetchDarazCategoryAttributes(client, primaryCategory);
  } catch (err) {
    console.warn(
      `Daraz category/attributes/get failed for ${primaryCategory}:`,
      err?.message || err,
    );
  }

  const ctx = {
    name: product.product_name || skus[0]?.sellerSku,
    sku: skus[0]?.sellerSku,
    model: resolvePosProductSku(product),
    richText: darazRichText(
      posProductDescription(product) || product.product_name,
    ),
    known: {
      name: product.product_name || skus[0]?.sellerSku,
      name_en: product.product_name || skus[0]?.sellerSku,
      title: product.product_name || skus[0]?.sellerSku,
      brand: brandName,
      warranty_type: "No Warranty",
      model: resolvePosProductSku(product),
    },
  };
  const extraAttributes = buildDarazAttributeObject(attributes, ctx, false);
  const extraSkuAttributes = buildDarazAttributeObject(attributes, ctx, true);
  const payloadXml = buildDarazProductCreateXml({
    primaryCategory,
    name: product.product_name || skus[0]?.sellerSku,
    description: posProductDescription(product) || product.product_name,
    brand: brandName,
    extraAttributeXml: buildDarazAttributeXml(attributes, ctx, false),
    extraSkuXml: buildDarazAttributeXml(attributes, ctx, true),
    images,
    skus,
  });
  const payloadObj = buildDarazProductCreatePayload({
    primaryCategory,
    name: product.product_name || skus[0]?.sellerSku,
    description: posProductDescription(product) || product.product_name,
    brand: brandName,
    extraAttributes,
    extraSkuAttributes,
    images,
    skus,
  });

  try {
    return await client.call("/product/create", {
      payload: payloadXml,
    });
  } catch (xmlErr) {
    const existing = await findDarazProductBySellerSku(
      client,
      skus[0]?.sellerSku,
      product.product_name,
    ).catch(() => null);
    if (existing?.itemId) {
      console.warn(
        `[daraz] /product/create failed; using existing item ${existing.itemId}`,
        xmlErr?.message || xmlErr,
      );
      return {
        item_id: existing.itemId,
        sku_id: existing.skuId,
        existing: true,
      };
    }
    console.warn(
      "[daraz] /product/create XML failed, retrying JSON:",
      xmlErr?.message || xmlErr,
    );
    try {
      return await client.call("/product/create", {
        payload: JSON.stringify(payloadObj),
      });
    } catch (err) {
      console.error(
        "[daraz] /product/create failed",
        err?.message || err,
        payloadXml.slice(0, 4000),
      );
      throw err;
    }
  }
}

async function recordCategorySyncMapping(
  process,
  companyId,
  posCategoryId,
  websiteCategoryId,
  stats,
) {
  const row = await upsertSyncCategoryMapping({
    categoryId: posCategoryId,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId: websiteCategoryId,
    createdBy: process.created_by?._id || process.created_by,
  });
  if (row && stats) {
    stats.sync_category_mapped = (stats.sync_category_mapped || 0) + 1;
  }
  return row;
}

async function recordBrandSyncMapping(
  process,
  companyId,
  posBrandId,
  websiteBrandId,
  stats,
) {
  const row = await upsertSyncBrandMapping({
    brandId: posBrandId,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId: websiteBrandId,
    createdBy: process.created_by?._id || process.created_by,
  });
  if (row && stats) {
    stats.sync_brand_mapped = (stats.sync_brand_mapped || 0) + 1;
  }
  return row;
}

async function importDarazCategoryToPos(remote, { companyId, process, stats }) {
  const name = String(remote?.name || "").trim();
  const remoteId = String(remote?.category_id || "").trim();
  if (!name || !remoteId) {
    stats.skipped += 1;
    return null;
  }

  const slug = categorySlugFromName(name);
  const existing = await findExistingCategory(name, slug, companyId);
  let posId;
  if (existing) {
    posId = coalesceObjectId(existing._id);
    stats.skipped += 1;
  } else {
    const created = await Category.create({
      name,
      slug,
      company_id: companyId,
      status: "active",
      created_by: coalesceObjectId(process.created_by?._id || process.created_by),
    });
    posId = coalesceObjectId(created._id);
    stats.inserted += 1;
  }

  await recordCategorySyncMapping(process, companyId, posId, remoteId, stats);
  return posId;
}

async function importDarazBrandToPos(remote, { companyId, process, stats }) {
  const name = String(remote?.name || remote?.brand_name || "").trim();
  const remoteId = String(remote?.brand_id ?? remote?.brandId ?? "").trim();
  if (!name) {
    stats.skipped += 1;
    return null;
  }

  const slug = categorySlugFromName(name);
  const existing = await findExistingBrand(name, slug, companyId);
  let posId;
  if (existing) {
    posId = coalesceObjectId(existing._id);
    stats.skipped += 1;
  } else {
    const created = await Brand.create({
      name,
      slug,
      company_id: companyId,
      status: "active",
      created_by: coalesceObjectId(process.created_by?._id || process.created_by),
    });
    posId = coalesceObjectId(created._id);
    stats.inserted += 1;
  }

  if (remoteId) {
    await recordBrandSyncMapping(process, companyId, posId, remoteId, stats);
  }
  return posId;
}

async function upsertDarazProductRow({
  remote,
  skuRow,
  name,
  sku,
  productPrice,
  categoryIds,
  parentProductId,
  companyId,
  process,
  stats,
  referenceId,
  isVariation = false,
}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return null;

  const categoryField = (categoryIds || [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);

  let existing = null;
  if (referenceId) {
    existing = await findPosProductBySyncReference(
      resolveIntegrationId(process),
      companyId,
      referenceId,
    );
  }
  if (!existing && sku) {
    existing = await findExistingProductBySku(sku, companyId);
  }
  if (!existing) {
  existing = await findExistingProduct(sku, trimmedName, companyId);
  }

  const payload = {
    product_name: trimmedName,
    product_price: productPrice,
    product_description: String(
      remote?.attributes?.short_description ||
        remote?.attributes?.description ||
        "",
    ).trim(),
    product_type: isVariation || parentProductId ? "Simple" : "Simple",
    sku,
    product_code: sku,
    category_id: categoryField,
    origin_qty: darazSkuQty(skuRow),
  };
  if (parentProductId) {
    payload.parent_product_id = coalesceObjectId(parentProductId);
    payload.product_type = "Simple";
  }

  const barcode = await resolveFetchProductBarcode({
    remoteBarcode: String(skuRow?.package_content || skuRow?.SellerSku || "").trim(),
    existingProduct: existing,
    companyId,
    stats,
  });
  if (barcode && !String(existing?.barcode || "").trim()) {
    payload.barcode = barcode;
  }

  let posId;
  if (existing) {
    posId = coalesceObjectId(existing._id);
    await Product.updateOne({ _id: posId }, { $set: payload });
    if (isVariation) stats.variations_updated = (stats.variations_updated || 0) + 1;
    else stats.updated = (stats.updated || 0) + 1;
  } else {
    const created = await Product.create({
      ...payload,
      unit: "Piece",
      company_id: companyId,
      status: "active",
      created_by: coalesceObjectId(process.created_by?._id || process.created_by),
    });
    posId = coalesceObjectId(created._id);
    if (isVariation) stats.variations_inserted = (stats.variations_inserted || 0) + 1;
    else stats.inserted += 1;
  }

  if (referenceId) {
    await recordProductSyncMapping(process, companyId, posId, referenceId, stats);
  }

  const imageUrls = extractDarazImageUrls(remote);
  if (imageUrls.length) {
    await syncFetchProductImages(posId, imageUrls, existing);
  }

  if (categoryField.length) {
    stats.products_category_linked = (stats.products_category_linked || 0) + 1;
  }

  return posId;
}

async function importDarazProductToPos(remote, ctx) {
  const { companyId, process, stats, categoryIds = [] } = ctx;
  const itemId = darazItemId(remote);
  const name = darazProductName(remote);
  if (!name) {
    stats.skipped += 1;
    return null;
  }

  const skus = darazSkus(remote);
  if (skus.length > 1) {
    stats.variations_fetched = (stats.variations_fetched || 0) + skus.length;
    const parentSku = darazSellerSku(skus[0]) || (itemId ? `daraz-${itemId}` : "");
    const prices = skus.map(darazSkuPrice).filter((n) => n > 0);
    const parentPrice = prices.length ? Math.min(...prices) : 0;
    const parentPosId = await upsertDarazProductRow({
      remote,
      skuRow: skus[0],
      name,
      sku: parentSku,
      productPrice: parentPrice,
      categoryIds,
      parentProductId: null,
      companyId,
      process,
      stats,
      referenceId: itemId,
      isVariation: false,
    });
    await Product.updateOne(
      { _id: parentPosId },
      { $set: { product_type: "Variable" } },
    );

    for (const skuRow of skus) {
      const sku = darazSellerSku(skuRow);
      const skuId = String(skuRow?.SkuId || skuRow?.sku_id || "").trim();
      const variationName = [name, skuRow?.color || skuRow?.size]
        .filter(Boolean)
        .join(" / ");
      await upsertDarazProductRow({
        remote,
        skuRow,
        name: variationName || name,
        sku: sku || (skuId ? `daraz-${itemId}-${skuId}` : parentSku),
        productPrice: darazSkuPrice(skuRow),
        categoryIds,
        parentProductId: parentPosId,
        companyId,
        process,
        stats,
        referenceId: skuId ? `${itemId}:${skuId}` : itemId,
        isVariation: true,
      });
    }
    return parentPosId;
  }

  const skuRow = skus[0] || {};
  const sku = darazSellerSku(skuRow) || (itemId ? `daraz-${itemId}` : "");
  return upsertDarazProductRow({
    remote,
    skuRow,
    name,
    sku,
    productPrice: darazSkuPrice(skuRow),
    categoryIds,
    parentProductId: null,
    companyId,
    process,
    stats,
    referenceId: itemId,
    isVariation: false,
  });
}

function mapDarazAddressToBilling(addr = {}, order = {}) {
  return {
    first_name: String(addr.first_name || addr.firstName || "").trim(),
    last_name: String(addr.last_name || addr.lastName || "").trim(),
    address_1: String(addr.address1 || addr.address_1 || "").trim(),
    address_2: String(addr.address2 || addr.address_2 || "").trim(),
    city: String(addr.city || "").trim(),
    state: String(addr.address5 || addr.state || "").trim(),
    postcode: String(addr.post_code || addr.postcode || "").trim(),
    country: String(addr.country || "PK").trim(),
    email: String(order.customer_email || addr.email || "").trim(),
    phone: String(addr.phone || order.customer_phone || "").trim(),
  };
}

function normalizeDarazOrderItem(item) {
  const qty = Number(item?.quantity ?? item?.order_flag) || 1;
  const price = Number(item?.item_price ?? item?.paid_price ?? item?.price) || 0;
  return {
    product_id: item?.product_id || item?.item_id,
    sku_id: item?.sku_id || item?.SkuId,
    sku: item?.sku || item?.shop_sku || item?.SellerSku,
    name: item?.name || item?.product_name || item?.shop_sku,
    quantity: qty,
    price,
    order_item_id: item?.order_item_id,
  };
}

function normalizeDarazOrder(order, items = []) {
  const shipping = order?.address_shipping || {};
  const billing = order?.address_billing || shipping;
  const status = asArray(order?.statuses)[0] || order?.status || "";
  const lineItems = asArray(items).map(normalizeDarazOrderItem);
  const shippingAmt = Number(order?.shipping_fee ?? order?.shipping_amount) || 0;
  const voucher = Number(order?.voucher ?? order?.voucher_platform) || 0;
  return {
    ...order,
    id: order?.order_id,
    number: order?.order_number || order?.order_id,
    status,
    statuses: asArray(order?.statuses),
    total: Number(order?.price) || 0,
    shipping_total: shippingAmt,
    discount_total: voucher,
    line_items: lineItems,
    billing: mapDarazAddressToBilling(billing, order),
    shipping: mapDarazAddressToBilling(shipping, order),
    address_shipping: shipping,
    address_billing: billing,
  };
}

async function fetchDarazOrderItems(client, orderId) {
  const data = await client.call("/order/items/get", {
    order_id: String(orderId),
  });
  return asArray(data?.order_items || data?.orderItems);
}

async function fetchDarazProductDetail(client, itemId, fallback) {
  if (!itemId) return fallback;
  try {
    const data = await client.call("/product/item/get", { item_id: String(itemId) });
    return data || fallback;
  } catch (err) {
    console.warn(
      `Daraz product/item/get ${itemId} failed:`,
      err?.message || err,
    );
    return fallback;
  }
}

async function importDarazOrderToPos(remoteOrder, ctx) {
  const { companyId, process, stats, req } = ctx;
  const logCtx = { req, process, companyId };
  const integrationId = resolveIntegrationId(process);
  const remoteId = remoteOrder?.id || remoteOrder?.order_id;
  const externalRef = orderExternalRef("daraz", remoteId);
  const integrationOrderId = resolveIntegrationOrderId(
    "daraz",
    remoteOrder,
    remoteId,
  );

  if (!externalRef) {
    recordOrderSkip(
      stats,
      {
        store: "daraz",
        remote_id: remoteId,
        order_number: remoteOrder?.number,
        reason: "missing_remote_id",
        detail: "Daraz order has no order_id",
      },
      logCtx,
    );
    return;
  }

  const existing = await findExistingImportedOrder(companyId, {
    externalRef,
    integrationId,
    integrationOrderId,
  });
  if (existing) {
    const backfill = await backfillPosOrderLinesIfEmpty(
      existing,
      remoteOrder,
      "daraz",
      ctx,
    );
    if (backfill?.backfilled) {
      stats.updated = (stats.updated || 0) + 1;
      return;
    }
    recordOrderSkip(
      stats,
      {
        store: "daraz",
        remote_id: remoteId,
        order_number: remoteOrder?.number,
        reason: "already_imported",
        detail: existing.order_no ?
            `POS ${existing.order_no}`
          : `POS order ${existing._id}`,
      },
      logCtx,
    );
    return;
  }

  const {
    orderItemsPayload,
    linesSubtotal,
    linesSkipped,
    remoteBillableLines,
  } = await buildPosOrderLineItemsFromRemote(remoteOrder, "daraz", ctx);

  const billing = remoteOrder?.billing || {};
  const customerName = [billing.first_name, billing.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const customerId = await findOrCreatePosCustomerFromBilling({
    name: customerName,
    email: billing.email || "",
    phone: billing.phone || "",
    companyId,
    createdBy: process.created_by?._id || process.created_by,
  });

  const addressFields = mapRemoteOrderAddressFields(remoteOrder, "daraz");
  const orderPayload = {
    name: customerName || `Daraz #${remoteOrder?.number || remoteId}`,
    email: billing.email || "",
    phone: billing.phone || "",
    address: addressFields.address,
    city: addressFields.city,
    state: addressFields.state,
    zip: addressFields.zip,
    country: addressFields.country || "PK",
    description: externalRef,
    note: remoteOrderCustomerNote(remoteOrder, "daraz"),
    integration_order_id: integrationOrderId,
    discount: Number(remoteOrder?.discount_total) || 0,
    shipment: Number(remoteOrder?.shipping_total) || 0,
    lines_subtotal: linesSubtotal,
    amount_received: Number(remoteOrder?.total) || 0,
    order_status: resolveFetchOrderImportStatus({
      linesSkipped,
      linesInserted: orderItemsPayload.length,
      remoteBillableLines,
      remoteOrder,
      store: "daraz",
    }),
    order_type: "website",
    order_website_status: resolveOrderWebsiteStatus(remoteOrder, "daraz"),
    transaction_number: generateTransactionNumber(),
    integration_id: integrationId,
    company_id: companyId,
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
    status: "active",
  };
  if (isIncompleteOrderAddress(addressFields)) {
    orderPayload.tags = ["incomplete_address"];
  }
  const cashAccountId = await resolveCompanyDefaultCashAccountId(companyId);
  if (cashAccountId) orderPayload.payment_method_accounts_id = cashAccountId;
  if (customerId) orderPayload.customer_id = customerId;

  const createdResult = await createImportedPosOrderOrGetExisting(orderPayload);
  if (!createdResult.created) {
    recordOrderSkip(
      stats,
      {
        store: "daraz",
        remote_id: remoteId,
        order_number: remoteOrder?.number,
        reason: "already_imported",
        detail: createdResult.order?.order_no
          ? `POS ${createdResult.order.order_no}`
          : `POS order ${createdResult.order?._id}`,
      },
      logCtx,
    );
    return;
  }

  const order = createdResult.order;
  if (orderPayload.tags?.includes("incomplete_address")) {
    await applyIncompleteAddressTagIfNeeded(order._id, addressFields);
  }
  await recordOrderStatusUpdate({
    orderId: order._id,
    orderStatus: order.order_status || "placed",
    companyId,
    userId: orderPayload.created_by,
  });

  for (const item of orderItemsPayload) {
    await OrderItem.create({ ...item, order_id: order._id });
    stats.lines_inserted = (stats.lines_inserted || 0) + 1;
  }
  stats.inserted += 1;
}

async function pullDarazOrderToPos(remoteOrder, ctx) {
  const { companyId, process } = ctx;
  const integrationId = resolveIntegrationId(process);
  const remoteId = remoteOrder?.id || remoteOrder?.order_id;
  const externalRef = orderExternalRef("daraz", remoteId);
  const existing = await findExistingImportedOrder(companyId, {
    externalRef,
    integrationId,
    integrationOrderId: resolveIntegrationOrderId("daraz", remoteOrder, remoteId),
  });
  if (existing) {
    await updatePosOrderFromRemote(existing, remoteOrder, "daraz", ctx);
    ctx.stats.updated = (ctx.stats.updated || 0) + 1;
    return;
  }
  return importDarazOrderToPos(remoteOrder, ctx);
}

async function listDarazOrders(client, { offset, limit, createdAfter, sortDir }) {
  const params = {
    offset: String(offset || 0),
    limit: String(limit || 50),
    sort_by: "created_at",
    sort_direction: sortDir || "ASC",
  };
  if (createdAfter) params.created_after = createdAfter;
  const data = await client.call("/orders/get", params);
  return {
    orders: asArray(data?.orders || data?.order),
    count: Number(data?.count || data?.ordersTotal) || 0,
  };
}

async function hydrateDarazOrders(client, orders) {
  const hydrated = [];
  for (const order of orders) {
    const orderId = order?.order_id || order?.orderId;
    let items = [];
    try {
      items = await fetchDarazOrderItems(client, orderId);
    } catch (err) {
      console.warn(
        `Daraz order/items/get ${orderId} failed:`,
        err?.message || err,
      );
    }
    hydrated.push(normalizeDarazOrder(order, items));
  }
  return hydrated;
}

async function fetch_category(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const { limit, page } = resolveBatchPagination(process);

  try {
    const data = await client.call("/category/tree/get", {});
    const tree = data?.category_list || data?.data || data;
    const all = flattenDarazCategoryTree(tree);
    const start = (page - 1) * limit;
    const remoteCategories = all.slice(start, start + limit);
    const stats = {
      inserted: 0,
      skipped: 0,
      parent_found: 0,
      parent_inserted: 0,
      parent_linked: 0,
      parent_unresolved: 0,
      parent_linked_categories: [],
      sync_category_mapped: 0,
    };

    for (const remote of remoteCategories) {
      try {
        await importDarazCategoryToPos(remote, { companyId, process, stats });
      } catch (err) {
        console.error(
          `Failed to import Daraz category ${remote?.category_id}:`,
          err?.message || err,
        );
        stats.skipped += 1;
      }
    }

    const fetched = remoteCategories.length;
    const isComplete = start + fetched >= all.length;
    const remarks = isComplete
      ? `Daraz category import completed: batch fetched ${fetched}, inserted ${stats.inserted}, skipped ${stats.skipped}.`
      : `Batch complete: fetched ${fetched}, inserted ${stats.inserted}, skipped ${stats.skipped}. Call execute-process again for page ${page + 1}.`;

    return finishFetchCategoryBatch(req, res, process, {
      fetched,
      inserted: stats.inserted,
      skipped: stats.skipped,
      parent_found: stats.parent_found,
      parent_inserted: stats.parent_inserted,
      parent_linked: stats.parent_linked,
      parent_unresolved: stats.parent_unresolved,
      parent_linked_categories: stats.parent_linked_categories,
      sync_category_mapped: stats.sync_category_mapped,
      isComplete,
      remarks,
    });
  } catch (error) {
    console.error("Daraz category fetch failed:", error?.message || error);
    return failFetchCategoryBatch(
      process,
      res,
      error?.message || "Failed to fetch categories from Daraz Pakistan.",
      error,
    );
  }
}

async function fetch_brand(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const { limit, page } = resolveBatchPagination(process);

  try {
    const data = await client.call("/brands/get", {
      offset: String((page - 1) * limit),
      limit: String(limit),
    });
    const remoteBrands = asArray(
      data?.brands || data?.brand || (Array.isArray(data) ? data : []),
    );
    const stats = {
      inserted: 0,
      skipped: 0,
      parent_found: 0,
      parent_inserted: 0,
      parent_linked: 0,
      parent_unresolved: 0,
      parent_linked_brands: [],
      sync_brand_mapped: 0,
    };

    for (const remote of remoteBrands) {
      try {
        await importDarazBrandToPos(remote, { companyId, process, stats });
      } catch (err) {
        console.error(
          `Failed to import Daraz brand ${remote?.brand_id}:`,
          err?.message || err,
        );
        stats.skipped += 1;
      }
    }

    const fetched = remoteBrands.length;
    const isComplete = fetched < limit;
    return finishFetchBrandBatch(req, res, process, {
      fetched,
      inserted: stats.inserted,
      skipped: stats.skipped,
      parent_found: stats.parent_found,
      parent_inserted: stats.parent_inserted,
      parent_linked: stats.parent_linked,
      parent_unresolved: stats.parent_unresolved,
      parent_linked_brands: stats.parent_linked_brands,
      sync_brand_mapped: stats.sync_brand_mapped,
      isComplete,
      remarks: isComplete
        ? `Daraz brand import completed: fetched ${fetched}, inserted ${stats.inserted}, skipped ${stats.skipped}.`
        : `Batch complete: fetched ${fetched}, inserted ${stats.inserted}. Call execute-process again for page ${page + 1}.`,
    });
  } catch (error) {
    console.error("Daraz brand fetch failed:", error?.message || error);
    return failFetchBrandBatch(
      process,
      res,
      error?.message || "Failed to fetch brands from Daraz Pakistan.",
      error,
    );
  }
}

async function fetch_product(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const { limit, page } = resolveBatchPagination(process);
  const offset = (page - 1) * limit;

  try {
    const data = await client.call("/products/get", {
      filter: "all",
      offset: String(offset),
      limit: String(Math.min(limit, 50)),
    });
    const remoteProducts = asArray(data?.products || data?.product);
    const stats = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      categories_found: 0,
      categories_inserted: 0,
      products_category_linked: 0,
      sync_category_mapped: 0,
      sync_product_mapped: 0,
      variations_fetched: 0,
      variations_inserted: 0,
      variations_updated: 0,
    };

    for (const remote of remoteProducts) {
      const itemId = darazItemId(remote);
      const detail = await fetchDarazProductDetail(client, itemId, remote);
      const name = darazProductName(detail);
      if (!name) {
        stats.skipped += 1;
        continue;
      }
      try {
        const categoryIds = [];
        const categoryId = detail?.primary_category || detail?.primary_category_id;
        if (categoryId) {
          const mapped = await findExistingCategory(
            String(categoryId),
            categorySlugFromName(String(categoryId)),
            companyId,
          );
          if (mapped?._id) categoryIds.push(mapped._id);
        }
        await importDarazProductToPos(detail, {
          companyId,
          process,
          stats,
          categoryIds,
        });
      } catch (err) {
        console.error(
          `Failed to import Daraz product ${itemId}:`,
          err?.message || err,
        );
        stats.skipped += 1;
      }
    }

    const fetched = remoteProducts.length;
    const isComplete = fetched < Math.min(limit, 50);
    return finishFetchProductBatch(req, res, process, {
      fetched,
      inserted: stats.inserted,
      updated: stats.updated,
      skipped: stats.skipped,
      categories_found: stats.categories_found,
      categories_inserted: stats.categories_inserted,
      products_category_linked: stats.products_category_linked,
      variations_fetched: stats.variations_fetched,
      variations_inserted: stats.variations_inserted,
      variations_updated: stats.variations_updated,
      isComplete,
      remarks: isComplete
        ? `Daraz product import completed: fetched ${fetched}, inserted ${stats.inserted}, updated ${stats.updated}, skipped ${stats.skipped}.`
        : `Batch complete: fetched ${fetched}, inserted ${stats.inserted}, updated ${stats.updated}. Call execute-process again for page ${page + 1}.`,
    });
  } catch (error) {
    console.error("Daraz product fetch failed:", error?.message || error);
    return failFetchProductBatch(
      process,
      res,
      error?.message || "Failed to fetch products from Daraz Pakistan.",
      error,
    );
  }
}

async function syncDarazSimpleProductToStore({
  req,
  res,
  process,
  client,
  integration,
  product,
  companyId,
  integrationId,
}) {
  const sku = resolvePosProductSku(product);
  if (!sku) {
    return res.status(400).json({
      success: false,
      message: "Product SKU or identifier is required to sync with Daraz.",
    });
  }

  const productId = coalesceObjectId(product._id);
  const syncRow = await SyncProduct.findOne({
    product_id: productId,
    integration_id: integrationId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
  }).lean();

  let { itemId, skuId } = parseDarazSyncRef(
    syncRow?.refference_id || syncRow?.reference_id,
  );

  if (itemId) {
    const detail = await fetchDarazProductDetail(client, itemId, null);
    if (!darazItemId(detail) && !darazSkus(detail).length) {
      itemId = "";
      skuId = "";
    } else {
      const skuRow =
        darazSkus(detail).find((row) => {
          const id = String(row?.SkuId || row?.sku_id || "").trim();
          return (skuId && id === skuId) || darazSellerSku(row) === sku;
        }) || darazSkus(detail)[0];
      skuId = String(skuRow?.SkuId || skuRow?.sku_id || skuId).trim();
    }
  }

  if (!itemId) {
    const found = await findDarazProductBySellerSku(
      client,
      sku,
      product.product_name,
    );
    if (found?.itemId) {
      itemId = found.itemId;
      skuId = found.skuId;
    }
  }

  const stockMap = await resolveSyncStockTotals([productId], companyId);
  const stockSyncEnabled = darazStockSyncEnabled(integration);
  const priceSyncEnabled = isIntegrationSyncEnabled(
    integration,
    "sync_product_price",
  );
  const nameOn = isIntegrationSyncEnabled(integration, "sync_product_name");
  const descOn = isIntegrationSyncEnabled(
    integration,
    "sync_product_description",
  );
  const imageOn = isIntegrationSyncEnabled(integration, "sync_product_image");

  if (itemId) {
    if (!priceSyncEnabled && !stockSyncEnabled && !nameOn && !descOn && !imageOn) {
      await recordProductSyncMapping(
        process,
        companyId,
        productId,
        skuId ? `${itemId}:${skuId}` : itemId,
      );
      await markProcessOutcome(
        process._id,
        "completed",
        `Product Name : ${product.product_name} — no Daraz fields enabled for update.`,
      );
      return res.status(200).json({
        success: true,
        data: { item_id: itemId, sku_id: skuId, sku },
        message: `Product Name : ${product.product_name} — sync mapping kept; no fields enabled.`,
      });
    }

    await applyDarazProductAttributeUpdate({
      client,
      integration,
      itemId,
      product,
      sellerSku: sanitizeDarazSellerSku(sku) || sku,
      skuId,
    });
    await applyDarazPriceStockUpdates({
      client,
      integration,
      itemId,
      skuId,
      sellerSku: sanitizeDarazSellerSku(sku) || sku,
      product,
      syncRow,
      stockMap,
      productId,
    });
    await recordProductSyncMapping(
      process,
      companyId,
      productId,
      skuId ? `${itemId}:${skuId}` : itemId,
    );

    const updateRemarks =
      `Product Name : ${product.product_name} updated on Daraz` +
      (stockMap.size ?
        ` (${formatSyncStockFieldRemark(stockMap, productId)}). `
      : ". ") +
      formatProductSyncFieldRemarks(integration);
    await markProcessOutcome(process._id, "completed", updateRemarks);
    return res.status(200).json({
      success: true,
      data: { item_id: itemId, sku_id: skuId, sku },
      message: updateRemarks,
    });
  }

  const price = Number(resolveSyncProductPrice(product, syncRow));
  const quantity = syncStockQuantity(stockMap, productId);
  const created = await createDarazListing({
    client,
    integration,
    product,
    companyId,
    integrationId,
    process,
    skus: [
      {
        sellerSku: sanitizeDarazSellerSku(sku) || sku,
        price: Number.isFinite(price) && price > 0 ? price : 1,
        quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
        packageContent: product.product_name || sku,
      },
    ],
  });
  const createdItemId = darazCreatedItemId(created);
  const createdSkuId = skuIdFromCreateList(parseDarazCreateSkuList(created), sku);
  if (!createdItemId) {
    throw new Error("Daraz /product/create did not return an item_id.");
  }

  await recordProductSyncMapping(
    process,
    companyId,
    productId,
    createdSkuId ? `${createdItemId}:${createdSkuId}` : createdItemId,
  );

  const createRemarks =
    `Product Name : ${product.product_name} created on Daraz. ` +
    formatProductSyncFieldRemarks(integration);
  await markProcessOutcome(process._id, "completed", createRemarks);
  return res.status(201).json({
    success: true,
    data: {
      item_id: createdItemId,
      sku_id: createdSkuId,
      sku,
      created,
    },
    message: createRemarks,
  });
}

async function syncDarazVariableProductToStore({
  req,
  res,
  process,
  client,
  integration,
  parentProduct,
  companyId,
  integrationId,
}) {
  const parentId = coalesceObjectId(parentProduct._id);
  const children = await loadPosVariationChildren(parentId, companyId);
  if (!children.length) {
    return syncDarazSimpleProductToStore({
      req,
      res,
      process,
      client,
      integration,
      product: parentProduct,
      companyId,
      integrationId,
    });
  }

  const childIds = children
    .map((row) => coalesceObjectId(row._id))
    .filter(Boolean);
  const stockMap = await resolveSyncStockTotals(
    [parentId, ...childIds],
    companyId,
  );

  const syncRows = await SyncProduct.find({
    integration_id: integrationId,
    company_id: companyId,
    status: "active",
    deletedAt: null,
    product_id: { $in: [parentId, ...childIds] },
  }).lean();

  const parentSyncRow = syncRows.find(
    (row) => String(row.product_id) === String(parentId),
  );
  const childSyncByProductId = new Map(
    syncRows
      .filter((row) => String(row.product_id) !== String(parentId))
      .map((row) => [String(row.product_id), row]),
  );

  let itemId = parseDarazSyncRef(
    parentSyncRow?.refference_id || parentSyncRow?.reference_id,
  ).itemId;
  if (!itemId) {
    for (const row of syncRows) {
      const parsed = parseDarazSyncRef(row?.refference_id || row?.reference_id);
      if (parsed.itemId) {
        itemId = parsed.itemId;
        break;
      }
    }
  }

  if (!itemId) {
    for (const child of children) {
      const childSku = resolvePosProductSku(child);
      const found = await findDarazProductBySellerSku(client, childSku);
      if (found?.itemId) {
        itemId = found.itemId;
        break;
      }
    }
  }

  const skuPlan = children
    .map((child) => {
      const sellerSku = sanitizeDarazSellerSku(resolvePosProductSku(child)) || resolvePosProductSku(child);
      if (!sellerSku) return null;
      const childId = coalesceObjectId(child._id);
      const syncRow = childSyncByProductId.get(String(childId));
      const price = Number(resolveSyncProductPrice(child, syncRow));
      const quantity = syncStockQuantity(stockMap, childId);
      return {
        child,
        childId,
        sellerSku,
        syncRow,
        price: Number.isFinite(price) && price > 0 ? price : 1,
        quantity: Number.isFinite(quantity) && quantity >= 0 ? quantity : 0,
      };
    })
    .filter(Boolean);

  if (!skuPlan.length) {
    return res.status(400).json({
      success: false,
      message:
        "Variable product variations need a SKU or product code to sync with Daraz.",
    });
  }

  if (itemId) {
    const detail = await fetchDarazProductDetail(client, itemId, null);
    const remoteSkus = darazSkus(detail);
    await applyDarazProductAttributeUpdate({
      client,
      integration,
      itemId,
      product: parentProduct,
      skus: skuPlan.map((plan) => {
        const remote =
          remoteSkus.find((row) => darazSellerSku(row) === plan.sellerSku) ||
          null;
        return {
          sellerSku: plan.sellerSku,
          skuId: String(
            remote?.SkuId ||
              remote?.sku_id ||
              parseDarazSyncRef(plan.syncRow?.refference_id).skuId ||
              "",
          ).trim(),
        };
      }),
    });

    let updated = 0;
    for (const plan of skuPlan) {
      const remote =
        remoteSkus.find((row) => darazSellerSku(row) === plan.sellerSku) ||
        null;
      const skuId = String(
        remote?.SkuId ||
          remote?.sku_id ||
          parseDarazSyncRef(plan.syncRow?.refference_id).skuId ||
          "",
      ).trim();
      await applyDarazPriceStockUpdates({
        client,
        integration,
        itemId,
        skuId,
        sellerSku: plan.sellerSku,
        product: plan.child,
        syncRow: plan.syncRow,
        stockMap,
        productId: plan.childId,
      });
      await recordProductSyncMapping(
        process,
        companyId,
        plan.childId,
        skuId ? `${itemId}:${skuId}` : itemId,
      );
      updated += 1;
    }

    await recordProductSyncMapping(process, companyId, parentId, itemId);

    const updateRemarks =
      `Product Name : ${parentProduct.product_name} updated on Daraz (${updated} variation(s)). ` +
      formatProductSyncFieldRemarks(integration);
    await markProcessOutcome(process._id, "completed", updateRemarks);
    return res.status(200).json({
      success: true,
      data: { item_id: itemId, variations_updated: updated },
      message: updateRemarks,
    });
  }

  const created = await createDarazListing({
    client,
    integration,
    product: parentProduct,
    companyId,
    integrationId,
    process,
    skus: skuPlan.map((plan) => ({
      sellerSku: plan.sellerSku,
      price: plan.price,
      quantity: plan.quantity,
      packageContent: plan.child.product_name || plan.sellerSku,
    })),
  });
  const createdItemId = darazCreatedItemId(created);
  if (!createdItemId) {
    throw new Error("Daraz /product/create did not return an item_id.");
  }
  const skuList = parseDarazCreateSkuList(created);
  await recordProductSyncMapping(process, companyId, parentId, createdItemId);
  for (const plan of skuPlan) {
    const createdSkuId = skuIdFromCreateList(skuList, plan.sellerSku);
    await recordProductSyncMapping(
      process,
      companyId,
      plan.childId,
      createdSkuId ? `${createdItemId}:${createdSkuId}` : createdItemId,
    );
  }

  const createRemarks =
    `Product Name : ${parentProduct.product_name} created on Daraz (${skuPlan.length} variation(s)). ` +
    formatProductSyncFieldRemarks(integration);
  await markProcessOutcome(process._id, "completed", createRemarks);
  return res.status(201).json({
    success: true,
    data: { item_id: createdItemId, created },
    message: createRemarks,
  });
}

async function sync_product(req, res, process) {
  const integration = process?.integration_id;
  const product = process?.product_id;
  if (!validateDarazIntegration(integration, res)) return;
  if (!product) {
    return res.status(400).json({
      success: false,
      message: "Product details are missing from the process payload.",
    });
  }

  const sku = resolvePosProductSku(product);
  if (!sku) {
    return res.status(400).json({
      success: false,
      message: "Product SKU or identifier is required to sync with Daraz.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const companyId = resolveCompanyId(process);
  const integrationId = resolveIntegrationId(process);

  try {
    const { rootProduct } = await resolveDarazSyncRootProduct(
      product,
      companyId,
    );

    if (
      typeof rootProduct?.product_type === "string" &&
      rootProduct.product_type.toLowerCase() === "variable"
    ) {
      return await syncDarazVariableProductToStore({
        req,
        res,
        process,
        client,
        integration,
        parentProduct: rootProduct,
        companyId,
        integrationId,
      });
    }

    return await syncDarazSimpleProductToStore({
      req,
      res,
      process,
      client,
      integration,
      product: rootProduct,
      companyId,
      integrationId,
    });
  } catch (error) {
    const detail = error?.message || String(error);
    console.error(
      `Daraz product sync failed for "${product.product_name}" (sku=${sku}):`,
      detail,
    );
    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Product Name : ${product.product_name} to Daraz — ${detail}`,
    );
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({
      success: false,
      message: detail,
    });
  }
}

async function sync_category(req, res, process) {
  const integration = process?.integration_id;
  const category = process?.category_id;
  if (!validateDarazIntegration(integration, res)) return;
  if (!category) {
    return res.status(400).json({
      success: false,
      message:
        "Category is required for sync_category. Set category_id on the process.",
    });
  }

  const title = String(category.name || "").trim();
  if (!title) {
    return res.status(400).json({
      success: false,
      message: "Category name is required to sync with Daraz.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const companyId = resolveCompanyId(process);
  const integrationId = resolveIntegrationId(process);

  try {
    const tree = await loadDarazCategoryTree(client);
    let remoteId = String(category.slug || "")
      .replace(/^daraz-/i, "")
      .trim();
    let matched =
      isDarazCategoryId(remoteId) ?
        tree.find((node) => String(node.category_id) === remoteId) || null
      : null;

    if (matched && !matched.leaf) {
      matched = firstDarazLeafUnder(tree, matched.category_id) || matched;
    }
    if (!matched) {
      matched = findDarazLeafForName(tree, title);
    }
    remoteId = String(matched?.category_id || "").trim();

    if (!isDarazCategoryId(remoteId)) {
      const msg = `Category : ${title} was not found in the Daraz Pakistan tree. POS cannot create Daraz categories — use a POS name that matches a Daraz leaf, then sync again.`;
      await markProcessOutcome(process._id, "failed", msg);
      return res.status(400).json({ success: false, message: msg });
    }

    await upsertSyncCategoryMapping({
      categoryId: category._id,
      integrationId,
      companyId,
      referenceId: remoteId,
      createdBy: process.created_by?._id || process.created_by,
    });

    const remoteName = matched?.name || remoteId;
    const remarks = `Category : ${title} mapped to Daraz leaf ${remoteName} (${remoteId}).`;
    await markProcessOutcome(process._id, "completed", remarks);
    return res.status(200).json({
      success: true,
      data: {
        category_id: remoteId,
        name: remoteName,
        leaf: Boolean(matched?.leaf),
      },
      message: remarks,
    });
  } catch (err) {
    const detail = err?.message || String(err);
    console.error(
      `Daraz category sync failed for "${title}":`,
      detail,
    );
    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Category : ${title} to Daraz — ${detail}`,
    );
    return res.status(500).json({ success: false, message: detail });
  }
}

async function sync_brand(req, res, process) {
  const integration = process?.integration_id;
  const brand = process?.brand_id;
  if (!validateDarazIntegration(integration, res)) return;
  if (!brand) {
    return res.status(400).json({
      success: false,
      message: "Brand is required for sync_brand. Set brand_id on the process.",
    });
  }

  const companyId = resolveCompanyId(process);
  await upsertSyncBrandMapping({
    brandId: brand._id,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId: String(brand.slug || brand._id),
    createdBy: process.created_by?._id || process.created_by,
  });

  const msg =
    "Daraz brands are platform-defined. Mapping saved; use fetch_brand to import seller brands. POS cannot create new Daraz brands.";
  await markProcessOutcome(process._id, "completed", msg);
  return res.status(200).json({ success: true, message: msg });
}

async function fetch_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const { limit, page } = resolveBatchPagination(process);
  const offset = (page - 1) * limit;

  try {
    const { orders } = await listDarazOrders(client, { offset, limit });
    const remoteOrders = await hydrateDarazOrders(client, orders);
    const stats = createFetchOrderStats();
    const importCtx = { companyId, process, stats, req };

    for (const remote of remoteOrders) {
      try {
        await importDarazOrderToPos(remote, importCtx);
      } catch (err) {
        recordOrderSkip(
          stats,
          {
            store: "daraz",
            remote_id: remote?.id,
            order_number: remote?.number,
            reason: "import_error",
            detail: err?.message || String(err),
          },
          importCtx,
        );
      }
    }

    const fetched = remoteOrders.length;
    const isComplete = fetched < limit;
    return finishFetchOrderBatch(req, res, process, {
      fetched,
      inserted: stats.inserted,
      skipped: stats.skipped,
      lines_inserted: stats.lines_inserted,
      lines_skipped: stats.lines_skipped,
      skipped_orders: stats.skipped_orders,
      isComplete,
      remarks: formatFetchOrderBatchRemarks({
        fetched,
        inserted: stats.inserted,
        skipped: stats.skipped,
        lines_inserted: stats.lines_inserted,
        lines_skipped: stats.lines_skipped,
        skipped_orders: stats.skipped_orders,
        isComplete,
        page: page + 1,
        inventory_applied: stats.inventory_applied || 0,
        inventory_stock_awaiting: stats.inventory_stock_awaiting || 0,
      }),
    });
  } catch (error) {
    console.error("Daraz order fetch failed:", error?.message || error);
    await logFetchOrderBatchFailed(req, {
      process,
      companyId,
      store: "daraz",
      errorMessage: error?.message || "Failed to fetch Daraz orders.",
    });
    return failFetchOrderBatch(
      process,
      res,
      error?.message || "Failed to fetch orders from Daraz Pakistan.",
      error,
    );
  }
}

async function fetch_latest_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const limit = resolveLatestOrderBatchLimit(process);
  const createdAfter = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "+0000");

  try {
    const { orders } = await listDarazOrders(client, {
      offset: 0,
      limit,
      createdAfter,
      sortDir: "DESC",
    });
    const remoteOrders = await hydrateDarazOrders(client, orders);
    const stats = createFetchOrderStats();
    const importCtx = { companyId, process, stats, req };

    for (const remote of remoteOrders) {
      try {
        await importDarazOrderToPos(remote, importCtx);
      } catch (err) {
        recordOrderSkip(
          stats,
          {
            store: "daraz",
            remote_id: remote?.id,
            order_number: remote?.number,
            reason: "import_error",
            detail: err?.message || String(err),
          },
          importCtx,
        );
      }
    }

    return finishFetchLatestOrderBatch(req, res, process, {
      fetched: remoteOrders.length,
      inserted: stats.inserted,
      skipped: stats.skipped,
      lines_inserted: stats.lines_inserted,
      lines_skipped: stats.lines_skipped,
      skipped_orders: stats.skipped_orders,
      isComplete: true,
      remarks: formatFetchLatestOrderRemarks({
        fetched: remoteOrders.length,
        inserted: stats.inserted,
        skipped: stats.skipped,
        lines_inserted: stats.lines_inserted,
        lines_skipped: stats.lines_skipped,
        skipped_orders: stats.skipped_orders,
        limit,
      }),
    });
  } catch (error) {
    console.error("Daraz latest order fetch failed:", error?.message || error);
    return failFetchOrderBatch(
      process,
      res,
      error?.message || "Failed to fetch latest Daraz orders.",
      error,
    );
  }
}

async function pull_order(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);
  const posOrder = process?.order_id;
  if (!validateDarazIntegration(integration, res)) return;
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const stats = createPullOrderStats();
    const importCtx = { companyId, process, stats, req };

    if (posOrder) {
      const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "daraz");
      if (!remoteId) {
        return res.status(400).json({
          success: false,
          message:
            "POS order has no Daraz reference (description daraz:order:<id> or integration_order_id).",
        });
      }
      const data = await client.call("/order/get", { order_id: String(remoteId) });
      const order = data?.orders?.[0] || data?.order || data;
      const items = await fetchDarazOrderItems(client, remoteId);
      const remote = normalizeDarazOrder(order, items);
      await pullDarazOrderToPos(remote, importCtx);
      return finishPullOrderBatch(req, res, process, {
        fetched: 1,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        lines_inserted: stats.lines_inserted,
        lines_skipped: stats.lines_skipped,
        skipped_orders: stats.skipped_orders,
        isComplete: true,
        remarks: formatPullOrderBatchRemarks({
          fetched: 1,
          inserted: stats.inserted,
          updated: stats.updated,
          skipped: stats.skipped,
          lines_inserted: stats.lines_inserted,
          lines_skipped: stats.lines_skipped,
          skipped_orders: stats.skipped_orders,
          isComplete: true,
          page: 1,
        }),
      });
    }

    const { limit, page } = resolveBatchPagination(process);
    const { orders } = await listDarazOrders(client, {
      offset: (page - 1) * limit,
      limit,
    });
    const remoteOrders = await hydrateDarazOrders(client, orders);
    for (const remote of remoteOrders) {
      try {
        await pullDarazOrderToPos(remote, importCtx);
      } catch (err) {
        recordOrderSkip(
          stats,
          {
            store: "daraz",
            remote_id: remote?.id,
            order_number: remote?.number,
            reason: "import_error",
            detail: err?.message || String(err),
          },
          importCtx,
        );
      }
    }
    const fetched = remoteOrders.length;
    return finishPullOrderBatch(req, res, process, {
      fetched,
      inserted: stats.inserted,
      updated: stats.updated,
      skipped: stats.skipped,
      lines_inserted: stats.lines_inserted,
      lines_skipped: stats.lines_skipped,
      skipped_orders: stats.skipped_orders,
      isComplete: fetched < limit,
      remarks: formatPullOrderBatchRemarks({
        fetched,
        inserted: stats.inserted,
        updated: stats.updated,
        skipped: stats.skipped,
        lines_inserted: stats.lines_inserted,
        lines_skipped: stats.lines_skipped,
        skipped_orders: stats.skipped_orders,
        isComplete: fetched < limit,
        page: page + 1,
      }),
    });
  } catch (error) {
    console.error("Daraz order pull failed:", error?.message || error);
    return failPullOrderBatch(
      process,
      res,
      error?.message || "Failed to pull orders from Daraz Pakistan.",
      error,
    );
  }
}

function mapPosStatusToDarazAction(posStatus) {
  const key = String(posStatus || "")
    .trim()
    .toLowerCase();
  if (key === "cancelled" || key === "canceled") return "cancel";
  if (key === "shipped" || key === "delivered") return "rts";
  if (key === "processing" || key === "packed") return "pack";
  return null;
}

async function push_order(req, res, process) {
  const integration = process?.integration_id;
  const posOrder = process?.order_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!posOrder) {
    return res.status(400).json({
      success: false,
      message: "Order is required for push_order. Set order_id on the process.",
    });
  }
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "daraz");
  if (!remoteId) {
    const msg =
      "Daraz does not support creating marketplace orders from POS. Import the Daraz order first (fetch_order), then push status (pack / ready_to_ship / cancel).";
    await markProcessOutcome(process._id, "failed", msg);
    return res.status(400).json({ success: false, message: msg });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  const action = mapPosStatusToDarazAction(posOrder.order_status);
  if (!action) {
    const msg = `No Daraz status action for POS order_status=${posOrder.order_status}. Use processing (pack), shipped (ready_to_ship), or cancelled.`;
    await markProcessOutcome(process._id, "failed", msg);
    return res.status(400).json({ success: false, message: msg });
  }

  try {
    const items = await fetchDarazOrderItems(client, remoteId);
    const itemIds = items
      .map((item) => item?.order_item_id)
      .filter(Boolean)
      .join(",");
    if (!itemIds) {
      const msg = `Daraz order ${remoteId} has no order_item_id values to ${action}.`;
      await markProcessOutcome(process._id, "failed", msg);
      return res.status(400).json({ success: false, message: msg });
    }

    if (action === "pack") {
      await client.call("/order/pack", {
        pack_order_list: JSON.stringify([
          { order_item_list: itemIds.split(","), delivery_type: "dropship" },
        ]),
      });
    } else if (action === "rts") {
      await client.call("/order/rts", {
        ready_to_ship_order_list: JSON.stringify([
          { order_item_list: itemIds.split(",") },
        ]),
      });
    } else if (action === "cancel") {
      await client.call("/order/cancel", {
        order_item_id: itemIds.split(",")[0],
        reason_id: "15",
      });
    }

    const mapped = mapDarazOrderStatus(posOrder.order_status);
    const msg = `Pushed Daraz order ${remoteId} action=${action} from POS status ${posOrder.order_status} (${mapped}).`;
    await markProcessOutcome(process._id, "completed", msg);
    return res.status(200).json({
      success: true,
      message: msg,
      data: { order_id: remoteId, action, order_item_ids: itemIds },
    });
  } catch (error) {
    console.error("Daraz push_order failed:", error?.message || error);
    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to push Daraz order ${remoteId}: ${error?.message || error}`,
    );
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to push order to Daraz Pakistan.",
    });
  }
}

async function push_order_tracking(req, res, process) {
  const integration = process?.integration_id;
  const posOrder = process?.order_id;
  const companyId = resolveCompanyId(process);
  if (!validateDarazIntegration(integration, res)) return;
  if (!posOrder) {
    return res.status(400).json({
      success: false,
      message:
        "Order is required for push_order_tracking. Set order_id on the process.",
    });
  }
  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const remoteId = resolveRemoteOrderIdFromPosOrder(posOrder, "daraz");
  if (!remoteId) {
    return res.status(400).json({
      success: false,
      message:
        "POS order has no Daraz reference (description daraz:order:<id> or integration_order_id).",
    });
  }

  const tracking = await resolvePosOrderTrackingForPush(posOrder);
  if (!tracking.tracking_number && !tracking.courier_name) {
    const msg =
      "Nothing to push — set courier or tracking number on the POS order.";
    await markProcessOutcome(process._id, "failed", msg);
    return res.status(400).json({ success: false, message: msg });
  }

  const { client, error } = buildDarazClient(integration);
  if (error) return res.status(400).json({ success: false, message: error });

  try {
    const trace = await client.call("/logistic/order/trace", {
      order_id: String(remoteId),
    });
    const msg = `Daraz tracking for order ${remoteId}: POS CN ${tracking.tracking_number || "-"} / ${tracking.courier_name || "-"}. Marketplace logistics remain on Daraz (trace returned).`;
    await markProcessOutcome(process._id, "completed", msg);
    return res.status(200).json({
      success: true,
      message: msg,
      data: {
        order_id: remoteId,
        tracking,
        daraz_trace: trace,
      },
    });
  } catch (error) {
    console.error("Daraz push_order_tracking failed:", error?.message || error);
    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to read Daraz tracking for ${remoteId}: ${error?.message || error}`,
    );
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to push Daraz tracking.",
    });
  }
}

module.exports = {
  buildDarazClient,
  fetch_category,
  fetch_brand,
  fetch_product,
  fetch_order,
  fetch_latest_order,
  pull_order,
  push_order,
  push_order_tracking,
  sync_product,
  sync_category,
  sync_brand,
  importDarazProductToPos,
  flattenDarazCategoryTree,
  findDarazLeafForName,
  isDarazCategoryId,
  isDarazHostedImage,
  pickDarazEnumValue,
  sanitizeDarazSellerSku,
  buildDarazProductCreatePayload,
  buildDarazProductCreateXml,
  buildDarazAttributeXml,
  migrateDarazImages,
  createDarazListing,
  buildDarazProductUpdateXml,
  buildDarazPlaceholderImageBuffer,
};

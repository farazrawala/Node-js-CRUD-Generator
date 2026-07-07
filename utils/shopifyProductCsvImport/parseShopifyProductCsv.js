const { SHOPIFY_IMPORT_COLUMNS } = require("./columns");
const { mapShopifyHeaderIndexes } = require("./csvHeader");
const { parseCsvRecords } = require("./csvRecords");
const {
  parsePrice,
  parseQty,
  stripHtml,
  readCell,
} = require("./fieldParsers");
const { buildVariantLabel, buildProductName } = require("./productNames");
const { resolveCategoryNames } = require("./categories");
const {
  isDraftShopifyStatus,
  shouldImportShopifyStatus,
} = require("./status");
const { createImagesByHandleStore } = require("./imagesByHandle");
const { createParentByHandleStore } = require("./parentByHandle");

function createParseStats(totalRecords) {
  return {
    total_records: totalRecords,
    imported_variants: 0,
    skipped_image_only: 0,
    skipped_inactive: 0,
    skipped_draft: 0,
    skipped_missing_name: 0,
    skipped_missing_sku_and_price: 0,
  };
}

function shouldSkipRow(stats, { productName, sku, price, qty, effectiveStatus, importDrafts, importArchived }) {
  if (
    !shouldImportShopifyStatus(effectiveStatus, {
      importDrafts,
      importArchived,
    })
  ) {
    if (isDraftShopifyStatus(effectiveStatus)) {
      stats.skipped_draft += 1;
    } else {
      stats.skipped_inactive += 1;
    }
    return true;
  }

  if (!productName) {
    if (!sku && price <= 0) {
      stats.skipped_image_only += 1;
      return true;
    }
    stats.skipped_missing_name += 1;
    return true;
  }

  if (!sku && price <= 0 && qty <= 0) {
    stats.skipped_image_only += 1;
    return true;
  }

  if (!sku && price <= 0) {
    stats.skipped_missing_sku_and_price += 1;
    return true;
  }

  return false;
}

/**
 * Parse Shopify product export CSV into POS import rows (one row per variant).
 * @returns {{ rows: object[], stats: object, columns: object }}
 */
function parseShopifyProductCsv(
  text,
  { defaultQty = 0, importDrafts = false, importArchived = false } = {},
) {
  const records = parseCsvRecords(text);
  if (!records.length) {
    return {
      rows: [],
      stats: { total_records: 0 },
      columns: SHOPIFY_IMPORT_COLUMNS,
    };
  }

  const headerCells = records[0].cells;
  const indexes = mapShopifyHeaderIndexes(headerCells);
  if (indexes.handle == null && indexes.title == null) {
    const err = new Error(
      "Not a Shopify product export. Expected columns like Handle, Title, Variant Price.",
    );
    err.statusCode = 400;
    err.details = { columns: SHOPIFY_IMPORT_COLUMNS };
    throw err;
  }

  const stats = createParseStats(records.length - 1);
  const { rememberParentRow, getParent } = createParentByHandleStore();
  const { imagesByHandle, rememberHandleImage } = createImagesByHandleStore();
  const rows = [];

  for (let i = 1; i < records.length; i += 1) {
    const { line, cells } = records[i];
    const handle = String(readCell(cells, indexes, "handle")).trim();
    if (!handle) continue;

    const title = String(readCell(cells, indexes, "title")).trim();
    const description = stripHtml(readCell(cells, indexes, "description"));
    const vendor = String(readCell(cells, indexes, "vendor")).trim();
    const productCategory = String(readCell(cells, indexes, "category")).trim();
    const type = String(readCell(cells, indexes, "type")).trim();
    const status = String(readCell(cells, indexes, "status")).trim();

    rememberParentRow(handle, {
      title,
      description,
      vendor,
      productCategory,
      type,
      status,
    });

    const parent = getParent(handle);

    const variantLabel = buildVariantLabel([
      readCell(cells, indexes, "option1_value"),
      readCell(cells, indexes, "option2_value"),
      readCell(cells, indexes, "option3_value"),
    ]);

    const sku = String(readCell(cells, indexes, "variant_sku") || "")
      .trim()
      .replace(/^'/, "");
    const barcode = String(readCell(cells, indexes, "variant_barcode") || "")
      .trim()
      .replace(/^'/, "");
    const imageSrc = String(readCell(cells, indexes, "image_src") || "").trim();
    const variantImage = String(readCell(cells, indexes, "variant_image") || "").trim();
    rememberHandleImage(handle, imageSrc);
    rememberHandleImage(handle, variantImage);

    const price = parsePrice(readCell(cells, indexes, "variant_price"));
    const wholesalePrice = parsePrice(readCell(cells, indexes, "cost_per_item"));
    const qty = parseQty(readCell(cells, indexes, "variant_inventory_qty"), defaultQty);

    const baseTitle = title || parent.title;
    const productName = buildProductName(baseTitle, variantLabel);
    const effectiveStatus = status || parent.status || "";

    if (
      shouldSkipRow(stats, {
        productName,
        sku,
        price,
        qty,
        effectiveStatus,
        importDrafts,
        importArchived,
      })
    ) {
      continue;
    }

    const categories = resolveCategoryNames(
      vendor || parent.vendor,
      productCategory || parent.category,
      type || parent.type,
    );
    const handleImages = imagesByHandle.get(handle) || [];
    const primaryImage = variantImage || imageSrc || handleImages[0] || "";

    rows.push({
      line,
      handle,
      category: categories[categories.length - 1] || "Shopify",
      categories,
      product_name: productName,
      price: price > 0 ? price : wholesalePrice,
      wholesale_price: wholesalePrice > 0 ? wholesalePrice : price,
      qty,
      sku: sku || `${handle}-${variantLabel || "default"}`.slice(0, 80),
      barcode,
      image_url: primaryImage,
      image_urls:
        handleImages.length ? handleImages
        : primaryImage ? [primaryImage]
        : [],
      unit: "Piece",
      product_type: variantLabel ? "Variable" : "Single",
      description: description || parent.description || "",
      variant_label: variantLabel || null,
    });
    stats.imported_variants += 1;
  }

  return { rows, stats, columns: SHOPIFY_IMPORT_COLUMNS };
}

module.exports = { parseShopifyProductCsv };

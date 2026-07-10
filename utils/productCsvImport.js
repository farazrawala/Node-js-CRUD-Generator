const crypto = require("crypto");
const Category = require("../models/category");
const Product = require("../models/product");
const { coalesceObjectId, generateSlug } = require("./modelHelper");
const { generateProductBarcode } = require("./barcodeGenerator");
const { saveProductImagesFromUrls } = require("./productImageDownload");
const { buildProductThumbnailFields } = require("./productImageThumbnail");
const {
  categorySlugFromName,
  findExistingCategoryByName,
  findExistingProduct,
} = require("./processHelpers");
const {
  createPurchaseOrderForImportStock,
} = require("./productImportPurchase");

const PRODUCT_IMPORT_COLUMNS = {
  category: ["category", "cat", "category_name"],
  product_name: ["product_name", "product name", "name", "product", "title"],
  price: [
    "price",
    "product_price",
    "sale_price",
    "amount",
    "mrp",
    "retail_price",
  ],
  wholesale_price: [
    "wholesale_price",
    "wholesale",
    "cost",
    "unit_cost",
    "purchase_price",
  ],
  qty: ["qty", "quantity", "stock", "opening_stock", "opening_qty"],
  sku: ["sku", "product_code", "code"],
  barcode: ["barcode", "bar_code", "ean", "upc", "variant_barcode"],
  unit: ["unit"],
  product_type: ["product_type", "type"],
  description: ["description", "product_description"],
  image_url: ["image_url", "image_src", "image", "featured_image"],
  image_urls: ["image_urls", "images", "gallery_images"],
};

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function detectDelimiter(line) {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs > 0 && tabs >= commas) return "\t";
  if (commas > 0) return ",";
  return "\t";
}

function parseDelimitedLine(line, delimiter) {
  if (delimiter !== ",") {
    return line.split(delimiter).map((cell) => String(cell ?? "").trim());
  }

  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function mapHeaderIndexes(headers) {
  const normalized = headers.map(normalizeHeader);
  const indexes = {};

  for (const [field, aliases] of Object.entries(PRODUCT_IMPORT_COLUMNS)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    const idx = normalized.findIndex((h) => aliasSet.has(h));
    if (idx >= 0) indexes[field] = idx;
  }

  return indexes;
}

function hasRequiredHeader(indexes) {
  return indexes.product_name != null;
}

function parsePrice(value) {
  if (value == null || value === "") return 0;
  const cleaned = String(value)
    .replace(/[,₨\s]/g, "")
    .trim();
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function parseQty(value, fallback = 0) {
  if (value == null || value === "") {
    const fb = Number(fallback);
    return Number.isFinite(fb) && fb >= 0 ? fb : 0;
  }
  const cleaned = String(value).replace(/[,]/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

/** Sale price from CSV `price`; purchase/PO cost from `wholesale_price` when present. */
function resolveImportWholesalePrice(row) {
  const wholesale = parsePrice(row.wholesale_price);
  if (wholesale > 0) return wholesale;
  const legacyCost = parsePrice(row.cost);
  if (legacyCost > 0) return legacyCost;
  return parsePrice(row.price);
}

function parseProductImportText(text, { defaultQty = 0 } = {}) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { rows: [], delimiter: "\t", hasHeader: false };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseDelimitedLine(lines[0], delimiter);
  const indexes = mapHeaderIndexes(headerCells);
  const hasHeader = hasRequiredHeader(indexes);

  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows = [];

  for (let i = 0; i < dataLines.length; i += 1) {
    const cells = parseDelimitedLine(dataLines[i], delimiter);
    const read = (field, fallbackIdx) => {
      if (indexes[field] != null) return cells[indexes[field]] ?? "";
      if (fallbackIdx != null) return cells[fallbackIdx] ?? "";
      return "";
    };

    const row = {
      line: hasHeader ? i + 2 : i + 1,
      category: String(read("category", 0)).trim(),
      product_name: String(read("product_name", 1)).trim(),
      price: parsePrice(read("price", 2)),
      wholesale_price: parsePrice(read("wholesale_price", 3)),
      qty: parseQty(read("qty", 4), defaultQty),
      sku: String(read("sku")).trim(),
      barcode: String(read("barcode")).trim().replace(/^'/, ""),
      unit: String(read("unit")).trim() || "Piece",
      product_type: String(read("product_type")).trim() || "Single",
      description: String(read("description")).trim(),
      image_url: String(read("image_url")).trim(),
    };

    const imageUrlsRaw = read("image_urls");
    if (imageUrlsRaw) {
      try {
        const parsed =
          (
            typeof imageUrlsRaw === "string" &&
            imageUrlsRaw.trim().startsWith("[")
          ) ?
            JSON.parse(imageUrlsRaw)
          : String(imageUrlsRaw)
              .split("|")
              .map((s) => s.trim())
              .filter(Boolean);
        row.image_urls =
          Array.isArray(parsed) ? parsed : [String(imageUrlsRaw).trim()];
      } catch (_) {
        row.image_urls = String(imageUrlsRaw)
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (row.image_url) {
      row.image_urls = [row.image_url];
    }

    if (!row.product_name) continue;
    rows.push(row);
  }

  return { rows, delimiter, hasHeader, columns: PRODUCT_IMPORT_COLUMNS };
}

function buildImportSku(productName, rowIndex, explicitSku) {
  if (explicitSku) return explicitSku;
  const slug = categorySlugFromName(productName).slice(0, 48);
  const base = slug || `product-${rowIndex}`;
  const suffix = crypto
    .createHash("md5")
    .update(`${productName}:${rowIndex}`)
    .digest("hex")
    .slice(0, 6);
  return `imp-${base}-${suffix}`.slice(0, 80);
}

async function ensureImportCategory(
  categoryName,
  { companyId, createdBy, cache, stats },
) {
  const name = String(categoryName || "").trim() || "Uncategorized";
  const cacheKey = name.toLowerCase();

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let category = await findExistingCategoryByName(name, companyId);
  if (category) {
    cache.set(cacheKey, coalesceObjectId(category._id));
    stats.categories_found += 1;
    return cache.get(cacheKey);
  }

  const slug = categorySlugFromName(name) || generateSlug(name);
  category = await Category.create({
    name,
    slug,
    description: name,
    company_id: companyId,
    status: "active",
    isActive: true,
    parent_id: null,
    sort_order: 0,
    created_by: createdBy,
  });

  cache.set(cacheKey, coalesceObjectId(category._id));
  stats.categories_created += 1;
  return cache.get(cacheKey);
}

/** Ensure each name exists; returns ObjectId[] in the same order (deduped). */
async function ensureImportCategories(
  categoryNames,
  { companyId, createdBy, cache, stats },
) {
  const names = (Array.isArray(categoryNames) ? categoryNames : [categoryNames])
    .map((n) => String(n || "").trim())
    .filter(Boolean);
  const uniqueNames = [...new Set(names.map((n) => n.toLowerCase()))].map(
    (key) => names.find((n) => n.toLowerCase() === key),
  );
  const ids = [];
  for (const name of uniqueNames) {
    const id = await ensureImportCategory(name, {
      companyId,
      createdBy,
      cache,
      stats,
    });
    if (id) ids.push(id);
  }
  return ids;
}

/** Another product in the company already uses this barcode. */
async function findBarcodeConflict(barcode, companyId, excludeId = null) {
  const trimmed = String(barcode || "").trim();
  if (!trimmed) return null;

  const filter = {
    company_id: companyId,
    barcode: trimmed,
    deletedAt: null,
  };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  return Product.findOne(filter).select("_id product_name barcode").lean();
}

/**
 * Generate a random EAN13 barcode unique within company (and current import batch).
 */
async function generateUniqueImportBarcode(
  companyId,
  { assignedInRun = null, excludeId = null } = {},
) {
  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateProductBarcode();
    if (assignedInRun?.has(candidate)) continue;

    const conflict = await findBarcodeConflict(candidate, companyId, excludeId);
    if (!conflict) {
      assignedInRun?.add(candidate);
      return candidate;
    }
  }

  const fallback =
    `2${Date.now()}${crypto.randomBytes(4).toString("hex")}`.slice(0, 12);
  const { calculateEAN13CheckDigit } = require("./barcodeGenerator");
  const barcode = `${fallback.padStart(12, "0").slice(0, 12)}${calculateEAN13CheckDigit(
    fallback.padStart(12, "0").slice(0, 12),
  )}`;
  assignedInRun?.add(barcode);
  return barcode;
}

async function resolveImportBarcode(
  row,
  { companyId, existingProduct, assignedInRun },
) {
  const raw = String(row?.barcode || "")
    .trim()
    .replace(/^'/, "");
  if (raw) {
    const conflict = await findBarcodeConflict(
      raw,
      companyId,
      existingProduct?._id,
    );
    if (!conflict && !assignedInRun?.has(raw)) {
      assignedInRun?.add(raw);
      return raw;
    }
  }

  const existingBarcode = String(existingProduct?.barcode || "").trim();
  if (existingBarcode) {
    return existingBarcode;
  }

  return generateUniqueImportBarcode(companyId, {
    assignedInRun,
    excludeId: existingProduct?._id,
  });
}

function rowImageUrls(row) {
  const list = Array.isArray(row?.image_urls) ? [...row.image_urls] : [];
  const single = String(row?.image_url || "").trim();
  if (single && !list.includes(single)) list.unshift(single);
  return list.filter((u) => /^https?:\/\//i.test(String(u)));
}

async function applyImportProductImages(
  product,
  row,
  { options, imageUrlCache },
) {
  if (!product?._id || options.downloadImages === false) return product;

  const urls = rowImageUrls(row);
  if (!urls.length) return product;

  const hasImage = Boolean(String(product.product_image || "").trim());
  if (hasImage && !options.updateExistingImages) return product;

  const saved = await saveProductImagesFromUrls(urls, {
    productId: product._id,
    companyId: product.company_id || options.companyId,
    urlCache: imageUrlCache,
  });
  if (!saved?.featured) return product;

  const update = {
    product_image: saved.featured,
    multi_images: saved.gallery || [],
  };
  const thumbFields = await buildProductThumbnailFields(update);
  Object.assign(update, thumbFields);

  await Product.updateOne({ _id: product._id }, { $set: update });
  return { ...product, ...update };
}

async function upsertImportProduct(
  row,
  {
    companyId,
    createdBy,
    categoryId,
    categoryIds,
    options,
    assignedBarcodes,
    imageUrlCache,
  },
) {
  const sku = buildImportSku(row.product_name, row.line, row.sku);
  const existing = await findExistingProduct(sku, row.product_name, companyId);
  const resolvedCategoryIds =
    Array.isArray(categoryIds) && categoryIds.length ? categoryIds
    : categoryId ? [categoryId]
    : [];
  const categoryField = resolvedCategoryIds;
  const wholesalePrice = resolveImportWholesalePrice(row);
  const barcode = await resolveImportBarcode(row, {
    companyId,
    existingProduct: existing,
    assignedInRun: assignedBarcodes,
  });

  const payload = {
    product_name: row.product_name,
    product_price: row.price,
    price_before_tax: row.price,
    wholesale_price: wholesalePrice,
    product_type: row.product_type === "Variable" ? "Variable" : "Single",
    unit: row.unit || "Piece",
    sku,
    product_code: sku,
    barcode,
    category_id: categoryField,
    product_description: row.description || "",
    status: "active",
  };

  if (existing) {
    if (!options.updateExisting) {
      return { action: "skipped", product: existing, reason: "already_exists" };
    }

    await Product.updateOne(
      { _id: existing._id },
      {
        $set: {
          product_price: payload.product_price,
          price_before_tax: payload.price_before_tax,
          wholesale_price: payload.wholesale_price,
          category_id: categoryField,
          product_description:
            payload.product_description || existing.product_description,
          ...(existing.barcode ? {} : { barcode: payload.barcode }),
        },
      },
    );

    const updated = await Product.findById(existing._id).lean();
    const withImages = await applyImportProductImages(updated, row, {
      options: { ...options, companyId },
      imageUrlCache,
    });
    return { action: "updated", product: withImages };
  }

  const created = await Product.create({
    ...payload,
    company_id: companyId,
    created_by: createdBy,
  });

  const withImages = await applyImportProductImages(
    created.toObject ? created.toObject() : created,
    row,
    { options: { ...options, companyId }, imageUrlCache },
  );
  return { action: "created", product: withImages };
}

/**
 * Import products from CSV/TSV text (e.g. pos_product.csv.xls).
 * Creates categories when missing. Does not write warehouse stock directly.
 * When enabled, opens one purchase order afterward for all qty > 0 rows.
 */
async function importParsedProductRows(
  rows,
  { companyId, createdBy, req, options = {} },
) {
  const cid = coalesceObjectId(companyId);
  const actor = coalesceObjectId(createdBy);

  if (!cid) {
    const err = new Error("company_id is required.");
    err.statusCode = 400;
    throw err;
  }

  if (!rows.length) {
    const err = new Error("No product rows found to import.");
    err.statusCode = 400;
    throw err;
  }

  const stats = {
    total_rows: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    categories_created: 0,
    categories_found: 0,
  };

  const categoryCache = new Map();
  const created = [];
  const updated = [];
  const skipped = [];
  const failed = [];

  const importOptions = {
    updateExisting: options.updateExisting !== false,
    downloadImages: options.downloadImages !== false,
    updateExistingImages: options.updateExistingImages === true,
  };

  const addStockViaPurchase = options.addStockViaPurchase !== false;
  const stockLines = [];
  const assignedBarcodes = new Set();
  const imageUrlCache = new Map();

  if (options.dryRun) {
    return {
      dry_run: true,
      company_id: String(cid),
      parsed: {
        row_count: rows.length,
        sample: rows.slice(0, 5),
      },
      columns: options.columns || PRODUCT_IMPORT_COLUMNS,
    };
  }

  for (const row of rows) {
    try {
      const categoryIds =
        Array.isArray(row.categories) && row.categories.length ?
          await ensureImportCategories(row.categories, {
            companyId: cid,
            createdBy: actor,
            cache: categoryCache,
            stats,
          })
        : [
            await ensureImportCategory(row.category, {
              companyId: cid,
              createdBy: actor,
              cache: categoryCache,
              stats,
            }),
          ];

      const result = await upsertImportProduct(row, {
        companyId: cid,
        createdBy: actor,
        categoryIds,
        options: importOptions,
        assignedBarcodes,
        imageUrlCache,
      });

      if (result.action === "created") {
        stats.created += 1;
        created.push({
          line: row.line,
          product_id: result.product._id,
          product_name: result.product.product_name,
          category: row.category,
          categories: row.categories || (row.category ? [row.category] : []),
          barcode: result.product?.barcode || row.barcode || null,
          price: row.price,
          wholesale_price: resolveImportWholesalePrice(row),
          qty: row.qty,
        });
        if (row.qty > 0) {
          stockLines.push({
            product_id: result.product._id,
            product_name: result.product.product_name,
            qty: row.qty,
            price: resolveImportWholesalePrice(row),
          });
        }
      } else if (result.action === "updated") {
        stats.updated += 1;
        updated.push({
          line: row.line,
          product_id: result.product._id,
          product_name: result.product.product_name,
          category: row.category,
          categories: row.categories || (row.category ? [row.category] : []),
          barcode: result.product?.barcode || row.barcode || null,
          price: row.price,
          wholesale_price: resolveImportWholesalePrice(row),
          qty: row.qty,
        });
        if (row.qty > 0) {
          stockLines.push({
            product_id: result.product._id,
            product_name: result.product.product_name,
            qty: row.qty,
            price: resolveImportWholesalePrice(row),
          });
        }
      } else {
        stats.skipped += 1;
        skipped.push({
          line: row.line,
          product_name: row.product_name,
          reason: result.reason,
        });
      }
    } catch (err) {
      stats.failed += 1;
      failed.push({
        line: row.line,
        product_name: row.product_name,
        error: err?.message || String(err),
      });
    }
  }

  let purchaseOrder = null;
  if (addStockViaPurchase && stockLines.length && req) {
    try {
      purchaseOrder = await createPurchaseOrderForImportStock({
        req,
        companyId: cid,
        lines: stockLines,
        warehouseId: options.warehouseId,
        vendorId: options.vendorId,
        description: options.purchaseDescription,
      });
    } catch (poErr) {
      purchaseOrder = {
        success: false,
        message: poErr?.message || String(poErr),
      };
      stats.purchase_order_failed = 1;
    }
  } else if (addStockViaPurchase && stockLines.length && !req) {
    purchaseOrder = {
      skipped: true,
      reason: "missing_req",
      message: "Stock purchase requires request context.",
    };
  }

  return {
    company_id: String(cid),
    summary: stats,
    created,
    updated,
    skipped,
    failed,
    purchase_order: purchaseOrder,
    columns: options.columns || PRODUCT_IMPORT_COLUMNS,
  };
}

async function importProductsFromText(
  text,
  { companyId, createdBy, req, options = {} },
) {
  const parsed = parseProductImportText(text, {
    defaultQty: options.defaultQty ?? 0,
  });
  if (!parsed.rows.length) {
    const err = new Error(
      "No product rows found. Expected columns: category, product_name, price, wholesale_price, qty.",
    );
    err.statusCode = 400;
    err.details = { columns: PRODUCT_IMPORT_COLUMNS };
    throw err;
  }

  return importParsedProductRows(parsed.rows, {
    companyId,
    createdBy,
    req,
    options: {
      ...options,
      columns: PRODUCT_IMPORT_COLUMNS,
    },
  });
}

module.exports = {
  PRODUCT_IMPORT_COLUMNS,
  parseProductImportText,
  importParsedProductRows,
  importProductsFromText,
};

const crypto = require("crypto");
const Category = require("../models/category");
const Product = require("../models/product");
const { coalesceObjectId, generateSlug } = require("./modelHelper");
const {
  categorySlugFromName,
  findExistingCategoryByName,
  findExistingProduct,
} = require("./processHelpers");
const { createPurchaseOrderForImportStock } = require("./productImportPurchase");

const PRODUCT_IMPORT_COLUMNS = {
  category: ["category", "cat", "category_name"],
  product_name: ["product_name", "product name", "name", "product", "title"],
  price: ["price", "product_price", "sale_price", "amount", "mrp", "retail_price"],
  wholesale_price: [
    "wholesale_price",
    "wholesale",
    "cost",
    "unit_cost",
    "purchase_price",
  ],
  qty: ["qty", "quantity", "stock", "opening_stock", "opening_qty"],
  sku: ["sku", "product_code", "code", "barcode"],
  unit: ["unit"],
  product_type: ["product_type", "type"],
  description: ["description", "product_description"],
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
  const cleaned = String(value).replace(/[,₨\s]/g, "").trim();
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
      unit: String(read("unit")).trim() || "Piece",
      product_type: String(read("product_type")).trim() || "Single",
      description: String(read("description")).trim(),
    };

    if (!row.product_name) continue;
    rows.push(row);
  }

  return { rows, delimiter, hasHeader, columns: PRODUCT_IMPORT_COLUMNS };
}

function buildImportSku(productName, rowIndex, explicitSku) {
  if (explicitSku) return explicitSku;
  const slug = categorySlugFromName(productName).slice(0, 48);
  const base = slug || `product-${rowIndex}`;
  const suffix = crypto.createHash("md5").update(`${productName}:${rowIndex}`).digest("hex").slice(0, 6);
  return `imp-${base}-${suffix}`.slice(0, 80);
}

async function ensureImportCategory(categoryName, { companyId, createdBy, cache, stats }) {
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

async function upsertImportProduct(row, { companyId, createdBy, categoryId, options }) {
  const sku = buildImportSku(row.product_name, row.line, row.sku);
  const existing = await findExistingProduct(sku, row.product_name, companyId);
  const categoryField = categoryId ? [categoryId] : [];
  const wholesalePrice = resolveImportWholesalePrice(row);

  const payload = {
    product_name: row.product_name,
    product_price: row.price,
    price_before_tax: row.price,
    wholesale_price: wholesalePrice,
    product_type: row.product_type === "Variable" ? "Variable" : "Single",
    unit: row.unit || "Piece",
    sku,
    product_code: sku,
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
          product_description: payload.product_description || existing.product_description,
        },
      },
    );

    const updated = await Product.findById(existing._id).lean();
    return { action: "updated", product: updated };
  }

  const created = await Product.create({
    ...payload,
    company_id: companyId,
    created_by: createdBy,
  });

  return { action: "created", product: created };
}

/**
 * Import products from CSV/TSV text (e.g. pos_product.csv.xls).
 * Creates categories when missing. Does not write warehouse stock directly.
 * When enabled, opens one purchase order afterward for all qty > 0 rows.
 */
async function importProductsFromText(text, { companyId, createdBy, req, options = {} }) {
  const cid = coalesceObjectId(companyId);
  const actor = coalesceObjectId(createdBy);

  if (!cid) {
    const err = new Error("company_id is required.");
    err.statusCode = 400;
    throw err;
  }

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

  const stats = {
    total_rows: parsed.rows.length,
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
  };

  const addStockViaPurchase = options.addStockViaPurchase !== false;
  const stockLines = [];

  if (options.dryRun) {
    return {
      dry_run: true,
      company_id: String(cid),
      parsed: {
        row_count: parsed.rows.length,
        delimiter: parsed.delimiter,
        has_header: parsed.hasHeader,
        sample: parsed.rows.slice(0, 5),
      },
      columns: PRODUCT_IMPORT_COLUMNS,
    };
  }

  for (const row of parsed.rows) {
    try {
      const categoryId = await ensureImportCategory(row.category, {
        companyId: cid,
        createdBy: actor,
        cache: categoryCache,
        stats,
      });

      const result = await upsertImportProduct(row, {
        companyId: cid,
        createdBy: actor,
        categoryId,
        options: importOptions,
      });

      if (result.action === "created") {
        stats.created += 1;
        created.push({
          line: row.line,
          product_id: result.product._id,
          product_name: result.product.product_name,
          category: row.category,
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
    columns: PRODUCT_IMPORT_COLUMNS,
  };
}

module.exports = {
  PRODUCT_IMPORT_COLUMNS,
  parseProductImportText,
  importProductsFromText,
};

const Product = require("../models/product");
const { coalesceObjectId } = require("./modelHelper");

/**
 * Update `product.barcode` from a CSV/TSV/JSON source, matching rows to existing
 * products **by product name** (tenant-scoped, case-insensitive exact match).
 *
 * Source columns (header required): `product_name`, `barcode` (aliases accepted).
 * Example file: geopos_products_barcode.csv
 *   product_name,barcode
 *   IKHLAS OIL,4369179812026
 *
 * Safety:
 *  - A name that matches 0 products → failed (`product_not_found`).
 *  - A name that matches >1 product → failed (`multiple_products_matched`) — never
 *    guesses, because `barcode` is unique per company.
 *  - A barcode already used by a DIFFERENT product in the company → failed
 *    (`barcode_in_use`) to respect the `product_company_barcode_1` unique index.
 */

const BARCODE_IMPORT_COLUMNS = {
  product_name: ["product_name", "product name", "name", "product", "title"],
  barcode: ["barcode", "bar_code", "ean", "upc", "code"],
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  return ",";
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
  for (const [field, aliases] of Object.entries(BARCODE_IMPORT_COLUMNS)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    const idx = normalized.findIndex((h) => aliasSet.has(h));
    if (idx >= 0) indexes[field] = idx;
  }
  return indexes;
}

/**
 * Parse barcode update text. A header row is required so columns are unambiguous.
 * @returns {{ rows: Array<{ line:number, product_name:string, barcode:string }>, delimiter:string }}
 */
function parseBarcodeImportText(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { rows: [], delimiter: ",", hasHeader: false };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseDelimitedLine(lines[0], delimiter);
  const indexes = mapHeaderIndexes(headerCells);
  const hasHeader = indexes.product_name != null && indexes.barcode != null;

  // Without a recognizable header we cannot tell which column is which.
  const nameIdx = hasHeader ? indexes.product_name : 0;
  const barcodeIdx = hasHeader ? indexes.barcode : 1;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows = [];
  for (let i = 0; i < dataLines.length; i += 1) {
    const cells = parseDelimitedLine(dataLines[i], delimiter);
    const product_name = String(cells[nameIdx] ?? "").trim();
    const barcode = String(cells[barcodeIdx] ?? "").trim();
    if (!product_name) continue;
    rows.push({
      line: hasHeader ? i + 2 : i + 1,
      product_name,
      barcode,
    });
  }

  return { rows, delimiter, hasHeader, columns: BARCODE_IMPORT_COLUMNS };
}

async function findActiveProductsByName(name, companyId) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return [];
  return Product.find({
    company_id: companyId,
    status: "active",
    deletedAt: null,
    product_name: { $regex: new RegExp(`^${escapeRegex(trimmed)}$`, "i") },
  })
    .select("_id product_name barcode")
    .lean();
}

/** Another non-deleted product in the company already holding this barcode. */
async function findBarcodeConflict(barcode, companyId, excludeId) {
  const trimmed = String(barcode || "").trim();
  if (!trimmed) return null;
  return Product.findOne({
    company_id: companyId,
    deletedAt: null,
    barcode: trimmed,
    _id: { $ne: excludeId },
  })
    .select("_id product_name")
    .lean();
}

/**
 * Update barcodes for existing products by product name.
 *
 * @param {string} text CSV/TSV content with product_name + barcode columns.
 * @param {object} ctx
 * @param {*} ctx.companyId Tenant company id (required).
 * @param {*} [ctx.updatedBy] Acting user id.
 * @param {object} [ctx.options]
 * @param {boolean} [ctx.options.dryRun] Parse + match only, persist nothing.
 * @param {boolean} [ctx.options.overwriteExisting] Update even when product already
 *   has a different barcode (default true). When false, products that already have a
 *   barcode are skipped.
 */
async function updateBarcodesFromText(text, { companyId, updatedBy, options = {} } = {}) {
  const cid = coalesceObjectId(companyId);
  if (!cid) {
    const err = new Error("company_id is required.");
    err.statusCode = 400;
    throw err;
  }

  const parsed = parseBarcodeImportText(text);
  if (!parsed.rows.length) {
    const err = new Error(
      "No rows found. Expected a header row with columns: product_name, barcode.",
    );
    err.statusCode = 400;
    err.details = { columns: BARCODE_IMPORT_COLUMNS };
    throw err;
  }

  const overwriteExisting = options.overwriteExisting !== false;

  const stats = {
    total_rows: parsed.rows.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  const updated = [];
  const skipped = [];
  const failed = [];

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
      columns: BARCODE_IMPORT_COLUMNS,
    };
  }

  // Track barcodes assigned within this same run to avoid duplicate collisions.
  const assignedInRun = new Map();

  for (const row of parsed.rows) {
    try {
      if (!row.barcode) {
        stats.skipped += 1;
        skipped.push({
          line: row.line,
          product_name: row.product_name,
          reason: "empty_barcode",
        });
        continue;
      }

      const matches = await findActiveProductsByName(row.product_name, cid);

      if (matches.length === 0) {
        stats.failed += 1;
        failed.push({
          line: row.line,
          product_name: row.product_name,
          reason: "product_not_found",
        });
        continue;
      }

      if (matches.length > 1) {
        stats.failed += 1;
        failed.push({
          line: row.line,
          product_name: row.product_name,
          reason: "multiple_products_matched",
          matched_count: matches.length,
        });
        continue;
      }

      const product = matches[0];

      if (
        product.barcode &&
        String(product.barcode).trim() === row.barcode
      ) {
        stats.skipped += 1;
        skipped.push({
          line: row.line,
          product_id: product._id,
          product_name: product.product_name,
          reason: "unchanged",
          barcode: row.barcode,
        });
        continue;
      }

      if (
        product.barcode &&
        String(product.barcode).trim() &&
        !overwriteExisting
      ) {
        stats.skipped += 1;
        skipped.push({
          line: row.line,
          product_id: product._id,
          product_name: product.product_name,
          reason: "already_has_barcode",
          existing_barcode: product.barcode,
        });
        continue;
      }

      const dupInRun = assignedInRun.get(row.barcode);
      if (dupInRun && String(dupInRun) !== String(product._id)) {
        stats.failed += 1;
        failed.push({
          line: row.line,
          product_name: row.product_name,
          reason: "duplicate_barcode_in_file",
          barcode: row.barcode,
        });
        continue;
      }

      const conflict = await findBarcodeConflict(row.barcode, cid, product._id);
      if (conflict) {
        stats.failed += 1;
        failed.push({
          line: row.line,
          product_name: row.product_name,
          reason: "barcode_in_use",
          barcode: row.barcode,
          used_by_product_id: conflict._id,
          used_by_product_name: conflict.product_name,
        });
        continue;
      }

      const setFields = { barcode: row.barcode };
      if (updatedBy) setFields.updated_by = coalesceObjectId(updatedBy);

      await Product.updateOne({ _id: product._id }, { $set: setFields });
      assignedInRun.set(row.barcode, product._id);

      stats.updated += 1;
      updated.push({
        line: row.line,
        product_id: product._id,
        product_name: product.product_name,
        previous_barcode: product.barcode || null,
        barcode: row.barcode,
      });
    } catch (err) {
      stats.failed += 1;
      failed.push({
        line: row.line,
        product_name: row.product_name,
        error: err?.message || String(err),
      });
    }
  }

  return {
    company_id: String(cid),
    summary: stats,
    updated,
    skipped,
    failed,
    columns: BARCODE_IMPORT_COLUMNS,
  };
}

module.exports = {
  BARCODE_IMPORT_COLUMNS,
  parseBarcodeImportText,
  updateBarcodesFromText,
};

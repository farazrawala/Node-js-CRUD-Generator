const Product = require("../models/product");
const { coalesceObjectId } = require("./modelHelper");
const { findExistingProduct } = require("./processHelpers");
const { createPurchaseOrderForImportStock } = require("./productImportPurchase");
const {
  parseCsvImportText,
  parsePrice,
  parseQty,
} = require("./csvDelimitedParse");

const PO_IMPORT_COLUMNS = {
  product_name: ["product_name", "product name", "name", "product", "title"],
  wholesale_price: [
    "wholesale_price",
    "wholesale",
    "cost",
    "unit_cost",
    "purchase_price",
  ],
  qty: ["qty", "quantity", "stock", "opening_stock", "opening_qty"],
  price: ["price", "product_price", "sale_price", "amount", "mrp", "retail_price"],
  category: ["category", "cat", "category_name"],
  sku: ["sku", "product_code", "code", "barcode"],
};

function parsePurchaseOrderImportText(text, { defaultQty = 0 } = {}) {
  return parseCsvImportText(text, PO_IMPORT_COLUMNS, {
    defaultQty,
    requiredField: "product_name",
    buildRow: ({ read, line, defaultQty: fbQty }) => {
      const product_name = String(read("product_name", 0)).trim();
      if (!product_name) return null;

      return {
        line,
        category: String(read("category")).trim(),
        product_name,
        price: parsePrice(read("price", 2)),
        wholesale_price: parsePrice(read("wholesale_price", 3)),
        qty: parseQty(read("qty", 4), fbQty),
        sku: String(read("sku")).trim(),
      };
    },
  });
}

function resolvePoUnitCost(row) {
  const wholesale = parsePrice(row.wholesale_price);
  if (wholesale > 0) return wholesale;
  return parsePrice(row.price);
}

/**
 * Import one purchase order from CSV (existing products matched by name or sku).
 * Stock is added via purchase_order + inventory_movements only.
 */
async function importPurchaseOrderFromText(text, { companyId, req, options = {} }) {
  const cid = coalesceObjectId(companyId);
  if (!cid) {
    const err = new Error("company_id is required.");
    err.statusCode = 400;
    throw err;
  }

  const parsed = parsePurchaseOrderImportText(text, {
    defaultQty: options.defaultQty ?? 0,
  });

  if (!parsed.rows.length) {
    const err = new Error(
      "No rows found. Expected columns: product_name, wholesale_price, qty.",
    );
    err.statusCode = 400;
    err.details = { columns: PO_IMPORT_COLUMNS };
    throw err;
  }

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
      columns: PO_IMPORT_COLUMNS,
    };
  }

  const stats = {
    total_rows: parsed.rows.length,
    po_lines: 0,
    skipped_zero_qty: 0,
    product_not_found: 0,
    failed: 0,
  };

  const stockLines = [];
  const matched = [];
  const skipped = [];
  const notFound = [];
  const failed = [];

  const updateProductPrices = options.updateProductPrices !== false;

  for (const row of parsed.rows) {
    try {
      const unitCost = resolvePoUnitCost(row);
      if (row.qty <= 0) {
        stats.skipped_zero_qty += 1;
        skipped.push({
          line: row.line,
          product_name: row.product_name,
          reason: "zero_qty",
        });
        continue;
      }

      const product = await findExistingProduct(row.sku, row.product_name, cid);
      if (!product) {
        stats.product_not_found += 1;
        notFound.push({
          line: row.line,
          product_name: row.product_name,
          sku: row.sku || null,
        });
        continue;
      }

      if (updateProductPrices) {
        const productUpdate = {};
        if (row.price > 0) {
          productUpdate.product_price = row.price;
          productUpdate.price_before_tax = row.price;
        }
        if (unitCost > 0) {
          productUpdate.wholesale_price = unitCost;
        }
        if (Object.keys(productUpdate).length) {
          await Product.updateOne({ _id: product._id }, { $set: productUpdate });
        }
      }

      stockLines.push({
        product_id: product._id,
        product_name: product.product_name,
        qty: row.qty,
        price: unitCost,
      });

      stats.po_lines += 1;
      matched.push({
        line: row.line,
        product_id: product._id,
        product_name: product.product_name,
        wholesale_price: unitCost,
        qty: row.qty,
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

  let purchaseOrder = null;
  if (stockLines.length && req) {
    purchaseOrder = await createPurchaseOrderForImportStock({
      req,
      companyId: cid,
      lines: stockLines,
      warehouseId: options.warehouseId,
      vendorId: options.vendorId,
      description:
        options.purchaseDescription ||
        `PO CSV import — ${stockLines.length} item(s)`,
    });
  } else if (stockLines.length && !req) {
    purchaseOrder = {
      skipped: true,
      reason: "missing_req",
      message: "Purchase order import requires request context.",
    };
  } else {
    purchaseOrder = {
      skipped: true,
      reason: "no_po_lines",
      message: "No rows with qty > 0 and matching products; purchase order not created.",
    };
  }

  return {
    company_id: String(cid),
    summary: stats,
    matched,
    skipped,
    not_found: notFound,
    failed,
    purchase_order: purchaseOrder,
    columns: PO_IMPORT_COLUMNS,
  };
}

module.exports = {
  PO_IMPORT_COLUMNS,
  parsePurchaseOrderImportText,
  importPurchaseOrderFromText,
};

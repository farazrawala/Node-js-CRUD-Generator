const { importParsedProductRows } = require("../productCsvImport");
const { SHOPIFY_IMPORT_COLUMNS } = require("./columns");
const { parseShopifyProductCsv } = require("./parseShopifyProductCsv");

async function importShopifyProductsFromText(
  text,
  { companyId, createdBy, req, options = {} },
) {
  const parsed = parseShopifyProductCsv(text, {
    defaultQty: options.defaultQty ?? 0,
    importDrafts: options.importDrafts === true,
    importArchived: options.importArchived === true,
  });

  if (!parsed.rows.length) {
    const err = new Error("No Shopify product variants found to import.");
    err.statusCode = 400;
    err.details = { parse_stats: parsed.stats, columns: SHOPIFY_IMPORT_COLUMNS };
    throw err;
  }

  const result = await importParsedProductRows(parsed.rows, {
    companyId,
    createdBy,
    req,
    options: {
      ...options,
      columns: SHOPIFY_IMPORT_COLUMNS,
    },
  });

  return {
    ...result,
    shopify_parse_stats: parsed.stats,
  };
}

module.exports = { importShopifyProductsFromText };

/**
 * Convert Shopify Admin "Orders export" CSV → Matrixify Orders import CSV.
 *
 * Shopify Admin export cannot be imported directly into Matrixify.
 * This script maps the export columns to Matrixify's Orders template.
 *
 * Usage:
 *   node scripts/convert-shopify-orders-export-to-matrixify.js
 *   node scripts/convert-shopify-orders-export-to-matrixify.js --input data/orders_export_1/orders_export_1.csv --output data/orders_export_1/Orders-matrixify.csv
 *   node scripts/convert-shopify-orders-export-to-matrixify.js --command MERGE
 *   node scripts/convert-shopify-orders-export-to-matrixify.js --skip-first 10   # skip orders already imported
 *
 * Then in destination Shopify store:
 *   1. Install Matrixify
 *   2. Import the generated Orders-matrixify.csv (filename must contain "Orders")
 *   3. Start with a small file / --limit first
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT = path.resolve(
  process.cwd(),
  "data/orders_export_1/orders_export_1.csv",
);
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  "data/orders_export_1/Orders-matrixify.csv",
);

function readArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

/** Minimal RFC 4180 CSV parser (handles quoted fields with commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCsv(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(row) {
  return row.map(escapeCsv).join(",");
}

function pick(row, key) {
  const v = row[key];
  return v == null ? "" : String(v).trim();
}

function mapPaymentStatus(financialStatus, cancelledAt) {
  const s = String(financialStatus || "").toLowerCase();
  if (cancelledAt) return "voided";
  if (s === "paid") return "paid";
  if (s === "refunded" || s === "partially_refunded") return "refunded";
  if (s === "voided") return "voided";
  return "pending";
}

/** Shopify Admin export uses fulfilled/unfulfilled; Matrixify import expects success/cancelled/open/pending/etc. */
function mapOrderFulfillmentStatus(shopifyStatus) {
  const s = String(shopifyStatus || "").toLowerCase();
  if (s === "fulfilled") return "success";
  if (s === "cancelled") return "cancelled";
  if (s === "partial") return "open";
  // unfulfilled / blank — omit so Shopify keeps default unfulfilled state
  return "";
}

function mapLineFulfillmentStatus(shopifyStatus) {
  const s = String(shopifyStatus || "").toLowerCase();
  if (s === "fulfilled") return "success";
  if (s === "cancelled") return "cancelled";
  if (s === "pending" || s === "unfulfilled") return "pending";
  if (s === "partial") return "open";
  return "";
}

const OUT_HEADERS = [
  "Name",
  "Command",
  "Processed At",
  "Currency",
  "Payment: Status",
  "Fulfillment: Status",
  "Tags",
  "Note",
  "Cancelled At",
  "Customer: Email",
  "Phone",
  "Billing: Name",
  "Billing: Address 1",
  "Billing: Address 2",
  "Billing: City",
  "Billing: Zip",
  "Billing: Province",
  "Billing: Country",
  "Billing: Phone",
  "Shipping: Name",
  "Shipping: Address 1",
  "Shipping: Address 2",
  "Shipping: City",
  "Shipping: Zip",
  "Shipping: Province",
  "Shipping: Country",
  "Shipping: Phone",
  "Line: Type",
  "Line: Title",
  "Line: SKU",
  "Line: Quantity",
  "Line: Price",
  "Line: Fulfillment Status",
  "Source Identifier",
];

function emptyOutRow() {
  return Object.fromEntries(OUT_HEADERS.map((h) => [h, ""]));
}

function orderHeaderFromRow(row, command = "NEW") {
  const o = emptyOutRow();
  o.Name = pick(row, "Name");
  o.Command = command;
  o["Processed At"] = pick(row, "Created at");
  o.Currency = pick(row, "Currency") || "PKR";
  o["Payment: Status"] = mapPaymentStatus(
    pick(row, "Financial Status"),
    pick(row, "Cancelled at"),
  );
  o["Fulfillment: Status"] = mapOrderFulfillmentStatus(
    pick(row, "Fulfillment Status"),
  );
  o.Tags = pick(row, "Tags");
  o.Note = pick(row, "Notes");
  o["Cancelled At"] = pick(row, "Cancelled at");
  o["Customer: Email"] = pick(row, "Email");
  o.Phone = pick(row, "Phone") || pick(row, "Billing Phone");
  o["Billing: Name"] = pick(row, "Billing Name");
  o["Billing: Address 1"] = pick(row, "Billing Address1") || pick(row, "Billing Street");
  o["Billing: Address 2"] = pick(row, "Billing Address2");
  o["Billing: City"] = pick(row, "Billing City");
  o["Billing: Zip"] = pick(row, "Billing Zip");
  o["Billing: Province"] =
    pick(row, "Billing Province Name") || pick(row, "Billing Province");
  o["Billing: Country"] = pick(row, "Billing Country");
  o["Billing: Phone"] = pick(row, "Billing Phone");
  o["Shipping: Name"] = pick(row, "Shipping Name");
  o["Shipping: Address 1"] =
    pick(row, "Shipping Address1") || pick(row, "Shipping Street");
  o["Shipping: Address 2"] = pick(row, "Shipping Address2");
  o["Shipping: City"] = pick(row, "Shipping City");
  o["Shipping: Zip"] = pick(row, "Shipping Zip");
  o["Shipping: Province"] =
    pick(row, "Shipping Province Name") || pick(row, "Shipping Province");
  o["Shipping: Country"] = pick(row, "Shipping Country");
  o["Shipping: Phone"] = pick(row, "Shipping Phone");
  o["Source Identifier"] = pick(row, "Id") || pick(row, "Name");
  return o;
}

function lineItemFromRow(row, includeHeader, command = "NEW") {
  const o = includeHeader ? orderHeaderFromRow(row, command) : emptyOutRow();
  if (!includeHeader) o.Name = pick(row, "Name");
  o["Line: Type"] = "Line Item";
  o["Line: Title"] = pick(row, "Lineitem name");
  o["Line: SKU"] = pick(row, "Lineitem sku");
  o["Line: Quantity"] = pick(row, "Lineitem quantity") || "1";
  o["Line: Price"] = pick(row, "Lineitem price");
  o["Line: Fulfillment Status"] = mapLineFulfillmentStatus(
    pick(row, "Lineitem fulfillment status"),
  );
  return o;
}

function shippingLineFromOrder(headerRow) {
  const shipping = pick(headerRow, "Shipping");
  const method = pick(headerRow, "Shipping Method") || "Shipping";
  if (!shipping || Number(shipping) === 0) return null;
  const o = emptyOutRow();
  o.Name = pick(headerRow, "Name");
  o["Line: Type"] = "Shipping Line";
  o["Line: Title"] = method;
  o["Line: Quantity"] = "1";
  o["Line: Price"] = shipping;
  return o;
}

function toCsvRow(obj) {
  return OUT_HEADERS.map((h) => obj[h] ?? "");
}

function main() {
  const inputPath = path.resolve(readArg("--input", DEFAULT_INPUT));
  const outputPath = path.resolve(readArg("--output", DEFAULT_OUTPUT));
  const limit = Number(readArg("--limit", "0")) || 0;
  const skipFirst = Number(readArg("--skip-first", "0")) || 0;
  const command = String(readArg("--command", "NEW")).toUpperCase();
  const allowedCommands = new Set(["NEW", "MERGE", "UPDATE", "REPLACE", "IGNORE"]);
  if (!allowedCommands.has(command)) {
    console.error(`Invalid --command "${command}". Use NEW, MERGE, UPDATE, REPLACE, or IGNORE.`);
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error("Input file not found:", inputPath);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const table = parseCsv(raw);
  if (!table.length) {
    console.error("CSV is empty.");
    process.exit(1);
  }

  const headers = table[0];
  const records = [];
  for (let r = 1; r < table.length; r += 1) {
    if (limit && r > limit) break;
    const arr = table[r];
    const row = Object.fromEntries(headers.map((h, i) => [h, arr[i] ?? ""]));
    if (!pick(row, "Name")) continue;
    records.push(row);
  }

  const byOrder = new Map();
  for (const row of records) {
    const name = pick(row, "Name");
    if (!byOrder.has(name)) byOrder.set(name, []);
    byOrder.get(name).push(row);
  }

  const orderEntries = [...byOrder.entries()];
  const selectedOrders =
    skipFirst > 0 ? orderEntries.slice(skipFirst) : orderEntries;

  const outRows = [OUT_HEADERS];
  let orderCount = 0;
  let lineCount = 0;

  for (const [, rows] of selectedOrders) {
    orderCount += 1;
    const headerRow =
      rows.find((r) => pick(r, "Currency") || pick(r, "Total")) || rows[0];

    rows.forEach((row, idx) => {
      if (!pick(row, "Lineitem name")) return;
      outRows.push(toCsvRow(lineItemFromRow(row, idx === 0, command)));
      lineCount += 1;
    });

    const ship = shippingLineFromOrder(headerRow);
    if (ship) outRows.push(toCsvRow(ship));
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${outRows.map(rowToCsv).join("\n")}\n`,
    "utf8",
  );

  console.log("Conversion complete.");
  console.log("  Input:", inputPath);
  console.log("  Output:", outputPath);
  console.log("  Command:", command);
  if (skipFirst) console.log("  Skipped first orders:", skipFirst);
  console.log("  Orders:", orderCount);
  console.log("  Matrixify rows (incl. header):", outRows.length);
  console.log("  Line items:", lineCount);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Import products/SKUs into destination store first");
  console.log("  2. Matrixify → Import → upload:", outputPath);
  console.log("  3. Test with --limit 100 first, then run full conversion");
}

main();

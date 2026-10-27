/**
 * Build a Shopify image-update CSV from a product export.
 *
 * The current importer reads "Product image URL", not "Image Src".
 * Products that already have variants also need Option1 name / Option1 value,
 * or the import fails with "Product options input is required when updating variants".
 * Price, stock, vendor, and description are left out so those fields stay as they are.
 *
 * Usage:
 *   node scripts/build-shopify-image-import-csv.js <export.csv> [out.csv]
 */
const fs = require("fs");
const path = require("path");

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(headers, aliases) {
  const wanted = new Set(aliases.map(normalizeHeader));
  return headers.findIndex((header) => wanted.has(normalizeHeader(header)));
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function cellAt(cells, index) {
  if (index == null || index < 0) return "";
  return String(cells[index] || "").trim();
}

function readOption(cells, columns, slot) {
  return {
    name: cellAt(cells, columns.optionName[slot]),
    value: cellAt(cells, columns.optionValue[slot]),
  };
}

function collectProducts(rows, columns) {
  const products = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const handle = cellAt(cells, columns.handle);
    if (!handle) continue;

    if (!products.has(handle)) {
      products.set(handle, {
        handle,
        title: "",
        optionNames: ["", "", ""],
        lines: [],
        seenImages: new Set(),
      });
    }
    const product = products.get(handle);
    const title = cellAt(cells, columns.title);
    if (title && !product.title) product.title = title;

    const options = [0, 1, 2].map((slot) => readOption(cells, columns, slot));
    options.forEach((option, slot) => {
      if (option.name && !product.optionNames[slot]) {
        product.optionNames[slot] = option.name;
      }
    });

    const imageUrl = cellAt(cells, columns.image);
    const variantImage = cellAt(cells, columns.variantImage);
    const alt = cellAt(cells, columns.alt);
    const position = Number(cellAt(cells, columns.position));
    const hasVariant = options.some((option) => option.value);
    const urls = [imageUrl, variantImage].filter(
      (url) => /^https?:\/\//i.test(url) && !product.seenImages.has(url),
    );

    if (!hasVariant && !urls.length) continue;

    if (!urls.length) {
      product.lines.push({
        values: options.map((option) => option.value),
        url: "",
        alt: "",
        position: null,
      });
      continue;
    }

    urls.forEach((url, index) => {
      product.seenImages.add(url);
      product.lines.push({
        values: index === 0 && hasVariant ? options.map((option) => option.value) : ["", "", ""],
        url,
        alt,
        position: Number.isFinite(position) && position > 0 ? position : null,
      });
    });
  }

  return products;
}

function buildImageImportCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("CSV is empty.");

  const headers = rows[0];
  const columns = {
    handle: findColumn(headers, ["handle", "url handle"]),
    title: findColumn(headers, ["title"]),
    image: findColumn(headers, ["image src", "product image url"]),
    position: findColumn(headers, ["image position"]),
    alt: findColumn(headers, ["image alt text"]),
    variantImage: findColumn(headers, ["variant image", "variant image url"]),
    optionName: [0, 1, 2].map((slot) =>
      findColumn(headers, [`option${slot + 1} name`]),
    ),
    optionValue: [0, 1, 2].map((slot) =>
      findColumn(headers, [`option${slot + 1} value`]),
    ),
  };

  if (columns.handle < 0 || columns.title < 0 || columns.image < 0) {
    throw new Error(
      "Not a Shopify product export. Expected Handle/URL handle, Title, and Image Src/Product image URL.",
    );
  }

  const products = collectProducts(rows, columns);
  const optionSlots = [0, 1, 2].filter((slot) =>
    [...products.values()].some((product) => product.optionNames[slot]),
  );
  const header = ["URL handle", "Title"];
  optionSlots.forEach((slot) => {
    header.push(`Option${slot + 1} name`, `Option${slot + 1} value`);
  });
  header.push("Product image URL", "Image position", "Image alt text");

  const lines = [header.join(",")];
  let imageCount = 0;
  let skipped = 0;

  for (const product of products.values()) {
    const imageLines = product.lines.filter((line) => line.url);
    if (!product.title || !imageLines.length) {
      skipped += 1;
      continue;
    }
    let imagePosition = 0;
    product.lines.forEach((line, index) => {
      if (line.url) imagePosition += 1;
      const out = [
        csvCell(product.handle),
        csvCell(index === 0 ? product.title : ""),
      ];
      optionSlots.forEach((slot) => {
        out.push(
          csvCell(index === 0 ? product.optionNames[slot] : ""),
          csvCell(line.values[slot] || ""),
        );
      });
      out.push(
        csvCell(line.url),
        line.url ? String(line.position || imagePosition) : "",
        csvCell(line.url ? line.alt : ""),
      );
      lines.push(out.join(","));
      if (line.url) imageCount += 1;
    });
  }

  return {
    csv: `${lines.join("\n")}\n`,
    products: products.size - skipped,
    images: imageCount,
    skipped,
  };
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error(
      "Usage: node scripts/build-shopify-image-import-csv.js <export.csv> [out.csv]",
    );
    process.exit(1);
  }
  const output =
    process.argv[3] ||
    input.replace(/\.csv$/i, "") + "_images_only.csv";
  const text = fs.readFileSync(input, "utf8");
  const result = buildImageImportCsv(text);
  fs.writeFileSync(output, result.csv, "utf8");
  console.log(
    `Wrote ${result.products} products, ${result.images} images, skipped ${result.skipped} without title or image.`,
  );
  console.log(path.resolve(output));
}

if (require.main === module) {
  main();
}

module.exports = { buildImageImportCsv, parseCsv };

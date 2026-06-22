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

function mapHeaderIndexes(headers, columnDefs) {
  const normalized = headers.map(normalizeHeader);
  const indexes = {};

  for (const [field, aliases] of Object.entries(columnDefs)) {
    const aliasSet = new Set(aliases.map(normalizeHeader));
    const idx = normalized.findIndex((h) => aliasSet.has(h));
    if (idx >= 0) indexes[field] = idx;
  }

  return indexes;
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

/**
 * Parse CSV/TSV rows using a column definition map.
 * @param {string} text
 * @param {Record<string, string[]>} columnDefs
 * @param {{ defaultQty?: number, requiredField?: string, buildRow: Function }} options
 */
function parseCsvImportText(text, columnDefs, options = {}) {
  const {
    defaultQty = 0,
    requiredField = "product_name",
    buildRow,
  } = options;

  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return { rows: [], delimiter: "\t", hasHeader: false, columns: columnDefs };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseDelimitedLine(lines[0], delimiter);
  const indexes = mapHeaderIndexes(headerCells, columnDefs);
  const hasHeader = indexes[requiredField] != null;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const rows = [];

  for (let i = 0; i < dataLines.length; i += 1) {
    const cells = parseDelimitedLine(dataLines[i], delimiter);
    const read = (field, fallbackIdx) => {
      if (indexes[field] != null) return cells[indexes[field]] ?? "";
      if (fallbackIdx != null) return cells[fallbackIdx] ?? "";
      return "";
    };

    const row = buildRow({
      read,
      line: hasHeader ? i + 2 : i + 1,
      defaultQty,
    });
    if (row) rows.push(row);
  }

  return { rows, delimiter, hasHeader, columns: columnDefs };
}

module.exports = {
  normalizeHeader,
  detectDelimiter,
  parseDelimitedLine,
  mapHeaderIndexes,
  parsePrice,
  parseQty,
  parseCsvImportText,
};

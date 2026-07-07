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

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readCell(cells, indexes, field) {
  if (indexes[field] == null) return "";
  return cells[indexes[field]] ?? "";
}

module.exports = {
  parsePrice,
  parseQty,
  stripHtml,
  readCell,
};

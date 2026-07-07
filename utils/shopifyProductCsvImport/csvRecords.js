const { parseDelimitedLine } = require("./csvLineParser");

/** Split Shopify CSV into logical records (supports multi-line quoted HTML fields). */
function parseCsvRecords(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  const records = [];
  let buffer = "";
  let startLine = 1;

  const quoteCountOutsidePairs = (s) => {
    let count = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] !== '"') continue;
      if (s[i + 1] === '"') {
        i += 1;
        continue;
      }
      count += 1;
    }
    return count;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    if (!buffer) {
      buffer = lines[i];
      startLine = lineNo;
    } else {
      buffer += `\n${lines[i]}`;
    }

    if (quoteCountOutsidePairs(buffer) % 2 === 0) {
      if (buffer.trim()) {
        records.push({ line: startLine, cells: parseDelimitedLine(buffer, ",") });
      }
      buffer = "";
    }
  }

  if (buffer.trim()) {
    records.push({ line: startLine, cells: parseDelimitedLine(buffer, ",") });
  }

  return records;
}

module.exports = { parseCsvRecords };

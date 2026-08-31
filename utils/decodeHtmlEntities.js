/**
 * Decode common HTML entities in plain text (e.g. store category names from imports).
 */
function decodeHtmlEntities(value) {
  if (value == null || typeof value !== "string") return value;
  if (!value.includes("&")) return value;

  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

module.exports = { decodeHtmlEntities };

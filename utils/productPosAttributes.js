/**
 * `pos_attributes` on products (restaurant POS attribute picker).
 * The admin app sends it as a JSON string (multipart and JSON requests alike);
 * this turns it into the array the product schema stores.
 */

function toPrice(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toMaxSelect(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 4 ? n : 1;
}

const isOptional = (g) => g?.optional === true || g?.optional === "true" || g?.optional === 1;

/**
 * `optional: true` = the cashier may skip the attribute or pick one value (max_select is 1).
 * @returns {Array<{ name: string, max_select: number, optional?: boolean, values: Array<{ name: string, price: number|null }> }>|undefined}
 *   undefined when the field was not sent (leave the stored value unchanged).
 */
function parsePosAttributes(raw) {
  if (raw === undefined) return undefined;
  let list = raw;
  if (typeof list === "string") {
    const trimmed = list.trim();
    if (!trimmed) return [];
    try {
      list = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((g) => ({
      name: String(g?.name ?? "").trim(),
      max_select: isOptional(g) ? 1 : toMaxSelect(g?.max_select),
      optional: isOptional(g),
      values: (Array.isArray(g?.values) ? g.values : [])
        .map((v) =>
          typeof v === "string" ?
            { name: v.trim(), price: null }
          : { name: String(v?.name ?? "").trim(), price: toPrice(v?.price) },
        )
        .filter((v) => v.name),
    }))
    .filter((g) => g.name && g.values.length);
}

/** Replace `req.body.pos_attributes` with the parsed array (no-op when absent). */
function normalizePosAttributesInBody(body) {
  if (!body || body.pos_attributes === undefined) return;
  body.pos_attributes = parsePosAttributes(body.pos_attributes);
}

module.exports = { parsePosAttributes, normalizePosAttributesInBody };

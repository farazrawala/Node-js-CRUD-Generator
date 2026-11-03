/**
 * Strip credentials before a Shopify record leaves the API.
 * @module src/shopify/present
 */

const SECRET_KEYS = [
  "access_token_enc",
  "refresh_token_enc",
  "access_token",
  "refresh_token",
  "token",
  "secret",
  "client_secret",
  "api_secret",
  "password",
];

function presentRecord(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const row =
    typeof doc.toObject === "function" ?
      doc.toObject({ virtuals: true })
    : { ...doc };
  for (const key of SECRET_KEYS) delete row[key];
  if (row.integration_id && typeof row.integration_id === "object") {
    row.integration_id = presentRecord(row.integration_id);
  }
  return row;
}

module.exports = {
  presentRecord,
};

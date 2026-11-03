/**
 * Scopes the merchant approves when they install the app.
 * The OrdersHub module is the source of truth (src/shopify/constants.js).
 */
function installedScopes() {
  return require("../src/shopify/constants").installedScopes();
}

module.exports = {
  get SCOPES() {
    return installedScopes();
  },
  installedScopes,
  get SCOPE_STRING() {
    return installedScopes().join(",");
  },
};

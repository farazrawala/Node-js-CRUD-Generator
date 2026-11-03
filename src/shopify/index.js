/**
 * Shopify app module entry. The HTTP routes are mounted from routes/api.js.
 * @module src/shopify
 */

const { startShopifyWorker } = require("./queue");

module.exports = {
  startShopifyWorker,
};

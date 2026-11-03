/**
 * Standalone BullMQ worker. The API process also starts this when
 * SHOPIFY_WORKER_ENABLED is not false. Run this file under a second PM2 app
 * only when SHOPIFY_WORKER_IN_API=false and the API has the worker disabled.
 */
require("dotenv").config();

const { connectMonogodb } = require("../../connection");
const { startShopifyWorker } = require("./queue");

connectMonogodb()
  .then(() => {
    require("./models");
    startShopifyWorker();
    console.log("[shopify] worker process ready");
  })
  .catch((error) => {
    console.error("[shopify] worker process failed:", error?.message || error);
    process.exit(1);
  });

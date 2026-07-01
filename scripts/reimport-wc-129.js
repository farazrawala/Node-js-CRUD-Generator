require("dotenv").config();
process.env.APP_ENV = "live";

const mongoose = require("mongoose");
const { getMongoUri } = require("../connection");
const Integration = require("../models/integration");
const Product = require("../models/product");
const SyncProduct = require("../models/sync_product");
const {
  buildWooCommerceClient,
  importWooProductToPos,
  resolvePosCategoryIdsFromWooProduct,
  resolveWooProductPrice,
} = require("../controllers/woocommerceProcess");

async function main() {
  await mongoose.connect(getMongoUri());

  const integration = await Integration.findById("6a459115b30edf118f8ba68d").lean();
  const { client } = buildWooCommerceClient(integration);
  const remote = (await client.get("products/129")).data;

  const process = {
    integration_id: integration,
    company_id: integration.company_id,
    created_by: "6a458d9c1ca7456beb274b7c",
  };

  const stats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    variations_fetched: 0,
    variations_inserted: 0,
    variations_updated: 0,
  };

  const categoryCtx = {
    client,
    companyId: integration.company_id,
    process,
    remoteCategoryById: new Map(),
    categoryCache: new Map(),
    stats,
  };

  const productPrice = await resolveWooProductPrice(client, remote);
  const categoryIds = await resolvePosCategoryIdsFromWooProduct(remote, categoryCtx);

  await importWooProductToPos(remote, {
    client,
    companyId: integration.company_id,
    process,
    stats,
    productPrice,
    categoryIds,
  });

  console.log("Import stats:", stats);

  const parentSync = await SyncProduct.findOne({
    integration_id: integration._id,
    refference_id: "129",
    deletedAt: null,
  }).lean();
  const parent = parentSync ?
    await Product.findById(parentSync.product_id).lean()
  : null;

  console.log(
    "Parent:",
    parent &&
      {
        id: String(parent._id),
        type: parent.product_type,
        sku: parent.sku,
        name: parent.product_name,
      },
  );

  const variationSyncs = await SyncProduct.find({
    integration_id: integration._id,
    refference_id: /^129:/,
    deletedAt: null,
  }).lean();

  console.log("Variations synced:", variationSyncs.length);
  for (const row of variationSyncs) {
    const p = await Product.findById(row.product_id).lean();
    console.log(row.refference_id, {
      id: String(p?._id),
      type: p?.product_type,
      sku: p?.sku,
      parent: String(p?.parent_product_id || ""),
      name: p?.product_name,
    });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err?.response?.data || err);
  process.exit(1);
});

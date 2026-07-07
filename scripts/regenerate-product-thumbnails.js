/**
 * Regenerate product_image_thumbnail_url and multi_image_thumbnails for all products.
 *
 * Usage:
 *   node scripts/regenerate-product-thumbnails.js
 *   node scripts/regenerate-product-thumbnails.js --company-id YOUR_ID
 *   node scripts/regenerate-product-thumbnails.js --limit 100
 */

require("dotenv").config();

const Product = require("../models/product");
const { connectMonogodb } = require("../connection");
const { buildProductThumbnailFields } = require("../utils/productImageThumbnail");

function readArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

async function main() {
  const companyId = readArg("--company-id", process.env.SHOPIFY_IMPORT_COMPANY_ID);
  const limit = Number(readArg("--limit", "0")) || 0;
  const force = !process.argv.includes("--skip-force");

  await connectMonogodb();

  const query = {
    deletedAt: null,
    $or: [
      { product_image: { $exists: true, $nin: [null, ""] } },
      { multi_images: { $exists: true, $ne: [] } },
    ],
  };
  if (companyId) query.company_id = companyId;

  let cursor = Product.find(query)
    .select("_id product_name product_image multi_images")
    .lean();

  if (limit > 0) cursor = cursor.limit(limit);

  const products = await cursor;
  console.log(`Regenerating thumbnails for ${products.length} product(s)...`);
  console.log(`Width: ${process.env.PRODUCT_THUMB_WIDTH || 70}px, force: ${force}`);

  let updated = 0;
  let skipped = 0;

  for (const product of products) {
    const thumbFields = await buildProductThumbnailFields(
      {
        product_image: product.product_image,
        multi_images: product.multi_images,
      },
      { force },
    );

    const hasThumb =
      Boolean(thumbFields.product_image_thumbnail_url) ||
      (Array.isArray(thumbFields.multi_image_thumbnails) &&
        thumbFields.multi_image_thumbnails.some(Boolean));

    if (!hasThumb) {
      skipped += 1;
      continue;
    }

    await Product.updateOne(
      { _id: product._id },
      { $set: thumbFields },
    );
    updated += 1;

    if (updated % 50 === 0) {
      console.log(`  ... ${updated} updated`);
    }
  }

  console.log(`Done. Updated: ${updated}, skipped: ${skipped}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

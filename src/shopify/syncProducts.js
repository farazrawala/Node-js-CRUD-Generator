/**
 * Import Shopify products into POS products and push POS edits back.
 * Mapping rows live in shopify_products and the existing sync_product collection.
 * @module src/shopify/syncProducts
 */

const Product = require("../../models/product");
const SyncProduct = require("../../models/sync_product");
const Category = require("../../models/category");
const { coalesceObjectId } = require("../../utils/modelHelper");
const { numericId } = require("./orderMapper");
const { ShopifyProduct } = require("./models");
const { adminClient } = require("./connectionService");
const { openSyncLog, finishSyncLog } = require("./syncLog");

const PRODUCT_PAGE = `
  query ShopifyProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        legacyResourceId
        title
        descriptionHtml
        status
        productType
        featuredMedia {
          preview { image { url } }
        }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            sku
            barcode
            price
            inventoryQuantity
            inventoryItem {
              id
              tracked
              unitCost { amount }
            }
          }
        }
      }
    }
  }
`;

function imageUrl(product) {
  return product?.featuredMedia?.preview?.image?.url || "";
}

function posStatus(shopifyStatus) {
  return String(shopifyStatus || "").toUpperCase() === "ACTIVE"
    ? "active"
    : "inactive";
}

async function ensureCategory(companyId, userId, name) {
  const label = String(name || "").trim();
  if (label.length < 2) return null;
  const existing = await Category.findOne({
    company_id: companyId,
    name: label,
    deletedAt: null,
  })
    .select("_id")
    .lean();
  if (existing) return existing._id;
  const created = await Category.create({
    name: label.slice(0, 100),
    company_id: companyId,
    created_by: userId || undefined,
    status: "active",
  });
  return created._id;
}

async function rememberMapping({
  connection,
  productId,
  variantId,
  inventoryItemId,
  posProductId,
  parentPosProductId,
  sku,
  barcode,
  title,
  status,
  tracked,
}) {
  const shopifyId = variantId || productId;
  await ShopifyProduct.findOneAndUpdate(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      shopify_id: shopifyId,
    },
    {
      $set: {
        shopify_product_id: productId,
        shopify_variant_id: variantId || "",
        inventory_item_id: inventoryItemId || "",
        pos_product_id: posProductId || undefined,
        parent_pos_product_id: parentPosProductId || undefined,
        sku: sku || "",
        barcode: barcode || "",
        title: title || "",
        status: status || "active",
        tracked: Boolean(tracked),
      },
    },
    { upsert: true },
  );
  if (!posProductId || !connection.integration_id) return;
  const reference = variantId ? `${productId}:${variantId}` : productId;
  await SyncProduct.findOneAndUpdate(
    {
      company_id: connection.company_id,
      integration_id: connection.integration_id,
      product_id: posProductId,
    },
    {
      $set: {
        refference_id: reference,
        status: "active",
        deletedAt: null,
      },
      $setOnInsert: {
        company_id: connection.company_id,
        integration_id: connection.integration_id,
        product_id: posProductId,
        created_by: connection.installed_by || undefined,
      },
    },
    { upsert: true },
  );
}

async function findPosProduct({ companyId, integrationId, reference, sku, barcode }) {
  if (reference && integrationId) {
    const mapped = await SyncProduct.findOne({
      company_id: companyId,
      integration_id: integrationId,
      refference_id: reference,
      deletedAt: null,
    })
      .select("product_id")
      .lean();
    if (mapped?.product_id) {
      const product = await Product.findOne({
        _id: mapped.product_id,
        company_id: companyId,
        deletedAt: null,
      });
      if (product) return product;
    }
  }
  if (sku) {
    const bySku = await Product.findOne({
      company_id: companyId,
      sku,
      deletedAt: null,
    });
    if (bySku) return bySku;
  }
  if (barcode) {
    return Product.findOne({
      company_id: companyId,
      barcode,
      deletedAt: null,
    });
  }
  return null;
}

function blankIfTaken(value) {
  const text = String(value || "").trim();
  return text || undefined;
}

async function savePosProduct(existing, fields) {
  if (existing) {
    Object.assign(existing, fields);
    if (!fields.sku) existing.sku = existing.sku || undefined;
    await existing.save();
    return { doc: existing, created: false };
  }
  const doc = await Product.create(fields);
  return { doc, created: true };
}

async function upsertVariant({
  connection,
  remote,
  variant,
  parentId,
  categoryId,
  userId,
  stats,
}) {
  const productId = String(remote.legacyResourceId || numericId(remote.id));
  const variantId = String(variant.legacyResourceId || numericId(variant.id));
  const reference = `${productId}:${variantId}`;
  const sku = String(variant.sku || "").trim();
  const barcode = String(variant.barcode || "").trim();
  const existing = await findPosProduct({
    companyId: connection.company_id,
    integrationId: connection.integration_id,
    reference,
    sku,
    barcode,
  });
  const cost = Number(variant.inventoryItem?.unitCost?.amount);
  const fields = {
    product_name: parentId
      ? `${remote.title} - ${variant.sku || variantId}`.slice(0, 180)
      : remote.title,
    product_description: remote.descriptionHtml || "",
    product_price: Number(variant.price) || 0,
    product_type: "Single",
    unit: existing?.unit || "Piece",
    status: posStatus(remote.status),
    company_id: connection.company_id,
    parent_product_id: parentId || undefined,
    product_image: imageUrl(remote) || existing?.product_image || "",
    updated_by: userId || undefined,
  };
  if (!existing) fields.created_by = userId || undefined;
  if (Number.isFinite(cost)) fields.wholesale_price = cost;
  if (sku && (!existing || existing.sku === sku || !existing.sku)) fields.sku = sku;
  if (barcode && (!existing || existing.barcode === barcode || !existing.barcode)) {
    fields.barcode = barcode;
  }
  if (categoryId) fields.category_id = [categoryId];

  let saved;
  try {
    saved = await savePosProduct(existing, fields);
  } catch (error) {
    if (!/duplicate key/i.test(error?.message || "")) throw error;
    fields.sku = blankIfTaken(existing?.sku);
    fields.barcode = undefined;
    saved = await savePosProduct(existing, fields);
    stats.warnings += 1;
  }
  if (saved.created) stats.inserted += 1;
  else stats.updated += 1;

  await rememberMapping({
    connection,
    productId,
    variantId,
    inventoryItemId: numericId(variant.inventoryItem?.id),
    posProductId: saved.doc._id,
    parentPosProductId: parentId,
    sku,
    barcode,
    title: fields.product_name,
    status: fields.status,
    tracked: variant.inventoryItem?.tracked,
  });
  return saved.doc;
}

async function importProductNode(connection, remote, userId, stats) {
  const variants = remote?.variants?.nodes || [];
  if (!remote?.title || !variants.length) {
    stats.skipped += 1;
    return;
  }
  const categoryId = await ensureCategory(
    connection.company_id,
    userId,
    remote.productType,
  );
  const productId = String(remote.legacyResourceId || numericId(remote.id));
  if (variants.length === 1) {
    await upsertVariant({
      connection,
      remote,
      variant: variants[0],
      parentId: null,
      categoryId,
      userId,
      stats,
    });
    return;
  }

  const parent = await findPosProduct({
    companyId: connection.company_id,
    integrationId: connection.integration_id,
    reference: productId,
  });
  const parentFields = {
    product_name: remote.title,
    product_description: remote.descriptionHtml || "",
    product_price: Number(variants[0].price) || 0,
    product_type: "Variable",
    unit: parent?.unit || "Piece",
    status: posStatus(remote.status),
    company_id: connection.company_id,
    product_image: imageUrl(remote) || parent?.product_image || "",
    updated_by: userId || undefined,
  };
  if (!parent) parentFields.created_by = userId || undefined;
  if (categoryId) parentFields.category_id = [categoryId];
  const savedParent = await savePosProduct(parent, parentFields);
  if (savedParent.created) stats.inserted += 1;
  else stats.updated += 1;
  await rememberMapping({
    connection,
    productId,
    variantId: "",
    posProductId: savedParent.doc._id,
    sku: "",
    title: remote.title,
    status: parentFields.status,
  });
  for (const variant of variants) {
    await upsertVariant({
      connection,
      remote,
      variant,
      parentId: savedParent.doc._id,
      categoryId,
      userId,
      stats,
    });
  }
}

async function importProductById(connection, productId, userId) {
  const client = await adminClient(connection);
  const data = await client.query(
    `query ShopifyProduct($id: ID!) {
      product(id: $id) {
        id
        legacyResourceId
        title
        descriptionHtml
        status
        productType
        featuredMedia { preview { image { url } } }
        variants(first: 100) {
          nodes {
            id
            legacyResourceId
            sku
            barcode
            price
            inventoryQuantity
            inventoryItem { id tracked unitCost { amount } }
          }
        }
      }
    }`,
    { id: `gid://shopify/Product/${numericId(productId)}` },
  );
  if (!data?.product) return { skipped: true, reason: "product_not_found" };
  const stats = { inserted: 0, updated: 0, skipped: 0, warnings: 0 };
  await importProductNode(
    connection,
    data.product,
    userId || connection.installed_by,
    stats,
  );
  return stats;
}

async function importProducts(connection, { userId } = {}) {
  if (connection.sync_settings?.product_sync_enabled === false) {
    return { skipped: true, reason: "product_sync_disabled" };
  }
  const { log } = await openSyncLog({
    companyId: connection.company_id,
    shop: connection.shop_domain,
    shopifyId: connection.shopify_id,
    action: "import_products",
    message: "Importing Shopify products",
  });
  const stats = { inserted: 0, updated: 0, skipped: 0, warnings: 0, pages: 0 };
  try {
    const client = await adminClient(connection);
    let cursor = null;
    const maxPages = Number(process.env.SHOPIFY_MAX_PAGES || 200);
    do {
      const data = await client.query(PRODUCT_PAGE, { cursor });
      const page = data?.products;
      for (const node of page?.nodes || []) {
        await importProductNode(
          connection,
          node,
          userId || connection.installed_by,
          stats,
        );
      }
      stats.pages += 1;
      cursor = page?.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor && stats.pages < maxPages);

    const productCount = await ShopifyProduct.countDocuments({
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      status: { $ne: "deleted" },
    });
    connection.product_count = productCount;
    connection.last_product_sync_at = new Date();
    connection.last_sync_at = new Date();
    connection.last_error = "";
    await connection.save();
    await finishSyncLog(log._id, "success", `Imported products (${stats.inserted} new, ${stats.updated} updated).`, stats);
    return stats;
  } catch (error) {
    connection.last_error = error.message;
    await connection.save();
    await finishSyncLog(log._id, "failed", error.message);
    throw error;
  }
}

async function markRemoteProductDeleted(connection, productId) {
  const id = String(productId || "");
  if (!id) return;
  await ShopifyProduct.updateMany(
    {
      company_id: connection.company_id,
      shop_domain: connection.shop_domain,
      shopify_product_id: id,
    },
    { $set: { status: "deleted" } },
  );
  const rows = await ShopifyProduct.find({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    shopify_product_id: id,
    pos_product_id: { $ne: null },
  })
    .select("pos_product_id")
    .lean();
  const ids = rows.map((row) => row.pos_product_id).filter(Boolean);
  if (ids.length) {
    await Product.updateMany(
      { _id: { $in: ids }, company_id: connection.company_id },
      { $set: { status: "inactive" } },
    );
  }
}

async function pushPosProduct(connection, posProductId) {
  const product = await Product.findOne({
    _id: coalesceObjectId(posProductId),
    company_id: connection.company_id,
    deletedAt: null,
  }).lean();
  if (!product) return { skipped: true, reason: "product_not_found" };
  const mapping = await ShopifyProduct.findOne({
    company_id: connection.company_id,
    shop_domain: connection.shop_domain,
    pos_product_id: product._id,
  }).lean();
  const client = await adminClient(connection);
  const status = product.status === "active" ? "ACTIVE" : "DRAFT";
  if (!mapping?.shopify_product_id) {
    const created = await client.query(
      `mutation CreateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id legacyResourceId }
          userErrors { field message }
        }
      }`,
      {
        product: {
          title: product.product_name,
          descriptionHtml: product.product_description || "",
          status,
        },
      },
    );
    const errors = created?.productCreate?.userErrors || [];
    if (errors.length) {
      throw new Error(errors.map((row) => row.message).join("; "));
    }
    const remote = created?.productCreate?.product;
    const productId = String(remote?.legacyResourceId || numericId(remote?.id));
    await rememberMapping({
      connection,
      productId,
      variantId: "",
      posProductId: product._id,
      title: product.product_name,
      status: product.status,
      sku: product.sku,
      barcode: product.barcode,
    });
    return { created: true, shopify_product_id: productId };
  }

  const updated = await client.query(
    `mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }`,
    {
      product: {
        id: `gid://shopify/Product/${mapping.shopify_product_id}`,
        title: product.product_name,
        descriptionHtml: product.product_description || "",
        status,
      },
    },
  );
  const errors = updated?.productUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((row) => row.message).join("; "));
  }
  if (mapping.shopify_variant_id && (product.sku || product.barcode || product.product_price != null)) {
    await client.query(
      `mutation UpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
      {
        productId: `gid://shopify/Product/${mapping.shopify_product_id}`,
        variants: [
          {
            id: `gid://shopify/ProductVariant/${mapping.shopify_variant_id}`,
            price: Number(product.product_price) || 0,
            barcode: product.barcode || null,
            inventoryItem: product.sku ? { sku: product.sku } : undefined,
          },
        ],
      },
    );
  }
  return { updated: true, shopify_product_id: mapping.shopify_product_id };
}

module.exports = {
  importProducts,
  importProductNode,
  importProductById,
  markRemoteProductDeleted,
  pushPosProduct,
};

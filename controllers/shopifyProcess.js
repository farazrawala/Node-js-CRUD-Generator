const Category = require("../models/category");
const Brand = require("../models/brands");
const Product = require("../models/product");
const SyncCategory = require("../models/sync_category");
require("@shopify/shopify-api/adapters/node");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");
const {
  categorySlugFromName,
  resolveCompanyId,
  resolveIntegrationId,
  upsertSyncCategoryMapping,
  upsertSyncBrandMapping,
  resolveBatchPagination,
  findExistingCategoryByName,
  findExistingCategory,
  findExistingBrand,
  findExistingProduct,
  finishFetchCategoryBatch,
  finishFetchBrandBatch,
  finishFetchProductBatch,
  failFetchCategoryBatch,
  failFetchBrandBatch,
  failFetchProductBatch,
  markProcessOutcome,
  coalesceObjectId,
} = require("../utils/processHelpers");

function buildShopifyClient(integration) {
  const rawUrl =
    typeof integration.url === "string" ? integration.url.trim() : "";
  let shopDomain = rawUrl.replace(/^https?:\/\//i, "").replace(/\/$/, "");

  if (!shopDomain) {
    return { error: "Shopify store URL is missing from the integration." };
  }

  if (!/\.myshopify\.com$/i.test(shopDomain)) {
    if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
      shopDomain = `${shopDomain}.myshopify.com`;
    } else {
      return {
        error:
          "Invalid Shopify store URL. Provide the myshopify.com domain or the shop name.",
      };
    }
  }

  const apiKey =
    integration.key || integration.api_key || integration.public_key;
  const apiSecret =
    integration.secret ||
    integration.secret_key ||
    integration.private_key ||
    integration.client_secret;
  const accessToken =
    integration.token || integration.access_token || integration.password;

  if (!apiKey || !apiSecret || !accessToken) {
    return {
      error:
        "Incomplete Shopify credentials. Please verify key, secret, and access token.",
    };
  }

  const shopify = shopifyApi({
    apiKey,
    apiSecretKey: apiSecret,
    adminApiAccessToken: accessToken,
    scopes: ["read_products", "write_products"],
    hostName: shopDomain,
    apiVersion: ApiVersion.October24,
    isCustomStoreApp: true,
  });

  const session = shopify.session.customAppSession(shopDomain);
  session.accessToken = accessToken;

  return {
    client: new shopify.clients.Rest({ session }),
    shopDomain,
  };
}

function validateShopifyIntegration(integration, res) {
  if (!integration || integration.store_type !== "shopify") {
    res.status(400).json({
      success: false,
      message: "Shopify integration details are missing or invalid.",
    });
    return false;
  }
  return true;
}

function mapShopifyProductType(productType) {
  return String(productType || "").toLowerCase() === "variable" ?
      "Variable"
    : "Single";
}

function mapShopifyVariantPrice(variant) {
  if (variant?.price == null || variant.price === "") {
    return 0;
  }
  const price = Number(variant.price);
  return Number.isFinite(price) && price >= 0 ? price : 0;
}

function buildPosFieldsFromShopify(remoteProduct, variant, productPrice) {
  const fields = {
    product_name: String(remoteProduct?.title || "").trim(),
    product_price: productPrice,
    product_description: remoteProduct?.body_html || "",
    product_type: mapShopifyProductType(remoteProduct?.product_type),
  };

  if (variant?.weight != null && variant.weight !== "") {
    fields.weight = Number(variant.weight);
  }

  return fields;
}

async function ensurePosCategoryByName(
  name,
  { companyId, process, referenceId, stats },
) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return null;
  }

  const slug = categorySlugFromName(trimmed);
  const integrationId = resolveIntegrationId(process);

  if (referenceId && integrationId) {
    const syncRow = await SyncCategory.findOne({
      integration_id: integrationId,
      company_id: companyId,
      refference_id: String(referenceId),
      deletedAt: null,
    }).lean();
    if (syncRow?.category_id) {
      return coalesceObjectId(syncRow.category_id);
    }
  }

  const existing =
    (await findExistingCategoryByName(trimmed, companyId)) ||
    (await findExistingCategory(trimmed, slug, companyId));

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    if (referenceId) {
      await upsertSyncCategoryMapping({
        categoryId: posId,
        integrationId,
        companyId,
        referenceId,
        createdBy: process.created_by?._id || process.created_by,
      });
    }
    stats.categories_found = (stats.categories_found || 0) + 1;
    return posId;
  }

  const created = await Category.create({
    name: trimmed,
    slug,
    description: trimmed,
    company_id: companyId,
    status: "active",
    isActive: true,
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });
  const posId = coalesceObjectId(created._id);
  if (referenceId) {
    await upsertSyncCategoryMapping({
      categoryId: posId,
      integrationId,
      companyId,
      referenceId,
      createdBy: process.created_by?._id || process.created_by,
    });
  }
  stats.categories_inserted = (stats.categories_inserted || 0) + 1;
  return posId;
}

async function resolvePosCategoryIdsFromShopifyProduct(
  remoteProduct,
  client,
  categoryCtx,
) {
  const posIds = [];
  const seen = new Set();
  const shopifyId = remoteProduct?.id;

  const addPosId = (posId) => {
    if (!posId) {
      return;
    }
    const key = String(posId);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    posIds.push(posId);
  };

  if (shopifyId) {
    try {
      const collectsResponse = await client.get({
        path: "collects",
        query: { product_id: shopifyId, limit: 250 },
      });
      const collects =
        Array.isArray(collectsResponse?.body?.collects) ?
          collectsResponse.body.collects
        : [];

      for (const collect of collects) {
        const collectionId = collect?.collection_id;
        if (!collectionId) {
          continue;
        }

        let collectionTitle = "";
        try {
          const collectionResponse = await client.get({
            path: `custom_collections/${collectionId}`,
          });
          collectionTitle =
            String(
              collectionResponse?.body?.custom_collection?.title || "",
            ).trim();
        } catch (error) {
          console.warn(
            `Shopify collection ${collectionId} lookup failed:`,
            error?.response?.body || error?.message || error,
          );
        }

        if (!collectionTitle) {
          continue;
        }

        const posId = await ensurePosCategoryByName(collectionTitle, {
          ...categoryCtx,
          referenceId: collectionId,
        });
        addPosId(posId);
      }
    } catch (error) {
      console.warn(
        `Shopify collects lookup failed for product ${shopifyId}:`,
        error?.response?.body || error?.message || error,
      );
    }
  }

  if (posIds.length === 0) {
    const productType = String(remoteProduct?.product_type || "").trim();
    if (productType) {
      const posId = await ensurePosCategoryByName(productType, categoryCtx);
      addPosId(posId);
    }
  }

  return posIds;
}

async function importShopifyProductToPos(
  remoteProduct,
  { companyId, process, stats, productPrice, categoryIds = [] },
) {
  const shopifyId = Number(remoteProduct?.id);
  const name = String(remoteProduct?.title || "").trim();
  if (!name) {
    return null;
  }

  const variant = Array.isArray(remoteProduct?.variants) ?
      remoteProduct.variants[0]
    : null;
  const sku =
    String(variant?.sku || "").trim() ||
    (shopifyId ? `shopify-${shopifyId}` : "");
  const price =
    productPrice !== undefined ?
      productPrice
    : mapShopifyVariantPrice(variant);
  const existing = await findExistingProduct(sku, name, companyId);
  const posFields = buildPosFieldsFromShopify(remoteProduct, variant, price);
  const categoryField = categoryIds.map((id) => coalesceObjectId(id)).filter(Boolean);

  if (existing) {
    const posId = coalesceObjectId(existing._id);
    await Product.updateOne(
      { _id: posId },
      {
        $set: {
          ...posFields,
          sku,
          product_code: sku,
          category_id: categoryField,
        },
      },
    );
    stats.updated = (stats.updated || 0) + 1;
    if (categoryField.length) {
      stats.products_category_linked = (stats.products_category_linked || 0) + 1;
    }
    return posId;
  }

  const created = await Product.create({
    ...posFields,
    sku,
    product_code: sku,
    category_id: categoryField,
    unit: "Piece",
    company_id: companyId,
    status: "active",
    created_by: coalesceObjectId(process.created_by?._id || process.created_by),
  });

  stats.inserted += 1;
  if (categoryField.length) {
    stats.products_category_linked = (stats.products_category_linked || 0) + 1;
  }
  return coalesceObjectId(created._id);
}

/**
 * Import categories from Shopify into POS (batch).
 */
async function fetch_category(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset } = resolveBatchPagination(process);
  const query = { limit, order: "id asc" };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
    const listResponse = await client.get({
      path: "custom_collections",
      query,
    });
    const remoteCategories =
      Array.isArray(listResponse?.body?.custom_collections) ?
        listResponse.body.custom_collections
      : [];

    let inserted = 0;
    let skipped = 0;

    for (const remote of remoteCategories) {
      const name = String(remote?.title || "").trim();
      if (!name) {
        skipped += 1;
        continue;
      }

      const existing = await findExistingCategoryByName(name, companyId);
      if (existing) {
        skipped += 1;
        await upsertSyncCategoryMapping({
          categoryId: existing._id,
          integrationId: resolveIntegrationId(process),
          companyId,
          referenceId: remote.id,
          createdBy: process.created_by?._id || process.created_by,
        });
        continue;
      }

      const created = await Category.create({
        name,
        slug: categorySlugFromName(name),
        description: remote.body_html || "",
        company_id: companyId,
        status: "active",
        isActive: remote.published !== false,
        created_by: coalesceObjectId(
          process.created_by?._id || process.created_by,
        ),
      });
      await upsertSyncCategoryMapping({
        categoryId: created._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId: remote.id,
        createdBy: process.created_by?._id || process.created_by,
      });
      inserted += 1;
    }

    const fetched = remoteCategories.length;
    const isComplete = fetched < limit;
    const lastRemoteId =
      fetched > 0 ? remoteCategories[fetched - 1]?.id : offset;
    const remarks =
      isComplete ?
        `Category import completed: batch fetched ${fetched}, inserted ${inserted}, skipped ${skipped}. Total processed ${(Number(process.count) || 0) + inserted + skipped}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, skipped ${skipped}. Call execute-process again for the next batch.`;

    return finishFetchCategoryBatch(req, res, process, {
      fetched,
      inserted,
      skipped,
      isComplete,
      nextOffset: lastRemoteId || 0,
      remarks,
    });
  } catch (error) {
    console.error(
      "Shopify category fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch categories from Shopify.";
    return failFetchCategoryBatch(process, res, errorPayload, errorPayload);
  }
}

/**
 * Push one POS product to Shopify.
 */
async function sync_product(req, res, process) {
  const integration = process?.integration_id;
  const product = process?.product_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!product) {
    return res.status(400).json({
      success: false,
      message: "Product details are missing from the process payload.",
    });
  }

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const sku =
    (typeof product.sku === "string" && product.sku.trim()) ||
    (typeof product.product_code === "string" && product.product_code.trim()) ||
    (product._id ? String(product._id) : "");

  if (!sku) {
    return res.status(400).json({
      success: false,
      message: "Product SKU or identifier is required to sync with Shopify.",
    });
  }

  try {
    const variantResponse = await client.get({
      path: "variants",
      query: { sku },
    });
    const existingVariants =
      Array.isArray(variantResponse?.body?.variants) ?
        variantResponse.body.variants
      : [];

    if (existingVariants.length > 0) {
      let existingProduct = null;
      const productId = existingVariants[0]?.product_id;
      if (productId) {
        try {
          const productResponse = await client.get({
            path: `products/${productId}`,
          });
          existingProduct = productResponse?.body?.product || null;
        } catch (fetchError) {
          console.warn(
            "Failed to load existing Shopify product details:",
            fetchError?.response?.body || fetchError?.message || fetchError,
          );
        }
      }

      await markProcessOutcome(
        process._id,
        "completed",
        `Product Name : ${product.product_name} already existed on Shopify — skipped creation.`,
      );

      return res.status(200).json({
        success: true,
        data: existingProduct || existingVariants[0],
        message: `Product Name : ${product.product_name} already exists on Shopify.`,
      });
    }

    const variantPayload = {
      price:
        product.product_price !== undefined && product.product_price !== null ?
          String(product.product_price)
        : "0.00",
      sku,
    };

    if (product.weight !== undefined && product.weight !== null) {
      const numericWeight = Number(product.weight);
      if (!Number.isNaN(numericWeight)) {
        variantPayload.weight = numericWeight;
        variantPayload.weight_unit = "g";
      }
    }

    const createdProductResponse = await client.post({
      path: "products",
      data: {
        product: {
          title: product.product_name,
          body_html: product.product_description || "",
          status: "active",
          product_type: product.product_type || "Single",
          variants: [variantPayload],
        },
      },
      type: "json",
    });

    await markProcessOutcome(
      process._id,
      "completed",
      `Product Name : ${product.product_name} created on Shopify.`,
    );

    return res.status(201).json({
      success: true,
      data: createdProductResponse?.body?.product,
      message: `Product Name : ${product.product_name} synced to Shopify successfully.`,
    });
  } catch (error) {
    console.error(
      "Shopify product sync failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Product Name : ${product.product_name} to Shopify.`,
    );

    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      `Failed to sync Product Name : ${product.product_name} to Shopify.`;

    return res.status(500).json({
      success: false,
      message: errorPayload,
      error: errorPayload,
    });
  }
}

/**
 * Push one POS category to Shopify.
 */
async function sync_category(req, res, process) {
  const integration = process?.integration_id;
  const category = process?.category_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!category) {
    return res.status(400).json({
      success: false,
      message:
        "Category is required for sync_category. Set category_id on the process (Admin → Process) or pass ?category_id=<id> on execute-process.",
    });
  }

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  try {
    const title = category.name?.trim();
    if (!title) {
      return res.status(400).json({
        success: false,
        message: "Category name is required to sync with Shopify.",
      });
    }

    const companyId = resolveCompanyId(process);
    const listResponse = await client.get({
      path: "custom_collections",
      query: { title },
    });
    const existing =
      Array.isArray(listResponse?.body?.custom_collections) ?
        listResponse.body.custom_collections
      : [];

    if (existing.length > 0) {
      await upsertSyncCategoryMapping({
        categoryId: category._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId: existing[0].id,
        createdBy: process.created_by?._id || process.created_by,
      });

      await markProcessOutcome(
        process._id,
        "completed",
        `Category : ${title} already existed on Shopify — skipped creation.`,
      );

      return res.status(200).json({
        success: true,
        data: existing[0],
        message: `Category : ${title} already exists on Shopify.`,
      });
    }

    const createdResponse = await client.post({
      path: "custom_collections",
      data: {
        custom_collection: {
          title,
          body_html: category.description || "",
          published: category.isActive !== false,
        },
      },
      type: "json",
    });

    const createdCollection =
      createdResponse?.body?.custom_collection || createdResponse?.body;

    await upsertSyncCategoryMapping({
      categoryId: category._id,
      integrationId: resolveIntegrationId(process),
      companyId,
      referenceId: createdCollection?.id,
      createdBy: process.created_by?._id || process.created_by,
    });

    await markProcessOutcome(
      process._id,
      "completed",
      `Category : ${title} created on Shopify.`,
    );

    return res.status(201).json({
      success: true,
      data: createdCollection,
      message: `Category : ${title} synced to Shopify successfully.`,
    });
  } catch (error) {
    console.error(
      "Shopify category sync failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );

    await markProcessOutcome(
      process._id,
      "failed",
      `Failed to sync Category : ${category.name} to Shopify.`,
    );

    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      `Failed to sync Category : ${category.name} to Shopify.`;

    return res.status(500).json({
      success: false,
      message: errorPayload,
      error: errorPayload,
    });
  }
}

/**
 * Import product vendors from Shopify as POS brands (batch). Store → POS.
 */
async function fetch_brand(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset, page } = resolveBatchPagination(process);
  const query = { limit, fields: "id,vendor", order: "id asc" };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
    const listResponse = await client.get({ path: "products", query });
    const products =
      Array.isArray(listResponse?.body?.products) ?
        listResponse.body.products
      : [];

    const vendorByKey = new Map();
    for (const product of products) {
      const vendor = String(product?.vendor || "").trim();
      if (vendor) {
        vendorByKey.set(vendor.toLowerCase(), vendor);
      }
    }

    let inserted = 0;
    let skipped = 0;
    let sync_brand_mapped = 0;

    for (const name of vendorByKey.values()) {
      const slug = categorySlugFromName(name);
      const referenceId = `vendor:${slug}`;
      const existing = await findExistingBrand(name, slug, companyId);

      if (existing) {
        skipped += 1;
        const mapped = await upsertSyncBrandMapping({
          brandId: existing._id,
          integrationId: resolveIntegrationId(process),
          companyId,
          referenceId,
          createdBy: process.created_by?._id || process.created_by,
        });
        if (mapped) {
          sync_brand_mapped += 1;
        }
        continue;
      }

      const created = await Brand.create({
        name,
        slug,
        description: name,
        company_id: companyId,
        status: "active",
        created_by: coalesceObjectId(
          process.created_by?._id || process.created_by,
        ),
      });
      inserted += 1;
      const mapped = await upsertSyncBrandMapping({
        brandId: created._id,
        integrationId: resolveIntegrationId(process),
        companyId,
        referenceId,
        createdBy: process.created_by?._id || process.created_by,
      });
      if (mapped) {
        sync_brand_mapped += 1;
      }
    }

    const fetched = products.length;
    const isComplete = fetched < limit;
    const lastRemoteId = fetched > 0 ? products[fetched - 1]?.id : offset;
    const remarks =
      isComplete ?
        `Brand import completed: products scanned ${fetched}, vendors inserted ${inserted}, skipped ${skipped}, sync mapped ${sync_brand_mapped}.`
      : `Batch complete: products scanned ${fetched}, vendors inserted ${inserted}, skipped ${skipped}. Call execute-process again for page ${page + 1}.`;

    return finishFetchBrandBatch(req, res, process, {
      fetched,
      inserted,
      skipped,
      sync_brand_mapped,
      isComplete,
      nextOffset: lastRemoteId || 0,
      remarks,
    });
  } catch (error) {
    console.error(
      "Shopify brand fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch brands from Shopify product vendors.";
    return failFetchBrandBatch(process, res, errorPayload, errorPayload);
  }
}

/**
 * Import products from Shopify into POS (batch). Store → POS.
 */
async function fetch_product(req, res, process) {
  const integration = process?.integration_id;
  const companyId = resolveCompanyId(process);

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: "company_id is required on the process record.",
    });
  }

  const { client, error } = buildShopifyClient(integration);
  if (error) {
    return res.status(400).json({ success: false, message: error });
  }

  const { limit, offset, page } = resolveBatchPagination(process);
  const query = {
    limit,
    fields: "id,title,body_html,product_type,variants",
    order: "id asc",
  };
  if (offset > 0) {
    query.since_id = offset;
  }

  try {
    const listResponse = await client.get({ path: "products", query });
    const remoteProducts =
      Array.isArray(listResponse?.body?.products) ?
        listResponse.body.products
      : [];
    const stats = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      categories_found: 0,
      categories_inserted: 0,
      products_category_linked: 0,
    };
    const categoryCtx = { companyId, process, stats };

    for (const remote of remoteProducts) {
      const name = String(remote?.title || "").trim();
      if (!name) {
        stats.skipped += 1;
        continue;
      }

      try {
        const variant = Array.isArray(remote?.variants) ? remote.variants[0] : null;
        const productPrice = mapShopifyVariantPrice(variant);
        const categoryIds = await resolvePosCategoryIdsFromShopifyProduct(
          remote,
          client,
          categoryCtx,
        );
        await importShopifyProductToPos(remote, {
          companyId,
          process,
          stats,
          productPrice,
          categoryIds,
        });
      } catch (err) {
        console.error(
          `Failed to import Shopify product ${remote?.id} (${name}):`,
          err?.message || err,
        );
        stats.skipped += 1;
      }
    }

    const {
      inserted,
      updated = 0,
      skipped,
      categories_found = 0,
      categories_inserted = 0,
      products_category_linked = 0,
    } = stats;
    const fetched = remoteProducts.length;
    const isComplete = fetched < limit;
    const lastRemoteId = fetched > 0 ? remoteProducts[fetched - 1]?.id : offset;
    const remarks =
      isComplete ?
        `Product import completed: batch fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}.`
      : `Batch complete: fetched ${fetched}, inserted ${inserted}, updated ${updated}, skipped ${skipped}, categories found ${categories_found}, categories inserted ${categories_inserted}, products linked ${products_category_linked}. Call execute-process again for page ${page + 1}.`;

    return finishFetchProductBatch(req, res, process, {
      fetched,
      inserted,
      updated,
      skipped,
      categories_found,
      categories_inserted,
      products_category_linked,
      isComplete,
      nextOffset: lastRemoteId || 0,
      remarks,
    });
  } catch (error) {
    console.error(
      "Shopify product fetch failed:",
      error?.response?.body || error?.response?.data || error?.message || error,
    );
    const errorPayload =
      error?.response?.body ||
      error?.response?.data ||
      error?.message ||
      "Failed to fetch products from Shopify.";
    return failFetchProductBatch(process, res, errorPayload, errorPayload);
  }
}

/**
 * Save Shopify vendor mapping for a POS brand (vendors are product-level on Shopify).
 */
async function sync_brand(req, res, process) {
  const integration = process?.integration_id;
  const brand = process?.brand_id;

  if (!validateShopifyIntegration(integration, res)) {
    return;
  }

  if (!brand) {
    return res.status(400).json({
      success: false,
      message:
        "Brand is required for sync_brand. Set brand_id on the process or pass ?brand_id=<id> on execute-process.",
    });
  }

  const name = brand.name?.trim();
  if (!name) {
    return res.status(400).json({
      success: false,
      message: "Brand name is required.",
    });
  }

  const companyId = resolveCompanyId(process);
  const referenceId = `vendor:${categorySlugFromName(name)}`;

  await upsertSyncBrandMapping({
    brandId: brand._id,
    integrationId: resolveIntegrationId(process),
    companyId,
    referenceId,
    createdBy: process.created_by?._id || process.created_by,
  });

  await markProcessOutcome(
    process._id,
    "completed",
    `Brand vendor mapping saved for Shopify: ${name}.`,
  );

  return res.status(200).json({
    success: true,
    message: `Brand : ${name} mapped for Shopify vendor (use sync_product to push products with this vendor).`,
    data: { brand_id: brand._id, refference_id: referenceId },
  });
}

module.exports = {
  buildShopifyClient,
  fetch_category,
  fetch_brand,
  fetch_product,
  sync_product,
  sync_category,
  sync_brand,
};

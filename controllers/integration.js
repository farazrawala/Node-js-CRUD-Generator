const WooCommerceRestApi =
  require("@woocommerce/woocommerce-rest-api").default;
require("@shopify/shopify-api/adapters/node");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
  generateSlug,
} = require("../utils/modelHelper");

function sanitizeFileName(baseName, fallbackExt = ".jpg") {
  if (!baseName || typeof baseName !== "string") {
    return `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${fallbackExt}`;
  }

  const nameWithoutQuery = baseName.split("?")[0].split("#")[0];
  const extension = path.extname(nameWithoutQuery) || fallbackExt;
  const rawName = path.basename(nameWithoutQuery, extension);
  const sanitized =
    rawName.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") ||
    `image-${crypto.randomBytes(4).toString("hex")}`;

  return `${sanitized}-${crypto.randomBytes(4).toString("hex")}${extension.toLowerCase()}`;
}

function ensureUniqueFileName(directory, fileName) {
  let candidate = fileName;
  let counter = 1;

  while (fs.existsSync(path.join(directory, candidate))) {
    const extension = path.extname(fileName);
    const nameWithoutExt = path.basename(fileName, extension);
    candidate = `${nameWithoutExt}-${counter}${extension}`;
    counter += 1;
  }

  return candidate;
}

function resolveRedirectUrl(currentUrl, redirectLocation) {
  if (!redirectLocation) return null;
  try {
    const redirectUrl = new URL(redirectLocation, currentUrl);
    return redirectUrl.toString();
  } catch (error) {
    console.warn("⚠️ Failed to resolve redirect URL:", redirectLocation, error.message);
    return null;
  }
}

function downloadImageToFile(imageUrl, destinationPath, redirectCount = 0) {
  const MAX_REDIRECTS = 5;

  return new Promise((resolve, reject) => {
    if (!imageUrl) {
      return reject(new Error("Image URL is required"));
    }

    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error("Too many redirects while downloading image"));
    }

    let urlObject;
    try {
      urlObject = new URL(imageUrl);
    } catch (error) {
      return reject(new Error(`Invalid image URL: ${imageUrl}`));
    }

    const httpModule = urlObject.protocol === "https:" ? https : http;

    const request = httpModule.get(urlObject, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectUrl = resolveRedirectUrl(urlObject, response.headers.location);
        response.resume();
        if (!redirectUrl) {
          return reject(new Error("Failed to resolve redirect URL for image download"));
        }
        return resolve(downloadImageToFile(redirectUrl, destinationPath, redirectCount + 1));
      }

      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Failed to download image. Status code: ${response.statusCode}`));
      }

      const fileStream = fs.createWriteStream(destinationPath);
      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close(() => resolve(destinationPath));
      });

      fileStream.on("error", (error) => {
        fileStream.close(() => {
          fs.unlink(destinationPath, () => reject(error));
        });
      });
    });

    request.on("error", (error) => reject(error));
  });
}

async function saveProductImagesLocally(productId, imageEntries = []) {
  if (!productId || !Array.isArray(imageEntries) || imageEntries.length === 0) {
    return null;
  }

  const normalizedEntries = imageEntries.filter(
    (entry) => entry && typeof entry.src === "string" && entry.src.trim() !== ""
  );

  if (normalizedEntries.length === 0) {
    return null;
  }

  const uploadsDirectory = path.join(__dirname, "..", "uploads", "product", productId.toString());
  await fs.promises.mkdir(uploadsDirectory, { recursive: true });

  const savedPaths = [];

  for (const entry of normalizedEntries) {
    const sourceUrl = entry.src.trim();
    const preferredName =
      (typeof entry.name === "string" && entry.name.trim().length > 0 && entry.name.trim()) || null;

    let candidateName = preferredName;
    if (!candidateName) {
      try {
        const urlObject = new URL(sourceUrl);
        candidateName = path.basename(urlObject.pathname);
      } catch (error) {
        candidateName = null;
      }
    }

    const fallbackExtension = candidateName && path.extname(candidateName) ? path.extname(candidateName) : ".jpg";
    const sanitizedName = sanitizeFileName(candidateName, fallbackExtension);
    const uniqueFileName = ensureUniqueFileName(uploadsDirectory, sanitizedName);
    const targetPath = path.join(uploadsDirectory, uniqueFileName);

    try {
      await downloadImageToFile(sourceUrl, targetPath);
      const relativePath = path
        .join("uploads", "product", productId.toString(), uniqueFileName)
        .replace(/\\/g, "/");
      savedPaths.push(relativePath);
    } catch (error) {
      console.warn("⚠️ Failed to download WooCommerce product image:", sourceUrl, error.message);
    }
  }

  if (savedPaths.length === 0) {
    return null;
  }

  return {
    featured: savedPaths[0],
    gallery: savedPaths.slice(1),
  };
}

function extractWooImageEntries(product = {}) {
  const entries = [];

  if (Array.isArray(product?.images)) {
    product.images.forEach((image) => {
      if (image && typeof image.src === "string" && image.src.trim() !== "") {
        entries.push({
          src: image.src.trim(),
          name: typeof image.name === "string" ? image.name.trim() : null,
        });
      }
    });
  }

  if (
    entries.length === 0 &&
    typeof product?.image === "string" &&
    product.image.trim() !== ""
  ) {
    entries.push({
      src: product.image.trim(),
      name: null,
    });
  }

  return entries;
}

  ///////////////Sync  Categories///////////////

  async function syncWordpressCategory(req,res, store = "") {
    if (!store?.url || !store?.key || !store?.secret) {
      return res.status(400).json({
        success: false,
        message:
          "Missing WooCommerce credentials. Please verify url, key, and secret.",
      });
    }

    const woocommerce = new WooCommerceRestApi({
      url: store.url,
      consumerKey: store.key,
      consumerSecret: store.secret,
      version: "wc/v3",
    });

    const originalBody = req.body;
    try {
      const response = await woocommerce.get("products/categories", {
        per_page: 100,
      });
      const remoteCategories = Array.isArray(response?.data)
        ? [...response.data]
        : [];

      remoteCategories.sort((a, b) => {
        const parentA = typeof a?.parent === "number" ? a.parent : 0;
        const parentB = typeof b?.parent === "number" ? b.parent : 0;
        if (parentA !== parentB) return parentA - parentB;
        return (typeof a?.id === "number" ? a.id : 0) - (typeof b?.id === "number" ? b.id : 0);
      });
      
      // console.log("🔍 remoteCategories:", remoteCategories);
      // return false;

      if (remoteCategories.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No categories found in WooCommerce store",
          data: {
            created: [],
            skipped: [],
            failed: [],
          },
        });
      }

      const pendingCategories = [...remoteCategories];
      const wooToLocalCategoryIds = new Map();
      const syncResults = {
        created: [],
        skipped: [],
        failed: [],
      };

      if (!req.body) {
        req.body = {};
      }

      const maxIterations = pendingCategories.length * 3;
      let iterations = 0;

      while (pendingCategories.length && iterations < maxIterations) {
        const category = pendingCategories.shift();
        iterations += 1;

        const parentWooId =
          typeof category.parent === "number" ? category.parent : 0;
        let parentId = null;
        if (parentWooId > 0) {
          parentId = wooToLocalCategoryIds.get(parentWooId);
          if (!parentId) {
            pendingCategories.push(category);
            continue;
          }
        }

        const trimmedName = category?.name?.trim();
        if (!trimmedName) {
          syncResults.failed.push({
            wooCategoryId: category?.id,
            reason: "missing_name",
          });
          continue;
        }

        const companyId =
          store?.company_id ?? req.user?.company_id ?? null;

        const categorySlug = generateSlug(trimmedName);
        const searchCriteria = {
          ...(companyId ? { company_id: companyId } : {}),
          $or: [{ name: trimmedName }, { slug: categorySlug }],
        };

        const findReq = Object.create(req);
        findReq.body = searchCriteria;

        const existingCategory = await handleGenericFindOne(findReq, "category", {
          searchCriteria,
        });

        if (existingCategory.success && existingCategory.data) {
          wooToLocalCategoryIds.set(category.id, existingCategory.data._id);
          if (existingCategory.data.deletedAt) {
            const restoreReq = Object.create(req);
            restoreReq.params = {
              ...(restoreReq.params || {}),
              id: existingCategory.data._id,
            };
            restoreReq.body = {
              deletedAt: null,
              status: "active",
              isActive: true,
            };

            await handleGenericUpdate(restoreReq, "category");
          }
          syncResults.skipped.push({
            wooCategoryId: category.id,
            name: trimmedName,
            reason: "already_exists",
          });
          continue;
        }

        const categoryReq = Object.create(req);
        categoryReq.body = {
          slug: categorySlug,
          name: trimmedName,
          description: category?.description || "",
          isActive: category?.display !== "hidden",
          sort_order:
            typeof category?.menu_order === "number" ? category.menu_order : 0,
          parent_id: parentId ?? null,
        };
        if (companyId) {
          categoryReq.body.company_id = companyId;
        }

        const creationResult = await handleGenericCreate(categoryReq, "category");

        if (creationResult.success) {
          const createdRecord = creationResult.data;
          wooToLocalCategoryIds.set(category.id, createdRecord._id);
          syncResults.created.push({
            wooCategoryId: category.id,
            name: createdRecord.name,
            parent: parentWooId || null,
          });
        } else if (creationResult.status === 409) {
          syncResults.skipped.push({
            wooCategoryId: category.id,
            name: trimmedName,
            reason: creationResult.error || "duplicate_entry",
          });
        } else {
          syncResults.failed.push({
            wooCategoryId: category.id,
            name: trimmedName,
            reason: creationResult.error || "creation_failed",
            details: creationResult.details,
          });
        }
      }

      if (pendingCategories.length) {
        pendingCategories.forEach((pendingCategory) => {
          syncResults.failed.push({
            wooCategoryId: pendingCategory.id,
            name: pendingCategory?.name,
            reason: "parent_not_synced",
          });
        });
      }

      return res.status(200).json({
        success: true,
        message: "WooCommerce categories synced",
        data: syncResults,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.data ??
        (typeof error?.message === "string"
          ? error.message
          : "Failed to fetch categories from WooCommerce");
      return res.status(500).json({
        success: false,
        message: "Failed to fetch categories from WooCommerce",
        error: errorPayload,
      });
    } finally {
      req.body = originalBody;
    }
  }

  async function syncShopifyCategory(req, res, store = {}) {
    let shopDomain = (store?.url || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "");

    if (!shopDomain) {
      return res.status(400).json({
        success: false,
        message: "Missing Shopify shop URL",
      });
    }

    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/i.test(shopDomain)) {
      if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
        shopDomain = `${shopDomain}.myshopify.com`;
      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid Shopify shop domain",
          details: shopDomain,
        });
      }
    }

    if (!/\.myshopify\.com$/i.test(shopDomain)) {
      return res.status(400).json({
        success: false,
        message:
          "Shopify domain must end with .myshopify.com. Please provide the myshopify domain.",
        details: shopDomain,
      });
    }

    
  
    const STATIC_SHOPIFY_API_KEY = store.key;
    const STATIC_SHOPIFY_SECRET = store.secret;
    const adminApiAccessToken = store.token;

    if (!adminApiAccessToken) {
      return res.status(400).json({
        success: false,
        message:
          "Missing Shopify access token. Please provide a valid token in the integration record.",
      });
    }

    const shopify = shopifyApi({
      apiKey: STATIC_SHOPIFY_API_KEY,
      apiSecretKey: STATIC_SHOPIFY_SECRET,
      adminApiAccessToken,
      scopes: ["read_products", "read_product_listings"],
      hostName: shopDomain,
      apiVersion: ApiVersion.October24,
      isCustomStoreApp: true,
    });



    

    const session = shopify.session.customAppSession(shopDomain);
    session.accessToken = adminApiAccessToken;

    const originalBody = req.body;
    try {
      const client = new shopify.clients.Rest({ session });
        
      let collections = [];
      let queryParams = { limit: 250 };

      do {
        const collectionResponse = await client.get({
          path: "custom_collections",
          query: queryParams,
        });
        const batch =
          collectionResponse?.body?.custom_collections ||
          collectionResponse?.body?.customCollections ||
          [];
        collections = collections.concat(batch);

        if (collectionResponse?.pageInfo?.nextPageParameters) {
          queryParams = collectionResponse.pageInfo.nextPageParameters;
        } else if (batch.length === 250 && batch[batch.length - 1]?.id) {
          queryParams = {
            limit: 250,
            since_id: batch[batch.length - 1].id,
          };
        } else {
          queryParams = null;
        }
      } while (queryParams);

      if (collections.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No collections found in Shopify store",
          data: {
            created: [],
            skipped: [],
            failed: [],
          },
        });
      }

      const syncResults = {
        created: [],
        skipped: [],
        failed: [],
      };

      if (!req.body) {
        req.body = {};
      }

      for (const collection of collections) {
        const trimmedName = collection?.title?.trim();
        if (!trimmedName) {
          syncResults.failed.push({
            shopifyCollectionId: collection?.id,
            reason: "missing_name",
          });
          continue;
        }

        const searchCriteria = {
          name: trimmedName,
        };

        if (req.user?.company_id) {
          searchCriteria.company_id = req.user.company_id;
        }

        const findReq = Object.create(req);
        findReq.body = searchCriteria;

        const existingCategory = await handleGenericFindOne(findReq, "category", {
          searchCriteria,
        });

        if (existingCategory.success) {
          syncResults.skipped.push({
            shopifyCollectionId: collection.id,
            name: trimmedName,
            reason: "already_exists",
          });
          continue;
        }

        const categoryReq = Object.create(req);
        categoryReq.body = {
          name: trimmedName,
          description: collection?.body_html || "",
          isActive: Boolean(collection?.published_at),
          sort_order: 0,
          parent_id: null,
        };

        const creationResult = await handleGenericCreate(categoryReq, "category");

        if (creationResult.success) {
          const createdRecord = creationResult.data;
          syncResults.created.push({
            shopifyCollectionId: collection.id,
            name: createdRecord.name,
            parent: null,
          });
        } else if (creationResult.status === 409) {
          syncResults.skipped.push({
            shopifyCollectionId: collection.id,
            name: trimmedName,
            reason: creationResult.error || "duplicate_entry",
          });
        } else {
          syncResults.failed.push({
            shopifyCollectionId: collection.id,
            name: trimmedName,
            reason: creationResult.error || "creation_failed",
            details: creationResult.details,
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Shopify collections synced",
        data: syncResults,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.body ??
        error?.response?.data ??
        (typeof error?.message === "string"
          ? error.message
          : "Failed to fetch collections from Shopify");
      return res.status(500).json({
        success: false,
        message: "Failed to sync collections from Shopify",
        error: errorPayload,
      });
    } finally {
      req.body = originalBody;
    }
  }

  async function syncStoreCategory(req, res) {
    const integrationResponse = await handleGenericGetById(
      req,
      "integration",
      {
        excludeFields: [],
      }
    );
    if (integrationResponse?.data?.store_type === "shopify") {
      return syncShopifyCategory(req, res, integrationResponse.data);
    } else if (integrationResponse?.data?.store_type === "woocommerce") {
      return syncWordpressCategory(req,res, integrationResponse.data);
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid store type",
      });
    }
  }

  ///////////////Sync  Categories///////////////
  ///////////////Sync  Brand////////////////////////

  async function syncStoreBrand(req, res) {
    const integrationResponse = await handleGenericGetById(
      req,
      "integration",
      {
        excludeFields: [],
      }
    );
    if (integrationResponse.data.store_type === "shopify") {
      return syncShopifyBrand(req, res, integrationResponse.data);
    } else if (integrationResponse.data.store_type === "woocommerce") {
      return syncWordpressBrand(req, res, integrationResponse.data);
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid store type",
      }); 
    }
  }

  async function syncShopifyBrand(req, res, store = {}) {
    const shopDomain = (store?.url || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "");
      
      
    if (!shopDomain) {
      return res.status(400).json({
        success: false,
        message: "Missing Shopify shop URL",
      });
    }
    
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/i.test(shopDomain) && shopDomain !== "myshopify.com") {
      if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
        shopDomain = `${shopDomain}.myshopify.com`;
      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid Shopify shop domain",
          details: shopDomain,
        });
      }
    }
    
    if (!/\.myshopify\.com$/i.test(shopDomain)) {
      return res.status(400).json({
        success: false,
        message: "Shopify domain must end with .myshopify.com. Please provide the myshopify domain.",
        details: shopDomain,
      });
    }

    const STATIC_SHOPIFY_API_KEY = store.key;
    const STATIC_SHOPIFY_SECRET = store.secret;
    const adminApiAccessToken = store.token;

    if (!adminApiAccessToken) {
      return res.status(400).json({
        success: false,
        message: "Missing Shopify access token. Please provide a valid token in the integration record.",
      });
    }

    const shopify = shopifyApi({
      apiKey: STATIC_SHOPIFY_API_KEY,
      apiSecretKey: STATIC_SHOPIFY_SECRET,
      adminApiAccessToken,
      scopes: ["read_products", "read_product_listings"],
      hostName: shopDomain,
      apiVersion: ApiVersion.October24,
      isCustomStoreApp: true,
    });

    const session = shopify.session.customAppSession(shopDomain);
    session.accessToken = adminApiAccessToken;

    const originalBody = req.body;
    try {
      const client = new shopify.clients.Rest({ session });
      const brandsResponse = await client.get({ path: "brands" });
      const brands = brandsResponse?.body?.brands || brandsResponse?.body || [];
      
      return res.status(200).json({
        success: true,
        message: "Shopify brands synced",
        data: brands,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.body ??
        error?.response?.data ??
        (typeof error?.message === "string" ? error.message : "Failed to fetch brands from Shopify");
      return res.status(500).json({
        success: false,
        message: "Failed to fetch brands from Shopify",
        error: errorPayload,
      });
    } finally {
      req.body = originalBody;
    }
  }

  async function syncWordpressBrand(req, res, store = {}) {
    const woocommerce = new WooCommerceRestApi({
      url: store.url,
      consumerKey: store.key,
      consumerSecret: store.secret,
      version: "wc/v3",
    });

    const originalBody = req.body;
    try {
      const response = await woocommerce.get("products/brands");
      const brands = response?.data || [];
      return res.status(200).json({
        success: true,
        message: "WooCommerce brands synced",
        data: brands,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.data ??
        (typeof error?.message === "string" ? error.message : "Failed to fetch brands from WooCommerce");
      return res.status(500).json({
        success: false,
        message: "Failed to fetch brands from WooCommerce",
        error: errorPayload,
      });
    } finally {
      req.body = originalBody;
    }
  }

    ///////////////Sync  Brand///////////////

  ///////////////Sync  Products///////////////
  async function syncStoreProduct(req, res) {
    const integrationResponse = await handleGenericGetById(
      req,
      "integration",
      {
        excludeFields: [],
      }
    );
    if (integrationResponse.data.store_type === "shopify") {
      return syncShopifyProduct(req, res, integrationResponse.data);
    } else if (integrationResponse.data.store_type === "woocommerce") {
      return syncWordpressProduct(req, res, integrationResponse.data);
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid store type",
      });
    }
  }

  async function syncShopifyProduct(req, res, store = {}) {
    let shopDomain = (store?.url || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/$/, "");
      
    if (!shopDomain) {
      return res.status(400).json({
        success: false,
        message: "Missing Shopify shop URL",
      });
    }
    
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/i.test(shopDomain) && shopDomain !== "myshopify.com") {
      if (/^[a-z0-9][a-z0-9-]*$/i.test(shopDomain)) {
        shopDomain = `${shopDomain}.myshopify.com`;
      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid Shopify shop domain",
          details: shopDomain,
        });
      }
    }
      
    if (!/\.myshopify\.com$/i.test(shopDomain)) {
      return res.status(400).json({
        success: false,
        message: "Shopify domain must end with .myshopify.com. Please provide the myshopify domain.",
        details: shopDomain,
      });
    }
    
    
      
    const STATIC_SHOPIFY_API_KEY = store.key;
    const STATIC_SHOPIFY_SECRET = store.secret;
    const adminApiAccessToken = store.token;

    if (!adminApiAccessToken) {
      return res.status(400).json({
        success: false,
        message: "Missing Shopify access token. Please provide a valid token in the integration record.",
      });
    }

    const shopify = shopifyApi({
      apiKey: STATIC_SHOPIFY_API_KEY,
      apiSecretKey: STATIC_SHOPIFY_SECRET,
      adminApiAccessToken,
      scopes: ["read_products"],
      hostName: shopDomain,
      apiVersion: ApiVersion.October24,
      isCustomStoreApp: true,
    });

    const session = shopify.session.customAppSession(shopDomain);
    session.accessToken = adminApiAccessToken;

    const originalBody = req.body;
    try {
      const client = new shopify.clients.Rest({ session });
      const productsResponse = await client.get({ path: "products" });
      const products = productsResponse?.body?.products || productsResponse?.body || [];
      return res.status(200).json({
        success: true,
        message: "Products fetched successfully",
        data: products,
        meta: productsResponse?.headers ? { headers: productsResponse.headers } : undefined,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.body ??
        error?.response?.data ??
        (typeof error?.message === "string" ? error.message : "Failed to fetch products from Shopify");
      return res.status(500).json({
        success: false,
        message: "Failed to fetch products from Shopify",
        error: errorPayload,
      });
    } finally {
      req.body = originalBody;
    }
  }   

  async function syncWordpressProduct(req, res, store = {}) {
    

    // const categories = syncStoreCategoryResponse.data;
    const woocommerce = new WooCommerceRestApi({
      url: store.url,
      consumerKey: store.key,
      consumerSecret: store.secret,
      version: "wc/v3",
    });

    const originalBody = req.body;
    try {
      const response = await woocommerce.get("products");
      const products = response?.data || [];

      if (products.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No products found in WooCommerce store",
          data: [],
        });
      }
      let syncedCount = 0;
      let existingCount = 0;

      for (const product of products) {
        const existingProduct = await handleGenericFindOne(req, "product", {
          searchCriteria: {
            product_name: product.name.trim(),
            company_id: store.company_id,
            deletedAt: null,
          },
        }); 
        if (existingProduct.success) {
          existingCount += 1;
          continue;
        }
        console.log("🔍 product.categories:", product.categories);
        const categoryIds = [];
        if (Array.isArray(product.categories)) {
          for (const category of product.categories) {
            console.log("🔍 category name:", category?.name);
            const categoryName = category?.name?.trim();
            if (!categoryName) {
              continue;
            }

            const categoryResponse = await handleGenericFindOne(req, "category", {
              searchCriteria: {
                name: categoryName,
                company_id: store.company_id,
                deletedAt: null,
              },
            });

            console.log("🔍 categoryResponse:", categoryResponse);
            
            if (categoryResponse.success && categoryResponse.data?._id) {
              categoryIds.push(categoryResponse.data._id);
              continue;
            }

            const categoryReq = Object.create(req);
            categoryReq.body = {
              name: categoryName,
              company_id: store.company_id,
              parent_id: null,
              deletedAt: null,
            };
            const newCategoryResult = await handleGenericCreate(categoryReq, "category");
            console.log("🔍 newCategoryResult:", newCategoryResult);

            if (newCategoryResult.success && newCategoryResult.data?._id) {
              categoryIds.push(newCategoryResult.data._id);
              continue;
            }

            return res.status(500).json({
              success: false,
              message: "Failed to create category",
              error: newCategoryResult.error || "unknown_error",
            });
          }
        }

        const productReq = Object.create(req);
        const imageEntries = extractWooImageEntries(product);
        const featuredImage = imageEntries.length > 0 ? imageEntries[0].src : null;
        const galleryImages = imageEntries.slice(1).map((entry) => entry.src).filter(Boolean);

        productReq.body = {
          product_name: product.name.trim(),
          product_code: product.sku,
          company_id: store.company_id,
          brand_id: product.brand_id,
          product_price: product.price,
          quantity: product.quantity,
          product_description: product.description,
          product_image: featuredImage,
          multi_images: galleryImages,
          deletedAt: null,
          product_type: product.type === "variable" ? "Variable" : "Single",
          weight: product.weight,
          unit: product.unit,
          category_id: categoryIds,

        };

        const creationResult = await handleGenericCreate(productReq, "product");
        console.log("🔍 creationResult:", creationResult);
        if (creationResult.success) {
          try {
            const createdProductId =
              creationResult.data?._id || creationResult.data?.id || creationResult.data?._doc?._id;
            const productIdString =
              createdProductId && typeof createdProductId.toString === "function"
                ? createdProductId.toString()
                : createdProductId
                ? String(createdProductId)
                : null;

            if (productIdString) {
              const savedImages = await saveProductImagesLocally(productIdString, imageEntries);
              if (savedImages && (savedImages.featured || savedImages.gallery?.length)) {
                const imageUpdateReq = Object.create(req);
                imageUpdateReq.params = {
                  ...(req.params || {}),
                  id: productIdString,
                };
                imageUpdateReq.body = {};
                if (savedImages.featured) {
                  imageUpdateReq.body.product_image = savedImages.featured;
                }
                if (savedImages.gallery && savedImages.gallery.length > 0) {
                  imageUpdateReq.body.multi_images = savedImages.gallery;
                }

                if (Object.keys(imageUpdateReq.body).length > 0) {
                  await handleGenericUpdate(imageUpdateReq, "product", {
                    allowedFields: ["product_image", "multi_images"],
                  });
                }
              }
            }
          } catch (imageError) {
            console.warn(
              "⚠️ Failed to persist WooCommerce product images locally:",
              imageError?.message || imageError
            );
          }

          syncedCount += 1;
          continue;
        }
        else {
          return res.status(500).json({
            success: false,
            message: "Failed to sync product from WooCommerce",
            error: creationResult.error,
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Products synced successfully",
        data: products,
        synced_count: syncedCount,
        existing_count: existingCount,
      });
      
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to sync products from WooCommerce",
        error: error.message,
      });
    }
  }


  ///////////////Sync  Orders///////////////

  ///////////////Sync  Customers///////////////

  ///////////////Sync  Reviews///////////////

  ///////////////Sync  Coupons///////////////

  ///////////////Sync  Discounts///////////////

  async function checkIntegrationActive(req, res) {
    const integrationResponse = await handleGenericGetById(
      req,
      "integration",
      {
        excludeFields: [],
      }
    );
   
    if (integrationResponse.data.status === "active") {
      // return res.status(200).json({
      //   success: true,
      //   message: "Integration is active",
      //   data: response.data,
      // });

      // if(response.data.store_type === "woocommerce") {
      //   const woocommerce = new WooCommerceRestApi({
      //     url: response.data.url,
      //     consumerKey: response.data.key,
      //     consumerSecret: response.data.secret,
      //     version: "wc/v3",
      //   });
      //   try {
      //     const responseData = await woocommerce.get("products");
      //     const products = responseData && responseData.data ? responseData.data : [];
      //     return res.status(200).json({
      //       success: true,
      //       message: "Products fetched successfully",
      //       data: products,
      //       meta: responseData && responseData.headers ? { headers: responseData.headers } : undefined,
      //     });
      //   } catch (error) {
      //     const errorPayload = error.response ? error.response.data : error.message;
      //     return res.status(500).json({
      //       success: false,
      //       message: "Failed to fetch products from WooCommerce",
      //       error: errorPayload,
      //     });
      //   }
      // } else
      
      
      if (integrationResponse.data.store_type === "shopify") {
        const shopDomain = (integrationResponse.data.url || "")
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");

        if (!shopDomain) {
          return res.status(400).json({
            success: false,
            message: "Invalid Shopify shop URL",
          });
        }

        const STATIC_SHOPIFY_API_KEY = "db6d898fa3ccf29f527347eb5a1ac587";
        const STATIC_SHOPIFY_SECRET = "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";
        const STATIC_SHOPIFY_ADMIN_TOKEN =
          "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";

        const apiKey =  STATIC_SHOPIFY_API_KEY;
        const apiSecretKey = STATIC_SHOPIFY_SECRET;
        const adminApiAccessToken = STATIC_SHOPIFY_ADMIN_TOKEN;

        const shopify = shopifyApi({
          apiKey,
          apiSecretKey,
          adminApiAccessToken,
          scopes: ["read_products"],
          hostName: shopDomain,
          apiVersion: ApiVersion.October24,
          isCustomStoreApp: true,
        });

        try {
          const session = shopify.session.customAppSession(shopDomain);
          session.accessToken = adminApiAccessToken;
          if (!session.accessToken) {
            return res.status(400).json({
              success: false,
              message:
                "Missing Shopify access token. Please provide a valid token in the integration record.",
            });
          }

          const client = new shopify.clients.Rest({ session });
          const productsResponse = await client.get({ path: "products" });
          const products =
            productsResponse?.body?.products || productsResponse?.body || [];

          return res.status(200).json({
            success: true,
            message: "Products fetched successfully",
            data: products,
            meta: productsResponse?.headers
              ? { headers: productsResponse.headers }
              : undefined,
          });
        } catch (error) {
          const errorPayload =
            error?.response?.body ??
            (typeof error?.message === "string"
              ? error.message
              : "Failed to fetch products from Shopify");
          return res.status(500).json({
            success: false,
            message: "Failed to fetch products from Shopify",
            error: errorPayload,
          });
        }
      }

    } else {
      return res.status(400).json({
        success: false,
        message: "Integration is not active",
        data: integrationResponse.data,
      });
    }
  }
  
  
  module.exports = {
  
    checkIntegrationActive,
    syncStoreCategory,
    syncStoreBrand,
    syncStoreProduct
  };
  
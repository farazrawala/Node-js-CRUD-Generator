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

async function resetProductImageDirectory(productId) {
  if (!productId) {
    return;
  }

  const directoryPath = path.join(
    __dirname,
    "..",
    "uploads",
    "product",
    productId.toString()
  );

  try {
    if (fs.promises.rm) {
      await fs.promises.rm(directoryPath, { recursive: true, force: true });
    } else {
      await fs.promises.rmdir(directoryPath, { recursive: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(
        "⚠️ Failed to reset product image directory:",
        directoryPath,
        error.message || error
      );
    }
  }
}

function isLocalProductAssetPath(value, productId) {
  if (!value || typeof value !== "string" || !productId) {
    return false;
  }

  const normalizedValue = value.replace(/\\/g, "/");
  const productIdString =
    typeof productId === "string" ? productId : productId.toString();

  return normalizedValue.startsWith(`uploads/product/${productIdString}/`);
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

function collectShopifyCategoryNames(product = {}) {
  const names = new Set();

  if (typeof product?.product_type === "string") {
    const normalized = product.product_type.trim();
    if (normalized) {
      names.add(normalized);
    }
  }

  if (Array.isArray(product?.tags)) {
    product.tags
      .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
      .filter(Boolean)
      .forEach((tag) => names.add(tag));
  } else if (typeof product?.tags === "string") {
    product.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .forEach((tag) => names.add(tag));
  }

  return Array.from(names);
}

function extractShopifyImageEntries(product = {}) {
  const entries = [];

  if (Array.isArray(product?.images)) {
    product.images.forEach((image) => {
      const src = typeof image?.src === "string" ? image.src.trim() : "";
      if (src) {
        entries.push({
          src,
          name:
            (typeof image?.alt === "string" && image.alt.trim()) ||
            (typeof image?.alt_text === "string" && image.alt_text.trim()) ||
            null,
        });
      }
    });
  }

  if (
    entries.length === 0 &&
    typeof product?.image === "object" &&
    typeof product.image?.src === "string" &&
    product.image.src.trim() !== ""
  ) {
    entries.push({
      src: product.image.src.trim(),
      name:
        (typeof product.image?.alt === "string" && product.image.alt.trim()) ||
        (typeof product.image?.alt_text === "string" && product.image.alt_text.trim()) ||
        null,
    });
  }

  return entries;
}

function buildShopifyVariantAttributes(product = {}, variant = {}) {
  const attributes = [];
  const options = Array.isArray(product?.options) ? product.options : [];

  options.forEach((option, index) => {
    const optionKey = `option${index + 1}`;
    const rawValue = variant?.[optionKey];
    const value = sanitizeWooText(rawValue);
    if (value) {
      const name =
        sanitizeWooText(option?.name) || `Option ${index + 1}`;
      attributes.push({ name, value });
    }
  });

  return attributes;
}

function deriveShopifyVariantName(baseName, attributes = [], variant = {}) {
  const suffix =
    attributes
      .map((attribute) => attribute.value)
      .filter(Boolean)
      .join(" / ") ||
    (variant?.title && variant.title !== "Default Title"
      ? sanitizeWooText(variant.title)
      : "");

  return suffix ? `${baseName} - ${suffix}` : `${baseName} - Variant`;
}

function sanitizeWooText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text.length > 0 ? text : fallback;
}

function generateAttributeCombinations(attributes = []) {
  if (!Array.isArray(attributes)) {
    return [];
  }

  const normalized = attributes
    .map((attribute, index) => {
      const options = Array.isArray(attribute?.options)
        ? attribute.options.map((option) => sanitizeWooText(option)).filter(Boolean)
        : [];

      if (options.length === 0) {
        return null;
      }

      const name =
        sanitizeWooText(attribute?.name) ||
        sanitizeWooText(attribute?.slug) ||
        `Attribute ${index + 1}`;

      return {
        name,
        options,
      };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    return [];
  }

  const combinations = [];

  const buildCombinations = (attributeIndex, currentCombination) => {
    if (attributeIndex === normalized.length) {
      combinations.push([...currentCombination]);
      return;
    }

    const attribute = normalized[attributeIndex];
    attribute.options.forEach((option) => {
      currentCombination.push({ name: attribute.name, value: option });
      buildCombinations(attributeIndex + 1, currentCombination);
      currentCombination.pop();
    });
  };

  buildCombinations(0, []);
  return combinations;
}

function createVariantSku(baseSku, attributes = []) {
  const normalizedBase = sanitizeWooText(baseSku, "WC-PRODUCT");
  if (!Array.isArray(attributes) || attributes.length === 0) {
    return normalizedBase;
  }

  const suffix = attributes
    .map((attribute) =>
      sanitizeWooText(attribute?.value)
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/gi, "")
        .toUpperCase()
    )
    .filter(Boolean)
    .join("-");

  if (!suffix) {
    return normalizedBase;
  }

  const candidate = `${normalizedBase}-${suffix}`;
  return candidate.length > 120 ? candidate.slice(0, 120) : candidate;
}

function buildVariantDescription(baseDescription, attributes = []) {
  const normalizedBase = sanitizeWooText(baseDescription);
  if (!Array.isArray(attributes) || attributes.length === 0) {
    return normalizedBase;
  }

  const attributeSummary = attributes
    .map((attribute) => `- ${attribute.name}: ${attribute.value}`)
    .join("\n");

  if (!normalizedBase) {
    return `Attributes:\n${attributeSummary}`;
  }

  return `${normalizedBase}\n\nAttributes:\n${attributeSummary}`;
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

        console.log("existingCategory__",existingCategory);

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

      const { limit: limitParam, page_info: pageInfoParam, since_id: sinceIdParam } = req.query || {};
      const parsedLimit = Number.parseInt(limitParam, 10);
      const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(parsedLimit, 200)
          : 10;

      const requestOptions = {
        path: "products",
        query: {
          limit,
        },
      };

      if (pageInfoParam) {
        requestOptions.query.page_info = pageInfoParam;
      } else if (sinceIdParam) {
        requestOptions.query.since_id = sinceIdParam;
      }

      const productsResponse = await client.get(requestOptions);
      const products =
        (Array.isArray(productsResponse?.body?.products) && productsResponse.body.products) ||
        (Array.isArray(productsResponse?.body) && productsResponse.body) ||
        [];

      const pagination = {
        limit,
        page_info: pageInfoParam || null,
      };

      const linkHeader = productsResponse?.headers?.link || productsResponse?.headers?.Link;
      if (linkHeader) {
        const nextPart = linkHeader
          .split(",")
          .map((part) => part.trim())
          .find((part) => /rel="?next"?/i.test(part));

        if (nextPart) {
          const urlMatch = nextPart.match(/<([^>]+)>/);
          if (urlMatch && urlMatch[1]) {
            try {
              const parsedUrl = new URL(urlMatch[1]);
              const nextPageInfo = parsedUrl.searchParams.get("page_info");
              if (nextPageInfo) {
                pagination.next_page_info = nextPageInfo;
              }
            } catch (parseError) {
              console.warn("⚠️ Failed to parse Shopify Link header:", parseError?.message || parseError);
            }
          }
        }
      }

      if (products.length === 0) {
      return res.status(200).json({
        success: true,
          message: "No products found in Shopify store",
          data: [],
          pagination,
          synced_products: [],
          meta: productsResponse?.headers ? { headers: productsResponse.headers } : undefined,
        });
      }

      let syncedCount = 0;
      let existingCount = 0;
      const syncResults = [];

      for (const product of products) {
        const baseProductName = sanitizeWooText(product?.title);
        if (!baseProductName) {
          console.warn("⚠️ Skipping Shopify product without a title:", product?.id);
          continue;
        }

        const variants = Array.isArray(product?.variants) ? product.variants : [];
        const primaryVariant = variants[0] || {};
        const primarySku = sanitizeWooText(primaryVariant?.sku, `SHOP-${product?.id || Date.now()}`);

        const resolvedPrice =
          primaryVariant?.price !== undefined &&
          primaryVariant?.price !== null &&
          String(primaryVariant.price).trim() !== ""
            ? String(primaryVariant.price)
            : "0";

        const resolvedQuantity =
          typeof primaryVariant?.inventory_quantity === "number" &&
          !Number.isNaN(primaryVariant.inventory_quantity)
            ? primaryVariant.inventory_quantity
            : 0;

        const categoryIds = [];
        const categoryNames = collectShopifyCategoryNames(product);

        for (const categoryName of categoryNames) {
          const normalizedName = sanitizeWooText(categoryName);
          if (!normalizedName) {
            continue;
          }

          const categoryResponse = await handleGenericFindOne(req, "category", {
            searchCriteria: {
              name: normalizedName,
              company_id: store.company_id,
              deletedAt: null,
            },
          });

          if (categoryResponse.success && categoryResponse.data?._id) {
            categoryIds.push(categoryResponse.data._id);
            continue;
          }

          const generatedSlug = generateSlug(normalizedName);
          const slugLookup = await handleGenericFindOne(req, "category", {
            searchCriteria: {
              // slug: generatedSlug,
              name: normalizedName,
              company_id: store.company_id,
              deletedAt: null,
            },
          });

          if (slugLookup.success && slugLookup.data?._id) {
            categoryIds.push(slugLookup.data._id);
            continue;
          }

          const fallbackNameLookup = await handleGenericFindOne(req, "category", {
            searchCriteria: {
              name: normalizedName,
              deletedAt: null,
            },
          });

          if (fallbackNameLookup.success && fallbackNameLookup.data?._id) {
            categoryIds.push(fallbackNameLookup.data._id);
            continue;
          }

          const categoryReq = Object.create(req);
          categoryReq.body = {
            name: normalizedName,
            company_id: store.company_id,
            slug: generatedSlug,
            parent_id: null,
            deletedAt: null,
          };

          const newCategoryResult = await handleGenericCreate(categoryReq, "category");

          if (newCategoryResult.success && newCategoryResult.data?._id) {
            categoryIds.push(newCategoryResult.data._id);
            continue;
          }

          if (newCategoryResult.status === 409) {
            const retryLookup = await handleGenericFindOne(req, "category", {
              searchCriteria: {
                slug: generatedSlug,
                deletedAt: null,
              },
            });
            if (retryLookup.success && retryLookup.data?._id) {
              categoryIds.push(retryLookup.data._id);
              continue;
            }

            const retryNameLookup = await handleGenericFindOne(req, "category", {
              searchCriteria: {
                name: normalizedName,
                deletedAt: null,
              },
            });
            if (retryNameLookup.success && retryNameLookup.data?._id) {
              categoryIds.push(retryNameLookup.data._id);
              continue;
            }
          }

          return res.status(500).json({
            success: false,
            message: "Failed to create category",
            error: newCategoryResult.error || "unknown_error",
          });
        }

        const imageEntries = extractShopifyImageEntries(product);
        const featuredImage = imageEntries.length > 0 ? imageEntries[0].src : null;
        const galleryImages = imageEntries.slice(1).map((entry) => entry.src).filter(Boolean);

        let baseProductId = null;
        let baseProductImage = null;
        let baseProductGallery = [];
        let baseProductRecord = null;

        const existingBaseProduct = await handleGenericFindOne(req, "product", {
          searchCriteria: {
            product_name: baseProductName,
            company_id: store.company_id,
            deletedAt: null,
          },
        });

        if (existingBaseProduct.success && existingBaseProduct.data?._id) {
          baseProductId = existingBaseProduct.data._id;
          baseProductImage = existingBaseProduct.data?.product_image || featuredImage;
          baseProductGallery = Array.isArray(existingBaseProduct.data?.multi_images)
            ? existingBaseProduct.data.multi_images
            : galleryImages;
          baseProductRecord = existingBaseProduct.data;
          existingCount += 1;
        } else {
          const baseProductReq = Object.create(req);
          baseProductReq.body = {
            product_name: baseProductName,
            product_code: primarySku,
            company_id: store.company_id,
            product_price: resolvedPrice,
            quantity: resolvedQuantity,
            product_description: product?.body_html || "",
            product_image: featuredImage,
            multi_images: galleryImages,
            deletedAt: null,
            product_type: variants.length > 1 ? "Variable" : "Single",
            weight: primaryVariant?.grams,
            category_id: categoryIds,
            sku: primarySku,
            status: "active",
          };

          const baseCreationResult = await handleGenericCreate(baseProductReq, "product");
          if (!baseCreationResult.success) {
            return res.status(500).json({
              success: false,
              message: "Failed to create base product from Shopify",
              error: baseCreationResult.error,
            });
          }

          const createdProductId =
            baseCreationResult.data?._id ||
            baseCreationResult.data?.id ||
            baseCreationResult.data?._doc?._id;
          baseProductId =
            createdProductId && typeof createdProductId.toString === "function"
              ? createdProductId.toString()
              : createdProductId
              ? String(createdProductId)
              : null;

          baseProductImage =
            baseCreationResult.data?.product_image || featuredImage || null;
          baseProductGallery = Array.isArray(baseCreationResult.data?.multi_images)
            ? baseCreationResult.data.multi_images
            : galleryImages;
          baseProductRecord = baseCreationResult.data;

          syncedCount += 1;
        }

        const baseProductIdString =
          baseProductId && typeof baseProductId.toString === "function"
            ? baseProductId.toString()
            : baseProductId
            ? String(baseProductId)
            : null;

        if (baseProductIdString && imageEntries.length > 0) {
          const normalizedGallery = Array.isArray(baseProductGallery)
            ? baseProductGallery.filter(Boolean)
            : [];
          const hasLocalFeatured = isLocalProductAssetPath(
            baseProductImage,
            baseProductIdString
          );
          const hasLocalGallery =
            normalizedGallery.length > 0 &&
            normalizedGallery.every((imgPath) =>
              isLocalProductAssetPath(imgPath, baseProductIdString)
            );
          const expectedGalleryCount = Math.max(imageEntries.length - 1, 0);
          const galleryCountMatches =
            normalizedGallery.length === expectedGalleryCount;
          const shouldDownloadImages =
            !hasLocalFeatured ||
            (!hasLocalGallery && expectedGalleryCount > 0) ||
            (!galleryCountMatches && expectedGalleryCount >= 0);

          if (shouldDownloadImages) {
            if (existingBaseProduct.success) {
              await resetProductImageDirectory(baseProductIdString);
            }

            const savedImages = await saveProductImagesLocally(
              baseProductIdString,
              imageEntries
            );

            if (savedImages && (savedImages.featured || savedImages.gallery?.length)) {
              const imageUpdateReq = Object.create(req);
              imageUpdateReq.params = {
                ...(req.params || {}),
                id: baseProductIdString,
              };
              imageUpdateReq.body = {};

              if (savedImages.featured) {
                imageUpdateReq.body.product_image = savedImages.featured;
                baseProductImage = savedImages.featured;
              }

              if (Array.isArray(savedImages.gallery) && savedImages.gallery.length > 0) {
                imageUpdateReq.body.multi_images = savedImages.gallery;
                baseProductGallery = savedImages.gallery;
              } else {
                if (normalizedGallery.length > 0) {
                  imageUpdateReq.body.multi_images = [];
                }
                baseProductGallery = [];
              }

              if (Object.keys(imageUpdateReq.body).length > 0) {
                const updateResult = await handleGenericUpdate(
                  imageUpdateReq,
                  "product",
                  {
                    allowedFields: ["product_image", "multi_images"],
                  }
                );

                if (!updateResult.success) {
                  console.warn(
                    "⚠️ Failed to update saved Shopify product images:",
                    baseProductIdString,
                    updateResult.error || updateResult.message
                  );
                }
              }
            }
          }
        }

        const isParentProduct =
          variants.length > 1 ||
          (variants.length === 1 &&
            variants[0]?.title &&
            variants[0].title !== "Default Title");

        if (isParentProduct && baseProductIdString) {
          const parentHasValue =
            baseProductRecord &&
            baseProductRecord.parent_product_id &&
            String(baseProductRecord.parent_product_id).trim() !== "";

          if (parentHasValue) {
            const parentResetReq = Object.create(req);
            parentResetReq.params = {
              ...(req.params || {}),
              id: baseProductIdString,
            };
            parentResetReq.body = {
              parent_product_id: null,
            };

            await handleGenericUpdate(parentResetReq, "product", {
              allowedFields: ["parent_product_id"],
            });
          }
        }

        const hasVariants =
          variants.length > 1 ||
          (variants.length === 1 &&
            variants[0]?.title &&
            variants[0].title !== "Default Title");

        if (hasVariants && baseProductIdString) {
          for (const variant of variants) {
            const variantSku = sanitizeWooText(
              variant?.sku,
              `SHOP-${product?.id || Date.now()}-${variant?.id || Date.now()}`
            );
            const variantAttributes = buildShopifyVariantAttributes(product, variant);
            const variantName = deriveShopifyVariantName(
              baseProductName,
              variantAttributes,
              variant
            );
            const variantPrice =
              variant?.price !== undefined &&
              variant?.price !== null &&
              String(variant.price).trim() !== ""
                ? String(variant.price)
                : resolvedPrice;
            const variantQuantity =
              typeof variant?.inventory_quantity === "number" &&
              !Number.isNaN(variant.inventory_quantity)
                ? variant.inventory_quantity
                : 0;

            let variantAlreadyExists = null;
            if (variantSku) {
              variantAlreadyExists = await handleGenericFindOne(req, "product", {
                searchCriteria: {
                  sku: variantSku,
                  company_id: store.company_id,
                  deletedAt: null,
                },
              });
            }

            if (variantAlreadyExists?.success && variantAlreadyExists.data?._id) {
              existingCount += 1;
              continue;
            }

            const variantReq = Object.create(req);
            variantReq.body = {
              product_name: variantName,
              product_code: variantSku,
              company_id: store.company_id,
              product_price: variantPrice,
              quantity: variantQuantity,
              product_description: buildVariantDescription(
                product?.body_html,
                variantAttributes
              ),
              product_image: baseProductImage,
              multi_images: baseProductGallery,
              deletedAt: null,
              product_type: "Single",
              sku: variantSku,
              parent_product_id: baseProductIdString,
              category_id: categoryIds,
              status: "active",
            };

            const variantCreationResult = await handleGenericCreate(variantReq, "product");
            if (!variantCreationResult.success) {
              return res.status(500).json({
                success: false,
                message: "Failed to create Shopify variant product",
                error: variantCreationResult.error,
              });
            }

            syncedCount += 1;
          }
        }

        if (baseProductIdString) {
          syncResults.push({
            remote_product_id: product?.id,
            product_id: baseProductIdString,
            product_image: baseProductImage,
            multi_images: baseProductGallery,
            created: !(
              existingBaseProduct.success && existingBaseProduct.data?._id
            ),
            existing: !!(
              existingBaseProduct.success && existingBaseProduct.data?._id
            ),
          });
        }
      }


      // db.product.updateMany(
      //   {
      //     parent_product_id: { $exists: true, $ne: null },
      //     $expr: { $eq: ["$_id", "$parent_product_id"] }
      //   },
      //   { $set: { parent_product_id: null } }
      // );
      

      return res.status(200).json({
        success: true,
        message: "Products synced successfully",
        data: products,
        synced_count: syncedCount,
        existing_count: existingCount,
        pagination,
        synced_products: syncResults,
        meta: productsResponse?.headers ? { headers: productsResponse.headers } : undefined,
      });
    } catch (error) {
      const errorPayload =
        error?.response?.body ??
        error?.response?.data ??
        (typeof error?.message === "string" ? error.message : "Failed to sync products from Shopify");
      return res.status(500).json({
        success: false,
        message: "Failed to sync products from Shopify",
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
      const { limit: limitParam, offset: offsetParam } = req.query || {};
      const parsedLimit = Number.parseInt(limitParam, 10);
      const parsedOffset = Number.parseInt(offsetParam, 10);

      const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(parsedLimit, 100)
          : 10;
      const offset =
        Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

      const response = await woocommerce.get("products", {
        per_page: limit,
        offset,
      });
      const products = Array.isArray(response?.data) ? [...response.data] : [];
      const totalHeader =
        response?.headers?.["x-wp-total"] ?? response?.headers?.["X-WP-Total"];
      const totalItems = Number.isFinite(Number(totalHeader))
        ? Number(totalHeader)
        : undefined;

      if (products.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No products found in WooCommerce store",
          pagination: {
            limit,
            offset,
            total: totalItems ?? 0,
          },
          data: [],
          synced_products: [],
        });
      }

      // console.log("🔍 products:", products);
      // console.log("🔍 store:", store);
      // return res.status(200).json({
      //   success: true,
      //   message: "Products fetched successfully",
      //   data: products,
      //   meta: response?.headers ? { headers: response.headers } : undefined,
      // });


      
      let syncedCount = 0;
      let existingCount = 0;
      const syncResults = [];

      for (const product of products) {
        // ===== Start WooCommerce variant combination processing =====
        const baseProductName = sanitizeWooText(product?.name);
        if (!baseProductName) {
          console.warn("⚠️ Skipping WooCommerce product without a name:", product?.id);
          continue;
        }

        const attributeCombinations = generateAttributeCombinations(product?.attributes);
        const hasVariants = attributeCombinations.length > 0;
        const variantEntries = hasVariants
          ? attributeCombinations.map((attributes) => ({
              attributes,
              nameSuffix: attributes.map((attribute) => attribute.value).join(" / "),
            }))
          : [];

        const categoryIds = [];
        if (Array.isArray(product.categories)) {
          for (const category of product.categories) {
            const categoryName = sanitizeWooText(category?.name);
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

        const imageEntries = extractWooImageEntries(product);
        const featuredImage = imageEntries.length > 0 ? imageEntries[0].src : null;
        const galleryImages = imageEntries.slice(1).map((entry) => entry.src).filter(Boolean);

        const resolvedPrice =
          product?.price ??
          product?.regular_price ??
          product?.sale_price ??
          (Array.isArray(product?.variants)
            ? product.variants.find((variant) => variant?.price)?.price
            : null);

        const productPrice =
          resolvedPrice !== undefined &&
          resolvedPrice !== null &&
          String(resolvedPrice).trim() !== ""
            ? String(resolvedPrice)
            : "0";

        const resolvedQuantity =
          typeof product?.quantity === "number" && !Number.isNaN(product.quantity)
            ? product.quantity
            : typeof product?.stock_quantity === "number"
            ? product.stock_quantity
            : 0;

        // ----- Ensure base (parent) product exists -----
        let baseProductId = null;
        let baseProductImage = null;
        let baseProductGallery = [];

        const existingBaseProduct = await handleGenericFindOne(req, "product", {
          searchCriteria: {
            product_name: baseProductName,
            company_id: store.company_id,
            deletedAt: null,
          },
        });

        if (existingBaseProduct.success && existingBaseProduct.data?._id) {
          baseProductId = existingBaseProduct.data._id;
          baseProductImage = existingBaseProduct.data?.product_image || featuredImage;
          baseProductGallery = Array.isArray(existingBaseProduct.data?.multi_images)
            ? existingBaseProduct.data.multi_images
            : galleryImages;
          existingCount += 1;
        } else {
          const baseProductReq = Object.create(req);
          baseProductReq.body = {
            product_name: baseProductName,
            product_code: sanitizeWooText(product?.sku, `WC-${product?.id || Date.now()}`),
            company_id: store.company_id,
            brand_id: product.brand_id,
            product_price: productPrice,
            quantity: resolvedQuantity,
            product_description: sanitizeWooText(product?.description),
            product_image: featuredImage,
            multi_images: galleryImages,
            deletedAt: null,
            product_type:
              hasVariants || product.type === "variable" ? "Variable" : "Single",
            weight: product.weight,
            unit: product.unit,
            category_id: categoryIds,
            sku: sanitizeWooText(product?.sku, `WC-${product?.id || Date.now()}`),
          };

          const baseCreationResult = await handleGenericCreate(baseProductReq, "product");
          if (!baseCreationResult.success) {
            return res.status(500).json({
              success: false,
              message: "Failed to create base product from WooCommerce",
              error: baseCreationResult.error,
            });
          }

            const createdProductId =
              baseCreationResult.data?._id ||
              baseCreationResult.data?.id ||
              baseCreationResult.data?._doc?._id;
            baseProductId =
              createdProductId && typeof createdProductId.toString === "function"
                ? createdProductId.toString()
                : createdProductId
                ? String(createdProductId)
                : null;
          baseProductImage =
            baseCreationResult.data?.product_image || featuredImage || null;
          baseProductGallery = Array.isArray(baseCreationResult.data?.multi_images)
            ? baseCreationResult.data.multi_images
            : galleryImages;

          syncedCount += 1;
        }

        const baseProductIdString =
          baseProductId && typeof baseProductId.toString === "function"
            ? baseProductId.toString()
            : baseProductId
            ? String(baseProductId)
            : null;

        if (baseProductIdString && imageEntries.length > 0) {
          const normalizedGallery = Array.isArray(baseProductGallery)
            ? baseProductGallery.filter(Boolean)
            : [];
          const hasLocalFeatured = isLocalProductAssetPath(
            baseProductImage,
            baseProductIdString
          );
          const hasLocalGallery =
            normalizedGallery.length > 0 &&
            normalizedGallery.every((imgPath) =>
              isLocalProductAssetPath(imgPath, baseProductIdString)
            );
          const expectedGalleryCount = Math.max(imageEntries.length - 1, 0);
          const galleryCountMatches =
            normalizedGallery.length === expectedGalleryCount;
          const shouldDownloadImages =
            !hasLocalFeatured ||
            (!hasLocalGallery && expectedGalleryCount > 0) ||
            (!galleryCountMatches && expectedGalleryCount >= 0);

          if (shouldDownloadImages) {
            if (existingBaseProduct.success) {
              await resetProductImageDirectory(baseProductIdString);
            }

            const savedImages = await saveProductImagesLocally(
              baseProductIdString,
              imageEntries
            );

              if (savedImages && (savedImages.featured || savedImages.gallery?.length)) {
                const imageUpdateReq = Object.create(req);
                imageUpdateReq.params = {
                  ...(req.params || {}),
                id: baseProductIdString,
                };
                imageUpdateReq.body = {};

                if (savedImages.featured) {
                  imageUpdateReq.body.product_image = savedImages.featured;
                  baseProductImage = savedImages.featured;
                }

              if (Array.isArray(savedImages.gallery) && savedImages.gallery.length > 0) {
                  imageUpdateReq.body.multi_images = savedImages.gallery;
                  baseProductGallery = savedImages.gallery;
              } else {
                if (normalizedGallery.length > 0) {
                  imageUpdateReq.body.multi_images = [];
                }
                baseProductGallery = [];
                }

                if (Object.keys(imageUpdateReq.body).length > 0) {
                const updateResult = await handleGenericUpdate(
                  imageUpdateReq,
                  "product",
                  {
                    allowedFields: ["product_image", "multi_images"],
                  }
                );

                if (!updateResult.success) {
            console.warn(
                    "⚠️ Failed to update saved WooCommerce product images:",
                    baseProductIdString,
                    updateResult.error || updateResult.message
            );
          }
              }
            }
          }
        }

        // If no variants, base product is sufficient
        if (!hasVariants) {
          if (baseProductIdString) {
            syncResults.push({
              remote_product_id: product?.id,
              product_id: baseProductIdString,
              product_image: baseProductImage,
              multi_images: baseProductGallery,
              created: !existingBaseProduct.success,
              existing: !!existingBaseProduct.success,
            });
          }
          continue;
        }

        // ----- Create variant (child) products -----
        for (const variantEntry of variantEntries) {
          const variantName = `${baseProductName} - ${variantEntry.nameSuffix}`;

          const existingVariant = await handleGenericFindOne(req, "product", {
            searchCriteria: {
              product_name: variantName,
              company_id: store.company_id,
              deletedAt: null,
            },
          });

          if (existingVariant.success) {
            existingCount += 1;
            continue;
          }

          const variantSku = createVariantSku(product?.sku, variantEntry.attributes);
          const variantDescription = buildVariantDescription(
            product?.description,
            variantEntry.attributes
          );

          const variantReq = Object.create(req);
          variantReq.body = {
            product_name: variantName,
            product_code: variantSku,
            company_id: store.company_id,
            brand_id: product.brand_id,
            product_price: productPrice,
            quantity: resolvedQuantity,
            product_description: variantDescription,
            product_image: baseProductImage,
            multi_images: baseProductGallery,
            deletedAt: null,
            product_type: "Single",
            weight: product.weight,
            unit: product.unit,
            category_id: categoryIds,
            sku: variantSku,
            parent_product_id: baseProductId,
          };

          const creationResult = await handleGenericCreate(variantReq, "product");
          if (creationResult.success) {
            syncedCount += 1;
            continue;
          }

          return res.status(500).json({
            success: false,
            message: "Failed to sync product from WooCommerce",
            error: creationResult.error,
          });
        }
        // ===== End WooCommerce variant combination processing =====

        if (baseProductIdString) {
          syncResults.push({
            remote_product_id: product?.id,
            product_id: baseProductIdString,
            product_image: baseProductImage,
            multi_images: baseProductGallery,
            created: !existingBaseProduct.success,
            existing: !!existingBaseProduct.success,
          });
        }
      }

      return res.status(200).json({
        success: true,
        message: "Products synced successfully",
        data: products,
        synced_count: syncedCount,
        existing_count: existingCount,
        pagination: {
          limit,
          offset,
          total: totalItems,
        },
        synced_products: syncResults,
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
    // syncStoreBrand,
    syncStoreProduct
  };
  
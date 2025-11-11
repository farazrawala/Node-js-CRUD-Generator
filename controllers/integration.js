const WooCommerceRestApi =
  require("@woocommerce/woocommerce-rest-api").default;
require("@shopify/shopify-api/adapters/node");
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");

const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
} = require("../utils/modelHelper");


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
        ? response.data
        : [];

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
          wooToLocalCategoryIds.set(category.id, existingCategory.data._id);
          syncResults.skipped.push({
            wooCategoryId: category.id,
            name: trimmedName,
            reason: "already_exists",
          });
          continue;
        }

        const categoryReq = Object.create(req);
        categoryReq.body = {
          name: trimmedName,
          description: category?.description || "",
          isActive: category?.display !== "hidden",
          sort_order:
            typeof category?.menu_order === "number" ? category.menu_order : 0,
          parent_id: parentId ?? null,
        };

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
    ///////////////Sync  Brand///////////////    
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
    
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9.-]+$/i.test(shopDomain)) && shopDomain !== "myshopify.com" {
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
    syncStoreCategory
  };
  
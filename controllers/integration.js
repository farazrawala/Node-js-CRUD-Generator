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
              shopify: shopify,
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
          const errorPayload = error.response
            ? error.response
            : error.message || error;
          return res.status(500).json({
            success: false,
            shopify: shopify,
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
  
    checkIntegrationActive
  };
  
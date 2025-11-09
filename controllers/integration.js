const WooCommerceRestApi =
  require("@woocommerce/woocommerce-rest-api").default;
const { shopifyApi, ApiVersion } = require("@shopify/shopify-api");

const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetById,
  handleGenericGetAll,
  handleGenericFindOne,
} = require("../utils/modelHelper");

  async function checkIntegrationActive(req, res) {
    const response = await handleGenericGetById(req, "integration", {
      excludeFields: [],
    });
   
    if (response.data.status === "active") {
      // return res.status(200).json({
      //   success: true,
      //   message: "Integration is active",
      //   data: response.data,
      // });

      if(response.data.store_type === "woocommerce") {
        const woocommerce = new WooCommerceRestApi({
          url: response.data.url,
          consumerKey: response.data.key,
          consumerSecret: response.data.secret,
          version: "wc/v3",
        });
        try {
          const responseData = await woocommerce.get("products");
          const products = responseData && responseData.data ? responseData.data : [];
          return res.status(200).json({
            success: true,
            message: "Products fetched successfully",
            data: products,
            meta: responseData && responseData.headers ? { headers: responseData.headers } : undefined,
          });
        } catch (error) {
          const errorPayload = error.response ? error.response.data : error.message;
          return res.status(500).json({
            success: false,
            message: "Failed to fetch products from WooCommerce",
            error: errorPayload,
          });
        }
      } else if (response.data.store_type === "shopify") {
        const shopDomain = (response.data.url || "")
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, "");

        if (!shopDomain) {
          return res.status(400).json({
            success: false,
            message: "Invalid Shopify shop URL",
          });
        }

        const shopify = shopifyApi({
          apiKey: response.data.key,
          apiSecretKey: response.data.secret,
          scopes: ["read_products"],
          hostName: shopDomain,
          apiVersion: ApiVersion.October24 ?? "2024-10",
        });

        try {
          const session = shopify.session.customAppSession(shopDomain);
          session.accessToken = response.data.secret;

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
            message: "Failed to fetch products from Shopify",
            error: errorPayload,
          });
        }
      }

    } else {
      return res.status(400).json({
        success: false,
        message: "Integration is not active",
        data: response.data,
      });
    }
  }
  
  
  module.exports = {
  
    checkIntegrationActive
  };
  
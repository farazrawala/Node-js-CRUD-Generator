const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
    handleGenericFindOne,
  } = require("../utils/modelHelper");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const ProcessModel = require("../models/process");

/**
 * Entry point for queued integration jobs.
 * Pulls the next active `process` record and delegates the action
 * to the correct store specific handler.
 */
async function execute_process(req, res) {
    const response = await handleGenericFindOne(req, "process", {
      searchCriteria: {
        status: "active",
      },
      populate: ["company_id","integration_id","product_id"],
    });

    if(response.success && response.data){
      const process = response.data;

    //   console.log('process+___',process.action);
    //   console.log('process+___',process.integration_id?.store_type);
      switch(process.action){
        case "fetch_products" : {
            if(process.integration_id?.store_type == "woocommerce"){
              return fetch_products_woocommerce(req, res,process);
            }else if(process.integration_id?.store_type == "shopify"){
              return fetch_products_shopify(req, res,process);
            }
        }
        case "sync_product" : {
            if(process.integration_id?.store_type == "woocommerce"){
              return sync_product_woocommerce(req, res,process);
            }else if(process.integration_id?.store_type == "shopify"){
              return sync_product_shopify(req, res,process);
            }
        }  
        default: {
          return res.status(400).json({
            success: false,
            message: "Invalid action",
          });
        }
    }
  }
  else{
    return res.status(400).json({
      success: false,
      message: "No process found",
    });
  }
}

  /**
   * Synchronise a local product with WooCommerce.
   * Steps:
   * 1. Validate integration + product payload.
   * 2. Build WooCommerce client with resolved credentials.
   * 3. Skip creation when product already exists, otherwise create it.
   * 4. Update process record with completion or failure outcome.
   */
  async function sync_product_woocommerce(req, res,process){
    // Unpack populated integration + product so we can work with their fields directly.
    const integration = process?.integration_id;
    const product = process?.product_id;
  
    if (!integration || integration.store_type !== "woocommerce") {
      return res.status(400).json({
        success: false,
        message: "WooCommerce integration details are missing or invalid.",
      });
    }
  
    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Product details are missing from the process payload.",
      });
    }
  
    const storeUrl = typeof integration.url === "string" ? integration.url.trim() : "";
    const consumerKey =
      integration.key ||
      integration.secret_key ||
      integration.consumer_key ||
      integration.client_key ||
      integration.public_key;
    const consumerSecret =
      integration.secret ||
      integration.api_key ||
      integration.consumer_secret ||
      integration.client_secret ||
      integration.private_key;
  
    if (!storeUrl || !consumerKey || !consumerSecret) {
      return res.status(400).json({
        success: false,
        message: "WooCommerce credentials are incomplete. Please verify url, key, and secret.",
      });
    }
  
    // Instantiate WooCommerce client with the resolved credentials.
    const woocommerce = new WooCommerceRestApi({
      url: storeUrl,
      consumerKey,
      consumerSecret,
      version: "wc/v3",
    });
  
    // Prefer SKU > product_code > Mongo _id so we can recreate deterministic IDs in Woo.
    const sku =
      (typeof product.sku === "string" && product.sku.trim()) ||
      (typeof product.product_code === "string" && product.product_code.trim()) ||
      (product._id ? String(product._id) : "");
  
    if (!sku) {
      return res.status(400).json({
        success: false,
        message: "Product SKU or identifier is required to sync with WooCommerce.",
      });
    }
  
    // Map local product fields to the WooCommerce product payload.
    const productPayload = {
      name: product.product_name,
      type:
        typeof product.product_type === "string" &&
        product.product_type.toLowerCase() === "variable"
          ? "variable"
          : "simple",
      regular_price:
        product.product_price !== undefined && product.product_price !== null
          ? String(product.product_price)
          : "0",
      sku,
      description: product.product_description || "",
      short_description: product.product_description || "",
      status: "publish",
    };
  
    if (product.weight !== undefined && product.weight !== null) {
      productPayload.weight = String(product.weight);
    }
  
    try {
      // Query WooCommerce to determine whether the product already exists by SKU.
      const existingResponse = await woocommerce.get("products", { sku });
      const existingProducts = Array.isArray(existingResponse?.data)
        ? existingResponse.data
        : [];
  
      if (existingProducts.length > 0) {
        await ProcessModel.findByIdAndUpdate(process._id, {
          status: "completed",
          remarks: `Product Name : ${product.product_name} already existed on WooCommerce — skipped creation.`,
        });
  
        return res.status(200).json({
          success: true,
          data: existingProducts[0],
          message: `Product Name : ${product.product_name} already exists on WooCommerce.`,
        });
      }

      // Product was not found remotely, proceed with creation.
      const createdProductResponse = await woocommerce.post(
        "products",
        productPayload
      );
  
      await ProcessModel.findByIdAndUpdate(process._id, {
        status: "completed",
        remarks: `Product Name : ${product.product_name} created on WooCommerce.`,
      });
  
      return res.status(201).json({
        success: true,
        data: createdProductResponse?.data,
        message: `Product Name : ${product.product_name} synced to WooCommerce successfully.`,
      });
    } catch (error) {
      // Log the error for operators and mark the process as failed for visibility / retries.
      console.error("WooCommerce product sync failed:", error?.response?.data || error.message);
  
      await ProcessModel.findByIdAndUpdate(process._id, {
        status: "failed",
        remarks: `Failed to sync Product Name : ${product.product_name} to WooCommerce.`,
      });
  
      const errorMessage =
        error?.response?.data?.message ||
        error?.message ||
        `Failed to sync Product Name : ${product.product_name} to WooCommerce.`;
  
      return res.status(500).json({
        success: false,
        message: errorMessage,
        error: error?.response?.data || error,
      });
    }
  }
  


  
  module.exports = {
    execute_process,
  };
  
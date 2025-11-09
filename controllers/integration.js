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
        const woocommerce = new WooCommerceAPI({
          url: response.data.url,
          consumerKey: response.data.key,
          consumerSecret: response.data.secret,
          version: "wc/v3",
        });
        const products = await woocommerce.get("products");
        return res.status(200).json({
          success: true,
          message: "Products fetched successfully",
          data: products,
        });
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
  
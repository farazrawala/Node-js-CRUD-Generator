const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
    handleGenericFindOne,
  } = require("../utils/modelHelper");
  
  async function purchaseOrderCreate(req, res) {
    try {
      console.log("🔍 Incoming request body:", JSON.stringify(req.body, null, 2));
      console.log("🔍 product_id type:", typeof req.body.product_id, "value:", req.body.product_id);
      console.log("🔍 qty type:", typeof req.body.qty, "value:", req.body.qty);
      console.log("🔍 price type:", typeof req.body.price, "value:", req.body.price);
      
      // First, create the purchase order
      const purchaseOrderResponse = await handleGenericCreate(req, "purchase_order", {
        afterCreate: async (record, req) => {
          console.log("✅ Purchase Order created:", record._id);
        },
      });

      // Transform form array data to object array
      // Handle both product_id[] and product_ids[] formats
      let productIds = [];
      
      // Check if data comes as arrays
      const productIdArray = Array.isArray(req.body['product_id[]'])
      ? req.body['product_id[]']
      : [req.body['product_id[]']].filter(Boolean);
    
    const qtyArray = Array.isArray(req.body['qty[]'])
      ? req.body['qty[]']
      : [req.body['qty[]']].filter(Boolean);
    
    const priceArray = Array.isArray(req.body['price[]'])
      ? req.body['price[]']
      : [req.body['price[]']].filter(Boolean);
    
    const totalArray = Array.isArray(req.body['total[]'])
      ? req.body['total[]']
      : [req.body['total[]']].filter(Boolean);
    
    console.log("🔍 Raw Arrays:", {
      productIdArray,
      qtyArray,
      priceArray,
      totalArray,
    });
      if (productIdArray.length > 0) {
        productIds = productIdArray.map((productId, index) => ({
          product_id: productId,
          qty: parseFloat(qtyArray[index]) || 0,
          price: parseFloat(priceArray[index]) || 0
        }));
      } else if (req.body.product_ids && Array.isArray(req.body.product_ids)) {
        // Already in correct format
        productIds = req.body.product_ids;
      }
      
      console.log("🔍 Final productIds:", productIds);
      
      // Create purchase order items if product data exists
      const purchaseOrderItems = [];
      if (productIds.length > 0) {
        console.log("🔍 Creating", productIds.length, "purchase order items...");
        for (const productItem of productIds) {
          console.log("🔍 Processing product item:", productItem);
          
          // Create a new request body for each item
          const itemData = {
            purchase_order_id: purchaseOrderResponse.data._id,
            product_id: productItem.product_id,
            qty: productItem.qty,
            price: productItem.price,
            company_id: req.body.company_id,
            created_by: req.body.created_by,
            status: "active"
          };
          
          console.log("🔍 Item data to insert:", JSON.stringify(itemData, null, 2));
          
          const itemResponse = await handleGenericCreate(
            { body: itemData, user: req.user }, 
            "purchase_order_item"
          );
          
          console.log("🔍 Item response:", JSON.stringify(itemResponse, null, 2));
          
          if (itemResponse.data) {
            purchaseOrderItems.push(itemResponse.data);
            console.log("✅ Purchase order item created successfully");
          } else {
            console.error("❌ Failed to create purchase order item. Response:", itemResponse);
          }
        }
      }

      // Return purchase order with its items
      return res.status(200).json({
        ...purchaseOrderResponse,
        items: purchaseOrderItems
      });
    } catch (error) {
      console.error("Purchase Order creation error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create purchase order",
        error: error.message
      });
    }
  }
  
  
  
  module.exports = {
    purchaseOrderCreate,
    // purchase_orderUpdate,
    // purchase_orderById,
    // getAllpurchase_order,
    // getallpurchase_orderactive,
    // purchase_orderdelete,
    // findActiveBlogByTitle,
    // findBlogByParams,
  };
  
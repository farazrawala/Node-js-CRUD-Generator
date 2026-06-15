const express = require("express");
const router = express.Router();

// Dynamic route generator
const { registerAllModelRoutes } = require("../utils/dynamicRouteGenerator");
const {
  paymentReceiptCreate,
  paymentReceiptUpdate,
} = require("../controllers/payment_receipt");
const { checkProductAlert } = require("../controllers/alerts");
const {
  // handleUserSignup,

  // handleUserUpdate,
  // getAllUser,
  // userById,

  // findUserByEmail,

  handleUserLogin,
  handleAdminLogin,
  handleUserSignupCompany,
  countTotalCustomers,
  countTotalUsers,
} = require("../controllers/user");

const { assetsSave, assetsUpdate } = require("../controllers/assets");
const {
  productCreate,
  productUpdate,
  productById,
  getAllProducts,
  getAllActiveProducts,
  // updateWarehouseQuantity,
  // getProductWarehouseInventory,
  // checkWarehouseStock,
  getProductsByWarehouse,
  productCreateVariation,
  productUpdateVariation,
  getProductVariationById,
  getAllActiveProductsPOS,
  productDelete,
  productCostUpdate,
  // cost_of_goods_available,
  updateWarehouseDefault,
} = require("../controllers/product");
const {
  cost_of_goods_available,
  inventoryMovementsCreate,
  findStockByProductId,
  stockTransfer,
  updateWholeSalePrice,
} = require("../controllers/inventory_movements");

const { expenseCreate, expenseUpdate } = require("../controllers/expense");

const {
  order_save,
  order_update,
  order_delete,
  getOrderByorderItem,
  getOrderByOrderNo,
  findProfitByOrderItem,
  findSales,
  findTotalSalesByOrder,
  findSalesDayWise,
  invoiceUpdate,
} = require("../controllers/order");
const { costOfGoodsSoldByOrderItem } = require("../controllers/order_item");
const {
  checkIntegrationActive,
  syncStoreCategory,
  // syncStoreBrand,
  syncProductRelations,
  syncStoreProduct,
} = require("../controllers/integration");

const { execute_process, processBulkCreate } = require("../controllers/process");
const { logControllerError } = require("../utils/logControllerError");

const {
  apiCreateStockTransfer,
  apiGetStockTransfers,
} = require("../controllers/stockTransfer");
const {
  createStockMovement,
  updateStockMovement,
  deleteStockMovement,
  getStockMovementById,
  getAllStockMovements,
  getAllStockMovementsActive,
} = require("../controllers/stock_movement");

const {
  purchaseOrderCreate,
  purchase_order_update,
  purchase_order_delete,
  getPurchaseOrderByPurchaseItem,
  getPurchaseOrderByOrderNo,
} = require("../controllers/purchase_order");
const {
  purchaseReturnCreate,
  purchase_return_update,
  purchase_return_delete,
  getPurchaseReturnByReturnItem,
  getPurchaseReturnByReturnNo,
} = require("../controllers/purchase_return");
const {
  salesReturnCreate,
  sales_return_update,
  sales_return_delete,
  getSalesReturnByReturnItem,
  getSalesReturnByReturnNo,
  findProfitBySalesReturnItem,
} = require("../controllers/sales_return");
const {
  companyCreate,
  getMyBranches,
  removeCache,
  listAllCache,
} = require("../controllers/company");
const {
  transactionBulkCreate,
  getTransactionsListWithDebitCreditSummary,
  getMyLedgerTransactions,
} = require("../controllers/transaction");
const {
  accountCreate,
  accountUpdate,
  fetchAccountsByType,
  getBalanceSheet,
  getBalanceSheetDifference,
  getCompanyDefaultDiscountSums,
} = require("../controllers/account");

const {
  amountTransferCreate,
  amountTransferUpdate,
} = require("../controllers/amount_transfer");
const {
  adjustmentCreate,
  adjustmentUpdate,
} = require("../controllers/adjustment");
// Note: Blog routes are now handled dynamically by registerAllModelRoutes
// Uncomment these if you need custom routes
// const {
//   blogCreate,
//   blogUpdate,
//   blogById,
//   getAllblog,
//   getallblogactive,
//   blogdelete,
// } = require("../controllers/blog");

const {
  warehouseCreate,
  warehouseUpdate,
  warehouseById,
  getAllwarehouse,
  getallwarehouseactive,
  warehousedelete,
} = require("../controllers/warehouse");

// Note: Company routes are now handled dynamically
// const {
//   companyCreate,
//   companyUpdate,
//   companyById,
//   getAllcompany,
//   getallcompanyactive,
//   companydelete,
// } = require("../controllers/company");

// Note: Complain routes are now handled dynamically
// const {
//   complainCreate,
//   complainUpdate,
//   complainById,
//   getAllcomplain,
// } = require("../controllers/complain");

// Note: Order and Order Item routes are now handled dynamically
// const {
//   orderCreate,
//   orderUpdate,
//   orderById,
//   getAllorder,
// } = require("../controllers/order");

// const {
//   order_itemCreate,
//   order_itemUpdate,
//   order_itemById,
//   getAllorder_item,
// } = require("../controllers/order_item");

// User routes - Custom auth and management
router.post("/user/user_company", handleUserSignupCompany);
// router.post("/user/create", handleUserSignup);
// router.patch("/user/update/:id", handleUserUpdate);
router.post("/user/login", handleUserLogin);
router.get("/user/total-customers", countTotalCustomers);
router.get("/user/total-users", countTotalUsers);
// router.get("/user/get-all", getAllUser);
// router.get("/user/get/:id", userById);
// router.post("/user/get-one", findUserByEmail);

router.get("/alerts/check-product-alert/:product_id/:qty", checkProductAlert);

router.post("/purchase_order/purchase_order_create", purchaseOrderCreate);
router.patch(
  "/purchase_order/purchase_order_update/:id",
  purchase_order_update,
);
router.delete(
  "/purchase_order/purchase_order_delete/:id",
  purchase_order_delete,
);
router.get(
  "/purchase_order/get-purchase-order-by-purchase-item",
  getPurchaseOrderByPurchaseItem,
);
router.get(
  "/purchase_order/get-purchase-order-by-purchase-item/:id",
  getPurchaseOrderByPurchaseItem,
);
router.get(
  "/purchase_order/get-purchase-order-by-order-no/:id",
  getPurchaseOrderByOrderNo,
);

router.post("/purchase_return/purchase_return_create", purchaseReturnCreate);
router.patch(
  "/purchase_return/purchase_return_update/:id",
  purchase_return_update,
);
router.delete(
  "/purchase_return/purchase_return_delete/:id",
  purchase_return_delete,
);
router.get(
  "/purchase_return/get-purchase-return-by-return-item",
  getPurchaseReturnByReturnItem,
);
router.get(
  "/purchase_return/get-purchase-return-by-return-item/:id",
  getPurchaseReturnByReturnItem,
);
router.get(
  "/purchase_return/get-purchase-return-by-return-no/:id",
  getPurchaseReturnByReturnNo,
);

router.post("/sales_return/sales_return_create", salesReturnCreate);
router.get(
  "/sales_return/profit-by-sales-return-item",
  findProfitBySalesReturnItem,
);
router.patch("/sales_return/sales_return_update/:id", sales_return_update);
router.delete("/sales_return/sales_return_delete/:id", sales_return_delete);
router.get(
  "/sales_return/get-sales-return-by-return-item",
  getSalesReturnByReturnItem,
);
router.get(
  "/sales_return/get-sales-return-by-return-item/:id",
  getSalesReturnByReturnItem,
);
router.get(
  "/sales_return/get-sales-return-by-return-no/:id",
  getSalesReturnByReturnNo,
);

// Expense routes
router.post("/expense/save", expenseCreate);
router.patch("/expense/update/:id", expenseUpdate);

// Amount transfer routes
// Inventory movements routes
router.get(
  "inventory_movements/update_wholesale_price/:type/:order_item_id/:product_id",
  updateWholeSalePrice,
);
router.post("/inventory_movements/save", inventoryMovementsCreate);
router.post("/inventory_movements/stock-transfer", stockTransfer);

// Product routes - Custom CRUD + warehouse inventory management
router.post("/product/create", productCreate);
router.patch("/product/update/:id", productUpdate);
router.patch("/product/update-cost/:id", productCostUpdate);
router.get("/product/get/:id", productById);
router.get("/product/get-all", getAllProducts);
router.get("/product/get-all-active", getAllActiveProducts);
router.get(
  "/inventory_movements/cost-of-goods-available",
  cost_of_goods_available,
);
router.get(
  "/inventory_movements/stock-by-product/:product_id",
  findStockByProductId,
);
router.get("/inventory_movements/stock-by-product", findStockByProductId);
// router.get("/product/:id/cost-of-goods-available", cost_of_goods_available);

router.delete("/product/delete/:id", productDelete);

// Integration routes
router.get("/integration/check-active/:id", checkIntegrationActive);
router.get("/integration/sync-store-category/:id", syncStoreCategory);
// router.get("/integration/sync-store-brand/:id", syncStoreBrand);
router.get("/integration/sync-store-product/:id", syncStoreProduct);
router.get("/integration/find-product-relations/:id", syncProductRelations);

// Process routes (GET or POST — some clients/proxies use POST)
router.post("/process/bulk-create", processBulkCreate);
router.post("/processs/bulk-create", processBulkCreate);
router.get("/process/execute-process", execute_process);
router.post("/process/execute-process", execute_process);
router.get("/process/execute-process/:id", execute_process);
router.post("/process/execute-process/:id", execute_process);

// Company routes
router.get("/company/get-my-branches", getMyBranches);

router.get("/company/list-cache", listAllCache);

router.get("/company/remove-cache", removeCache);
router.delete("/company/remove-cache", removeCache);
router.post("/company/remove-cache", removeCache);

// Product warehouse inventory management routes
// router.patch("/product/:id/warehouse-quantity", updateWarehouseQuantity);
// router.get("/product/:id/warehouse-inventory", getProductWarehouseInventory);
// router.get("/product/:id/check-stock", checkWarehouseStock);
router.get("/warehouse/:warehouseId/products", getProductsByWarehouse);

// Stock transfer routes
router.get("/stock-transfer", apiGetStockTransfers);
router.post("/stock-transfer", apiCreateStockTransfer);

// Stock movement routes (auto sync warehouse_inventory)
router.post("/stock-movement", createStockMovement);
router.patch("/stock-movement/:id", updateStockMovement);
router.delete("/stock-movement/:id", deleteStockMovement);
router.get("/stock-movement/:id", getStockMovementById);
router.get("/stock-movement", getAllStockMovements);
router.get("/stock-movement/get-all-active", getAllStockMovementsActive);
// Backward-compatible aliases for dynamic-route style endpoints
router.post("/stock_movement/create", createStockMovement);
router.patch("/stock_movement/update/:id", updateStockMovement);
router.delete("/stock_movement/delete/:id", deleteStockMovement);
router.get("/stock_movement/get/:id", getStockMovementById);
router.get("/stock_movement/get-all", getAllStockMovements);
router.get("/stock_movement/get-all-active", getAllStockMovementsActive);

// Category routes - Custom CRUD
router.post("/product/create-product-variation", productCreateVariation);
router.patch("/product/update-product-variation/:id", productUpdateVariation);
router.get("/product/get-product-variation/:id", getProductVariationById);
router.get("/product/get-all-active-pos", getAllActiveProductsPOS);
router.patch("/product/:id/update-default-warehouse", updateWarehouseDefault);
// Blog, Integration, Warehouse, Company, Complain, Order, and Order_item routes
// are now automatically generated by registerAllModelRoutes() at the bottom of this file

// Account routes
router.post("/account/custom-create", accountCreate);
router.patch("/account/custom-update/:id", accountUpdate);
router.get("/account/fetch-account-by-type", fetchAccountsByType);
router.get("/account/balance-sheet", getBalanceSheet);
router.get("/account/balance-sheet-difference", getBalanceSheetDifference);
router.get("/account/default-discount-sums", getCompanyDefaultDiscountSums);

// Adjustment routes
router.post("/adjustment/save", adjustmentCreate);
router.patch("/adjustment/update_record/:id", adjustmentUpdate);

// Amount transfer routes
router.post("/amount_transfer/save", amountTransferCreate);
router.patch("/amount_transfer/update_record/:id", amountTransferUpdate);

// Order routes
router.post("/order/order_save", order_save);
router.patch("/order/order_update/:id", order_update);
router.delete("/order/order_delete/:id", order_delete);
router.get("/order/get-order-by-order-item", getOrderByorderItem);
router.get("/order/profit-by-order-item", findProfitByOrderItem);
router.get(
  "/order_item/cost-of-goods-sold-by-order-item",
  costOfGoodsSoldByOrderItem,
);
router.get("/order/sales", findSales);
router.get("/order/sales-day-wise", findSalesDayWise);
router.get("/order/total-sales-current-month", findTotalSalesByOrder);
router.get("/order/get-order-by-order-no/:id", getOrderByOrderNo);
router.get("/order/public-get-order-by-order-no/:id", getOrderByOrderNo);
router.patch("/order/invoice-update/:id", invoiceUpdate);
router.post("/payment_receipt/save", paymentReceiptCreate);
router.patch("/payment_receipt/update_receipt/:id", paymentReceiptUpdate);
router.post("/transaction/bulk-create", transactionBulkCreate);
router.post("/transactions/bulk-create", transactionBulkCreate);
router.get(
  "/transaction/list-with-summary",
  getTransactionsListWithDebitCreditSummary,
);
router.get("/transaction/get-my-ledger-transaction", getMyLedgerTransactions);
router.get(
  "/transactions/list-with-summary",
  getTransactionsListWithDebitCreditSummary,
);

// Assets routes
router.post("/assets/save", assetsSave);
router.patch("/assets/update/:id", assetsUpdate);

router.post("/test", (req, res) => {
  console.log("Test route hit");
  res.status(200).json({ message: "Test successful" });
});

// Admin routes
router.post("/login/admin", handleAdminLogin);

// Register dynamic CRUD routes for all models
// This automatically creates routes like: /{model}/create, /{model}/update/:id, /{model}/get/:id, etc.
registerAllModelRoutes(router, {
  excludedModels: [
    // User has custom auth routes
    "product", // Product has custom warehouse inventory routes
    "order_item", // Keep custom routes if needed
    "url", // URL has custom routes
    // 'purchase_order' removed - we want BOTH dynamic routes AND custom routes
  ],
  modelConfigs: {
    // You can configure specific models here if needed
    user: {
      enabled: true,
      excludedRoutes: [],
      customRoutes: [],
    },
    blog: {
      enabled: true,
      excludedRoutes: [],
      customRoutes: [],
    },
    integration: {
      enabled: true,
      excludedRoutes: [],
    },
    warehouse: {
      enabled: true,
      excludedRoutes: ["getAllActive"],
      customRoutes: [
        {
          method: "GET",
          path: "/warehouse/get-all-active",
          handler: getallwarehouseactive,
        },
        {
          method: "GET",
          path: "/warehouses/get-all-active",
          handler: getallwarehouseactive,
        },
      ],
    },
    company: {
      enabled: true,
      excludedRoutes: ["create"],
      customRoutes: [
        { method: "POST", path: "/company/create", handler: companyCreate },
        { method: "POST", path: "/companies/create", handler: companyCreate },
      ],
    },
    complain: {
      enabled: true,
      excludedRoutes: ["delete"], // Complain doesn't have delete route
    },
    purchase_order: {
      enabled: true,
      excludedRoutes: [],
    },
    category: {
      enabled: true,
      excludedRoutes: [],
    },
    purchase_order_item: {
      enabled: true,
      excludedRoutes: [],
    },
    purchase_return: {
      enabled: true,
      excludedRoutes: [],
    },
    purchase_return_item: {
      enabled: true,
      excludedRoutes: [],
    },
    sales_return: {
      enabled: true,
      excludedRoutes: [],
    },
    sales_return_item: {
      enabled: true,
      excludedRoutes: [],
    },
    attribute: {
      enabled: true,
      excludedRoutes: [],
    },
    process: {
      enabled: true,
      excludedRoutes: [],
    },
    // Use accountCreate (transaction_number + post-create transactions), not bare handleGenericCreate
    account: {
      enabled: true,
      excludedRoutes: ["create"],
      customRoutes: [
        { method: "POST", path: "/account/create", handler: accountCreate },
        { method: "POST", path: "/accounts/create", handler: accountCreate },
      ],
    },
    brands: {
      enabled: true,
      excludedRoutes: [],
      routeAliases: ["brand"],
    },
    product_relations: {
      enabled: true,
      excludedRoutes: [],
    },
    assets: {
      enabled: true,
      excludedRoutes: ["create", "update"],
    },
  },
});

// Add route aliases for category (plural form for backward compatibility)
// These routes forward requests from /category/* to /category/*
const categoryController =
  require("../utils/dynamicRouteGenerator").generateControllerFunctions(
    "category",
  );
// router.patch("/category/update/:id", categoryController.update);
// router.post("/category/create", categoryController.create);
// router.get("/category/get/:id", categoryController.getById);
// router.get("/category/get-all", categoryController.getAll);
// router.get("/category/get-all-active", categoryController.getAllActive);
// router.delete("/category/delete/:id", categoryController.delete);

/** Unmatched /api/* — JSON 404 + best-effort row in `logs` (never reaches controllers). */
router.use(async (req, res) => {
  const fullPath = req.originalUrl || `${req.baseUrl || ""}${req.path || ""}`;
  const description = [
    "API route not found",
    `method: ${req.method}`,
    `path: ${fullPath}`,
    `query: ${JSON.stringify(req.query || {})}`,
    "hint: use base URL http://localhost:8000/api/... (Node), not Apache/XAMPP HTML 404",
  ].join("\n");

  console.error(`[api] 404 ${req.method} ${fullPath}`);

  await logControllerError(req, description, {
    action: "API ROUTE NOT FOUND",
    tags: ["api", "404", "not_found"],
    fallbackUrl: fullPath,
    fallbackCompanyId: req.user?.company_id,
  });

  return res.status(404).json({
    success: false,
    status: 404,
    error: "Route not found",
    details: `No handler for ${req.method} ${fullPath}`,
    type: "not_found",
  });
});

module.exports = router;

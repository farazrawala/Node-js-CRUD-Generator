# API Reference

Complete catalog of HTTP APIs under `/api` as of this document.  
Related deep-dives: [queue-apis.md](./queue-apis.md), [warehouse-inventory-api-reference.md](./warehouse-inventory-api-reference.md), [process-system.md](./process-system.md), [income-statement-and-profit-calculations.md](./income-statement-and-profit-calculations.md).

---

## Base URL and authentication

| Environment | Base path |
| ----------- | --------- |
| Local | `http://localhost:8000/api` |
| Production (example) | `https://your-domain.com/pos_admin/api` |

Most endpoints require a Bearer token from login:

```http
Authorization: Bearer <token>
```

### Public endpoints (no auth)

| Method | Path | Notes |
| ------ | ---- | ----- |
| `GET` | `/health` | Deploy / runtime check |
| `GET` | `/version` | Version + git commit stamp |
| `POST` | `/user/login` | User login |
| `POST` | `/login/admin` | Admin login |
| `POST` | `/user/user_company` | Signup company + user |
| `GET` | `/blog/get-all` | Public blogs |
| `GET` | `/blog/get-all-active` | Public active blogs |
| `GET` | `/blog/get/:id` | Public blog by id |
| `GET` | `/user/get/:id` | Public user by id |
| `GET` | `/order/public-get-order-by-order-no/:id` | Public order lookup |
| `GET` / `POST` | `/process/execute-process` | Cron-friendly process runner |
| `GET` / `POST` | `/process/execute-process/:id` | Run one process by id |
| `POST` | `/test` | Smoke test |

Uploads under `/api/uploads/*` are also public.

---

## Common conventions

### Dynamic CRUD pattern

For most models, routes are auto-registered as:

| Method | Path | Action |
| ------ | ---- | ------ |
| `POST` | `/{model}/create` | Create |
| `PATCH` | `/{model}/update/:id` | Update |
| `GET` | `/{model}/get/:id` | Get by id |
| `GET` | `/{model}/get-all` | List (non-deleted) |
| `GET` | `/{model}/get-all-active` | List active |
| `DELETE` | `/{model}/delete/:id` | Soft delete |

Plural aliases are also registered (e.g. `/order` and `/orders`). Extra aliases: `brands` → `/brand`.

**Excluded from auto CRUD (custom routes instead or separate routers):** `product`, `order_item`, `url`.

**Per-model overrides:**

| Model | Notes |
| ----- | ----- |
| `company` | Create uses custom `companyCreate` |
| `account` | Create uses custom `accountCreate` |
| `warehouse` | `get-all-active` uses custom handler; also `/warehouses/get-all-active` |
| `complain` | No delete route |
| `assets` | Create/update excluded from dynamic (custom save/update only) |

### List query parameters (dynamic get-all / get-all-active)

| Param | Description |
| ----- | ----------- |
| `limit`, `skip`, `page` | Pagination |
| `search`, `searchFields` | Text |
| `populate` | Populate refs |
| `sort`, `sortBy`, `sortOrder` | Sorting |
| `deleted`, `include_inactive` | Soft-delete / inactive filters |
| `{field}_gt\|gte\|lt\|lte` | Range filters (e.g. `amount_gt=0`) |
| Any other field | Exact / parsed filter on that field |

Tenant scoping: authenticated requests are filtered by `req.user.company_id` where applicable.

### Typical success / error shape

```json
{
  "success": true,
  "status": 200,
  "data": {}
}
```

```json
{
  "success": false,
  "status": 404,
  "error": "Route not found",
  "details": "No handler for GET /api/...",
  "type": "not_found"
}
```

---

## Health & system

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/health` | No | Health payload |
| `GET` | `/version` | No | Version / deploy stamp |
| `POST` | `/test` | No | Test route |

---

## Auth & users

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/user/user_company` | No | Create company + first user |
| `POST` | `/user/login` | No | Login → token |
| `POST` | `/login/admin` | No | Admin login |
| `GET` | `/user/total-customers` | Yes | Count customers |
| `GET` | `/user/total-users` | Yes | Count users |
| `GET` | `/user/default-vendor` | Yes | Get default vendor |
| `PATCH` | `/user/:id/make-default-vendor` | Yes | Set default vendor |
| `PATCH` | `/users/:id/make-default-vendor` | Yes | Alias |

Plus dynamic CRUD: `/user/*`, `/users/*` (create/update/get/list/delete).

---

## Products

Custom product routes (dynamic product CRUD is disabled).

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/product/import-form` | Yes | CSV/TSV import column schema |
| `POST` | `/product/import` | Yes | Import products from file |
| `GET` | `/product/shopify-import-form` | Yes | Shopify import schema |
| `POST` | `/product/shopify-product-import` | Yes | Import Shopify products |
| `GET` | `/product/update-barcode-form` | Yes | Barcode update schema |
| `POST` | `/product/update-barcode` | Yes | Bulk barcode update |
| `POST` | `/product/create` | Yes | Create product |
| `PATCH` | `/product/update/:id` | Yes | Update product |
| `PATCH` | `/product/update-cost/:id` | Yes | Update product cost |
| `GET` | `/product/get/:id` | Yes | Get product |
| `GET` | `/product/get-all` | Yes | List products |
| `GET` | `/product/get-all-active` | Yes | List active products |
| `DELETE` | `/product/delete/:id` | Yes | Soft delete |
| `POST` | `/product/create-product-variation` | Yes | Create variation |
| `PATCH` | `/product/update-product-variation/:id` | Yes | Update variation |
| `GET` | `/product/get-product-variation/:id` | Yes | Get variation |
| `GET` | `/product/get-all-active-pos` | Yes | Active products for POS |
| `PATCH` | `/product/:id/update-default-warehouse` | Yes | Set default warehouse |
| `GET` | `/product/top-selling` | Yes | Top sellers (alias of order analytics) |
| `GET` | `/warehouse/:warehouseId/products` | Yes | Products with stock in warehouse |

---

## Inventory & stock

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/inventory_movements/save` | Yes | Create inventory movement |
| `POST` | `/inventory_movements/stock-transfer` | Yes | Stock transfer between warehouses |
| `GET` | `/inventory_movements/cost-of-goods-available` | Yes | COGA |
| `GET` | `/inventory_movements/stock-by-product` | Yes | Stock by product (query) |
| `GET` | `/inventory_movements/stock-by-product/:product_id` | Yes | Stock by product id |
| `GET` | `/inventory_movements/update_wholesale_price/:type/:order_item_id/:product_id` | Yes | Update wholesale price |
| `GET` | `/stock-transfer` | Yes | List stock transfers |
| `POST` | `/stock-transfer` | Yes | Create stock transfer |
| `POST` | `/stock-movement` | Yes | Create stock movement |
| `PATCH` | `/stock-movement/:id` | Yes | Update |
| `DELETE` | `/stock-movement/:id` | Yes | Delete |
| `GET` | `/stock-movement/:id` | Yes | Get by id |
| `GET` | `/stock-movement` | Yes | List |
| `GET` | `/stock-movement/get-all-active` | Yes | List active |

**Aliases (dynamic-style):**

| Method | Path |
| ------ | ---- |
| `POST` | `/stock_movement/create` |
| `PATCH` | `/stock_movement/update/:id` |
| `DELETE` | `/stock_movement/delete/:id` |
| `GET` | `/stock_movement/get/:id` |
| `GET` | `/stock_movement/get-all` |
| `GET` | `/stock_movement/get-all-active` |

Dynamic CRUD also covers: `inventory_movements`, `stock_transfer`, `stock_movement`, `warehouse_inventory`, `warehouse`.

---

## Alerts

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/alerts/check-product-alert/:product_id/:qty` | Yes | Check product qty alert |
| `GET` | `/alerts/low-stock` | Yes | Low stock alerts |
| `GET` | `/alerts/get-low-stock` | Yes | Alias |

Plus dynamic CRUD: `/alerts/*`.

---

## Orders & sales

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/order/order_save` | Yes | Create order (POS/sale) |
| `PATCH` | `/order/order_update/:id` | Yes | Update order |
| `DELETE` | `/order/order_delete/:id` | Yes | Delete order |
| `GET` | `/order/get-order-by-order-item` | Yes | Order by order item query |
| `GET` | `/order/get-order-by-order-no/:id` | Yes | Order by order number |
| `GET` | `/order/public-get-order-by-order-no/:id` | No | Public order by number |
| `PATCH` | `/order/invoice-update/:id` | Yes | Invoice update |
| `GET` | `/order/profit-by-order-item` | Yes | Profit by order item |
| `GET` | `/order_item/profit-by-order-item` | Yes | Profit (order_item controller) |
| `GET` | `/order_item/cost-of-goods-sold-by-order-item` | Yes | COGS by order item |
| `GET` | `/order/sales` | Yes | Sales report |
| `GET` | `/order/sales-day-wise` | Yes | Day-wise sales |
| `GET` | `/order/sales-last-30-days` | Yes | Last 30 days |
| `GET` | `/orders/sales-last-30-days` | Yes | Alias |
| `GET` | `/order/top-selling-products` | Yes | Top products |
| `GET` | `/orders/top-selling-products` | Yes | Alias |
| `GET` | `/order/peak-sales-hours` | Yes | Peak hours |
| `GET` | `/orders/peak-sales-hours` | Yes | Alias |
| `GET` | `/order/sales-by-category` | Yes | Sales by category |
| `GET` | `/orders/sales-by-category` | Yes | Alias |
| `GET` | `/order/average-order-value` | Yes | AOV |
| `GET` | `/orders/average-order-value` | Yes | Alias |
| `GET` | `/order/daily-orders` | Yes | Daily orders |
| `GET` | `/orders/daily-orders` | Yes | Alias |
| `GET` | `/order/accounts-receivable-summary` | Yes | AR summary |
| `GET` | `/orders/accounts-receivable-summary` | Yes | Alias |
| `GET` | `/order/total-sales-current-month` | Yes | Month total sales |

Dynamic CRUD: `/order/*`, `/orders/*`.  
`order_item` dynamic CRUD is excluded (custom analytics routes only above).

---

## Sales returns

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/sales_return/sales_return_create` | Yes | Create sales return |
| `PATCH` | `/sales_return/sales_return_update/:id` | Yes | Update |
| `DELETE` | `/sales_return/sales_return_delete/:id` | Yes | Delete |
| `GET` | `/sales_return/get-sales-return-by-return-item` | Yes | By return item |
| `GET` | `/sales_return/get-sales-return-by-return-item/:id` | Yes | By return item id |
| `GET` | `/sales_return/get-sales-return-by-return-no/:id` | Yes | By return number |
| `GET` | `/sales_return/profit-by-sales-return-item` | Yes | Profit |
| `GET` | `/sales_return/sales` | Yes | Sales-return sales report |

Dynamic CRUD: `/sales_return/*`, `/sales_return_item/*`.

---

## Purchase orders

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/purchase_order/import-form` | Yes | Import schema |
| `POST` | `/purchase_order/import` | Yes | Import from file |
| `POST` | `/purchase_order/purchase_order_create` | Yes | Create PO |
| `PATCH` | `/purchase_order/purchase_order_update/:id` | Yes | Update |
| `DELETE` | `/purchase_order/purchase_order_delete/:id` | Yes | Delete |
| `GET` | `/purchase_order/get-purchase-order-by-purchase-item` | Yes | By purchase item |
| `GET` | `/purchase_order/get-purchase-order-by-purchase-item/:id` | Yes | By purchase item id |
| `GET` | `/purchase_order/get-purchase-order-by-order-no/:id` | Yes | By order number |
| `GET` | `/purchase_order/purchases` | Yes | Purchases report |
| `GET` | `/purchase_order/purchases-summary` | Yes | Purchases summary |

Dynamic CRUD: `/purchase_order/*`, `/purchase_order_item/*`.

---

## Purchase returns

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/purchase_return/purchase_return_create` | Yes | Create |
| `PATCH` | `/purchase_return/purchase_return_update/:id` | Yes | Update |
| `DELETE` | `/purchase_return/purchase_return_delete/:id` | Yes | Delete |
| `GET` | `/purchase_return/get-purchase-return-by-return-item` | Yes | By return item |
| `GET` | `/purchase_return/get-purchase-return-by-return-item/:id` | Yes | By return item id |
| `GET` | `/purchase_return/get-purchase-return-by-return-no/:id` | Yes | By return number |
| `GET` | `/purchase_return/purchases` | Yes | Purchases report |

Dynamic CRUD: `/purchase_return/*`, `/purchase_return_item/*`.

---

## Expenses

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/expense/save` | Yes | Create expense |
| `PATCH` | `/expense/update/:id` | Yes | Update |
| `GET` | `/expense/summary` | Yes | Expense summary |
| `GET` | `/expense/by-account` | Yes | Expense by account |

Dynamic CRUD: `/expense/*`.

---

## Accounts, ledger & finance

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/account/create` | Yes | Create account (+ opening GL) |
| `POST` | `/accounts/create` | Yes | Alias |
| `POST` | `/account/custom-create` | Yes | Custom create (same handler family) |
| `PATCH` | `/account/custom-update/:id` | Yes | Custom update |
| `GET` | `/account/fetch-account-by-type` | Yes | Accounts by type |
| `GET` | `/account/balance-sheet` | Yes | Balance sheet |
| `GET` | `/account/balance-sheet-difference` | Yes | Balance sheet difference |
| `GET` | `/account/profit-vs-gl-gap-breakdown` | Yes | Profit vs GL gap |
| `GET` | `/account/default-discount-sums` | Yes | Default discount sums |
| `GET` | `/ledger/receivables-summary` | Yes | Receivables summary |
| `GET` | `/ledger/receivables-aging` | Yes | Receivables aging |
| `POST` | `/payment_receipt/save` | Yes | Create payment receipt |
| `PATCH` | `/payment_receipt/update_receipt/:id` | Yes | Update receipt |
| `POST` | `/transaction/bulk-create` | Yes | Bulk create transactions |
| `POST` | `/transactions/bulk-create` | Yes | Alias |
| `GET` | `/transaction/list-with-summary` | Yes | List + debit/credit summary |
| `GET` | `/transactions/list-with-summary` | Yes | Alias |
| `GET` | `/transaction/get-my-ledger-transaction` | Yes | My ledger transactions |
| `POST` | `/amount_transfer/save` | Yes | Amount transfer create |
| `PATCH` | `/amount_transfer/update_record/:id` | Yes | Amount transfer update |
| `POST` | `/adjustment/save` | Yes | Adjustment create |
| `PATCH` | `/adjustment/update_record/:id` | Yes | Adjustment update |
| `POST` | `/assets/save` | Yes | Assets create |
| `PATCH` | `/assets/update/:id` | Yes | Assets update |

Dynamic CRUD: `/account/*`, `/transaction/*`, `/payment_receipt/*`, `/amount_transfer/*`, `/adjustment/*`, `/assets/*` (create/update excluded for assets — use custom paths).

---

## Reports

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/reports/income-statement` | Yes | Income statement |
| `GET` | `/reports/income-statement-detail` | Yes | Income statement detail |
| `GET` | `/reports/expense-vs-revenue` | Yes | Expense vs revenue |

See [income-statement-and-profit-calculations.md](./income-statement-and-profit-calculations.md).

---

## Company, cache & queues

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/company/get-my-branches` | Yes | Current user’s branches |
| `GET` | `/company/list-cache` | Yes | List Redis/cache keys |
| `GET` / `DELETE` / `POST` | `/company/remove-cache` | Yes | Clear cache |
| `GET` | `/company/queue` | Yes | List all module queues |
| `GET` | `/company/queue/:module` | Yes | Queue status for module |
| `POST` | `/company/queue/:module/enqueue` | Yes | Enqueue job |
| `DELETE` | `/company/queue/:module` | Yes | Clear module queue |
| `POST` | `/company/create` | Yes | Create company |
| `POST` | `/companies/create` | Yes | Alias |

Dynamic CRUD: `/company/*`, `/companies/*` (create overridden as above).

Full queue docs: [queue-apis.md](./queue-apis.md).

---

## Integrations (WooCommerce / Shopify sync)

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/integration/check-active/:id` | Yes | Check integration active |
| `GET` | `/integration/sync-store-category/:id` | Yes | Sync categories |
| `GET` / `POST` | `/integration/sync-store-product/:id` | Yes | Sync / fetch products |
| `GET` / `POST` | `/integration/sync-store-product/:id/queue` | Yes | Queue product fetch |
| `GET` | `/integration/find-product-relations/:id` | Yes | Sync product relations |
| `GET` | `/integration/store-product-variations/:id/:remoteProductId` | Yes | List remote variations |

Dynamic CRUD: `/integration/*`.  
Related: [woocommerce_to_local_product_sync.md](./woocommerce_to_local_product_sync.md), [shopify_to_local_product_sync.md](./shopify_to_local_product_sync.md), [sync_product_to_shopify.md](./sync_product_to_shopify.md).

---

## Process / background jobs

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/process/queue-form` | Yes | Queue create form schema |
| `POST` | `/process/queue-create` | Yes | Create process + enqueue |
| `POST` / `GET` | `/process/queue-enqueue-all` | Yes | Enqueue all pending |
| `POST` / `GET` | `/process/fetch-product-queue` | Yes | Fetch-product queue helper |
| `POST` | `/process/bulk-create` | Yes | Bulk create processes |
| `POST` | `/processs/bulk-create` | Yes | Typo alias |
| `GET` / `POST` | `/process/execute-process` | No | Execute next / batch |
| `GET` / `POST` | `/process/execute-process/:id` | No | Execute one process |
| `POST` / `GET` | `/process/run-queue-worker` | Yes | Drain queue worker |
| `POST` / `GET` | `/process/run-queue-worker/:id` | Yes | Drain for company/id |
| `GET` | `/process/queue-worker-status` | Yes | Worker status |

Dynamic CRUD: `/process/*`.  
See [queue-apis.md](./queue-apis.md) and [process-system.md](./process-system.md).

---

## Dynamic CRUD models (standard endpoints)

These models get the standard create / update / get / get-all / get-all-active / delete routes (singular + plural), unless noted above:

| Model | Path prefix(es) |
| ----- | --------------- |
| `account` | `/account`, `/accounts` |
| `adjustment` | `/adjustment`, `/adjustments` |
| `alerts` | `/alerts` |
| `amount_transfer` | `/amount_transfer`, `/amount_transfers` |
| `assets` | `/assets` (no dynamic create/update) |
| `attribute` | `/attribute`, `/attributes` |
| `blog` | `/blog`, `/blogs` |
| `branch` | `/branch`, `/branches` |
| `brands` | `/brands`, `/brand` |
| `category` | `/category`, `/categories` |
| `company` | `/company`, `/companies` |
| `complain` | `/complain`, `/complains` (no delete) |
| `expense` | `/expense`, `/expenses` |
| `integration` | `/integration`, `/integrations` |
| `inventory_movements` | `/inventory_movements` |
| `logs` | `/log`, `/logs` |
| `order` | `/order`, `/orders` |
| `payment_receipt` | `/payment_receipt`, `/payment_receipts` |
| `printer` | `/printer`, `/printers` |
| `process` | `/process`, `/processes` |
| `product_relations` | `/product_relation`, `/product_relations` |
| `purchase_order` | `/purchase_order`, `/purchase_orders` |
| `purchase_order_item` | `/purchase_order_item`, `/purchase_order_items` |
| `purchase_return` | `/purchase_return`, `/purchase_returns` |
| `purchase_return_item` | `/purchase_return_item`, `/purchase_return_items` |
| `sales_return` | `/sales_return`, `/sales_returns` |
| `sales_return_item` | `/sales_return_item`, `/sales_return_items` |
| `stock_movement` | `/stock_movement`, `/stock_movements` |
| `stock_transfer` | `/stock_transfer`, `/stock_transfers` |
| `sync_brand` | `/sync_brand`, `/sync_brands` |
| `sync_category` | `/sync_category`, `/sync_categories` |
| `sync_product` | `/sync_product`, `/sync_products` |
| `transaction` | `/transaction`, `/transactions` |
| `user` | `/user`, `/users` |
| `warehouse` | `/warehouse`, `/warehouses` |
| `warehouse_inventory` | `/warehouse_inventory`, `/warehouse_inventories` |

**Not auto-registered:** `product`, `order_item`, `url`.

---

## Debug logs

Mounted at `/api/debug` (and `/admin/debug`). Protected by debug log key (`?key=` or `x-debug-log-key`).

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET` | `/api/debug/logs/page` | HTML log viewer page |
| `GET` | `/api/debug/logs` | JSON logs |
| `GET` | `/api/debug/logs/download` | Download logs |

---

## Non-`/api` routes (brief)

| Mount | Purpose |
| ----- | ------- |
| `/user` | Legacy signup/login/update (`routes/user.js`) |
| `/url` | URL shortener CRUD (NORMAL role) |
| `/admin` | Admin UI + admin CRUD generator |
| `/` | Static pages (login, signup, health aliases) |

---

## Source of truth

Custom and dynamic routes are registered in [`routes/api.js`](../routes/api.js) via `registerAllModelRoutes`.  
Auth allowlist: [`middlewares/auth.js`](../middlewares/auth.js).

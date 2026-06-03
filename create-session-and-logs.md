# Create Session and Logs — Route Audit

**Project:** Node.js + Express + Mongoose multi-tenant POS  
**Audit date:** 2026-06-01  
**Mode:** Read-only audit (reference for hardening work)

---

## Purpose

Many business flows write to **more than one collection** in a single HTTP request (order + line items + GL + inventory, company signup + accounts, product parent + variations, etc.). Without a **MongoDB session / transaction** and **failure logging + rollback**, a mid-flight error can leave **partial data** that is hard to fix manually.

This document lists:

1. Routes that **already** use session + structured failure logging (`logRollbackFailure` or compensating rollback).
2. Routes that perform **multiple CRUD operations** but **do not** use that pattern.
3. **Duplicate** dynamic vs custom routes where the weaker path bypasses transactions.

**“Session and logs” pattern** in this codebase usually means:

| Piece        | Typical implementation                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Session**  | `mongoose.startSession()` + `session.withTransaction()`, or `withTxnFallback()` in `utils/dynamicRouteGenerator.js`             |
| **Logs**     | `logRollbackFailure()` / `logControllerError()` in `utils/logControllerError.js` → `logs` collection via `createApplicationLog` |
| **Rollback** | Transaction abort on replica set, or compensating soft-delete / deleteMany + retry (adjustment, assets, amount_transfer)        |

Single-document `handleGenericCreate` / `handleGenericUpdate` with no side effects is **out of scope** unless noted.

---

## Routes that already use session + rollback logging

| Area               | Routes                                                                                                  | Pattern                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Order              | `POST /api/order/order_save`, `PATCH /api/order/order_update/:id`                                       | `withTransaction` + `logRollbackFailure` (`controllers/order.js`)   |
| Purchase order     | `POST /api/purchase_order/purchase_order_create`, `PATCH /api/purchase_order/purchase_order_update/:id` | Same (`controllers/purchase_order.js`)                              |
| Expense            | `POST /api/expense/save`, `PATCH /api/expense/update/:id`                                               | `withTransaction` + `logRollbackFailure`                            |
| Adjustment         | `POST /api/adjustment/save`, `PATCH /api/adjustment/update_record/:id`                                  | Txn + `logRollbackFailure` + compensating rollback                  |
| Amount transfer    | `POST /api/amount_transfer/save`, `PATCH /api/amount_transfer/update_record/:id`                        | Same                                                                |
| Assets             | `POST /api/assets/save`, `PATCH /api/assets/update/:id`                                                 | Same                                                                |
| Payment receipt    | `POST /api/payment_receipt/save`, `PATCH /api/payment_receipt/update_receipt/:id`                       | Same                                                                |
| Inventory movement | `POST /api/inventory_movements/save`                                                                    | `withTransaction` (`controllers/inventory_movements.js`)            |
| Stock transfer     | `POST /api/inventory_movements/stock-transfer`, `POST /api/stock-transfer`, stock movement CRUD         | `withTransaction` (non-txn fallback on standalone Mongo)            |
| User (dynamic)     | `POST /api/user/create`, `PATCH /api/user/update/:id`                                                   | `withTxnFallback` + GL hooks pass `session` (`controllers/user.js`) |

---

## Routes with multiple CRUDs — missing session / rollback list

### High impact (many writes; partial failure likely)

| Method | Route                                       | What it does                                                                                                                                                                                  | Failure handling today                         |
| ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/api/user/user_company`                    | Company → warehouse → admin user → default user → many `account` creates → company default-account patch. **Explicitly not wrapped in a transaction** (see comment in `controllers/user.js`). | Generic `catch` only                           |
| POST   | `/api/product/create-product-variation`     | Parent `product` create + N variation creates in a loop                                                                                                                                       | Console; parent may exist without all variants |
| PATCH  | `/api/product/update-product-variation/:id` | Parent update + per-variation create/update loop                                                                                                                                              | Console                                        |
| GET    | `/api/integration/sync-store-category/:id`  | Loop: find / restore / create many `category` rows                                                                                                                                            | Per-item result object only                    |
| GET    | `/api/integration/sync-store-product/:id`   | Categories + products + variants + image updates                                                                                                                                              | Per-item results only                          |
| POST   | `/api/transaction/bulk-create`              | N × `handleGenericCreate` for `transaction` (no session on HTTP handler)                                                                                                                      | 207 / `errors` array                           |
| POST   | `/api/transactions/bulk-create`             | Alias of bulk-create                                                                                                                                                                          | Same                                           |

### Medium impact (2+ writes; no atomicity)

| Method | Route                           | What it does                                                                                    | Failure handling today                                     |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| POST   | `/api/account/custom-create`    | `account` create + 2 GL lines via `transactionBulkCreate` (no session)                          | `logControllerError` if GL fails; account row may remain   |
| PATCH  | `/api/account/custom-update`    | `account` update + `Transaction.deleteMany` + recreate GL                                       | `logControllerError` only; no rollback                     |
| PATCH  | `/api/product/update/:id`       | `product` update + `Logs.insertMany` (stock audit)                                              | Log insert failure swallowed in `createWarehouseStockLogs` |
| POST   | `/api/company/create` (dynamic) | `company` create + `user.findByIdAndUpdate` in `afterCreate` (`utils/dynamicRouteGenerator.js`) | No txn wrapper (only `user` uses `withTxnFallback`)        |
| GET    | `/api/process/execute-process`  | Picks `process` row; store handlers may write many rows                                         | No `logRollbackFailure`                                    |

### Duplicate routes — custom path has txn; dynamic path does not

Clients using the **dynamic** URL get single-document CRUD **without** the transactional pipeline:

| Dynamic (no txn)                       | Custom (has txn)                                      |
| -------------------------------------- | ----------------------------------------------------- |
| `POST /api/purchase_order/create`      | `POST /api/purchase_order/purchase_order_create`      |
| `PATCH /api/purchase_order/update/:id` | `PATCH /api/purchase_order/purchase_order_update/:id` |
| `POST /api/order/create`               | `POST /api/order/order_save`                          |
| `PATCH /api/order/update/:id`          | `PATCH /api/order/order_update/:id`                   |

**Recommendation:** Exclude `order` and `purchase_order` from dynamic create/update in `routes/api.js` `registerAllModelRoutes`, or make dynamic handlers delegate to the custom controllers.

---

## Lower risk (not prioritized for session wrap)

| Method | Route                                         | Notes                                          |
| ------ | --------------------------------------------- | ---------------------------------------------- |
| GET    | `/api/integration/find-product-relations/:id` | Single find — not multi-CRUD                   |
| GET    | `/api/integration/check-active/:id`           | Mostly read                                    |
| PATCH  | `/api/order/invoice-update/:id`               | Single `order` update                          |
| PATCH  | `/api/product/update-cost/:id`                | Mostly read/aggregate; optional product update |

---

## Dynamic CRUD (all models)

`registerAllModelRoutes` in `routes/api.js` registers `POST /{model}/create`, `PATCH /{model}/update/:id`, etc. for every model in `models/`.

- **Only `user`** uses `withTxnFallback` on create/update in `utils/dynamicRouteGenerator.js`.
- **`logs`** and **`user`** bypass list-cache in `utils/redisCache.js` (`LIST_CACHE_BYPASS_MODULES`).
- Other models: typically **one primary document** per request unless schema hooks or `afterCreate` add writes (e.g. `company` → link `user.company_id`).

---

## Reference — key files

| File                             | Role                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `utils/logControllerError.js`    | `logControllerError`, `logRollbackFailure`, `buildControllerErrorDescription` |
| `utils/applicationLogs.js`       | `createApplicationLog`, `logListAccess` (API vs Cache tags)                   |
| `utils/dynamicRouteGenerator.js` | `withTxnFallback`, `generateControllerFunctions`, `applyUserRoleQueryFilter`  |
| `controllers/order.js`           | `order_save`, `order_update` — reference implementation                       |
| `controllers/purchase_order.js`  | `purchaseOrderCreate`, `purchase_order_update`                                |
| `controllers/user.js`            | `handleUserSignupCompany` (multi-write, no txn)                               |
| `controllers/product.js`         | Variation create/update, `createWarehouseStockLogs`                           |
| `controllers/account.js`         | `accountCreate`, `accountUpdate` + bulk GL                                    |
| `controllers/transaction.js`     | `createTransactionsFromItems`, `transactionBulkCreate`                        |
| `controllers/integration.js`     | `syncStoreCategory`, `syncStoreProduct`                                       |
| `routes/api.js`                  | Route registration and exclusions                                             |

---

## Suggested hardening order (P0 → P2)

| Priority | Target                                                                  | Why                                                     |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| P0       | `POST /api/user/user_company`                                           | Largest blast radius; orphan tenants                    |
| P0       | Disable or delegate duplicate `order` / `purchase_order` dynamic routes | Clients may hit non-transactional path                  |
| P1       | Product variation create/update                                         | Orphan parent/child products                            |
| P1       | Integration sync endpoints                                              | Many rows per GET                                       |
| P1       | `POST /api/transaction/bulk-create`                                     | Optional `session` + `stopOnError` already partial      |
| P2       | Account custom create/update                                            | GL drift; has some `logControllerError`                 |
| P2       | `POST /api/company/create` + link user                                  | Two writes; include in company txn if signup refactored |

---

## Audit criteria (for re-runs)

A route is listed under **missing** when:

1. **Multiple CRUDs** — two or more of: create, update, delete, `insertMany`, `deleteMany`, or looped `handleGenericCreate` / `handleGenericUpdate`.
2. **No** `withTransaction` / `withTxnFallback` / session passed through hooks for the full flow.
3. **No** `logRollbackFailure` or documented compensating rollback on failure.

`logControllerError` or `createApplicationLog` alone does **not** qualify as full “session and logs” rollback coverage.

---

## Summary counts

| Category                                 | Count              |
| ---------------------------------------- | ------------------ |
| Routes with session + rollback pattern   | 10+ handler groups |
| High-impact gaps                         | 7 route entries    |
| Medium-impact gaps                       | 5 route entries    |
| Duplicate dynamic vs transactional pairs | 4 pairs            |

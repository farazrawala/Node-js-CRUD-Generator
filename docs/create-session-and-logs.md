# Create Session and Logs — Route Audit

**Project:** Node.js + Express + Mongoose multi-tenant POS  
**Audit date:** 2026-06-01  
**Last reviewed:** 2026-06-01 (full re-audit vs codebase)  
**Status:** Living reference — update when routes gain or lose txn / rollback / failure logs

---

## Purpose

Many business flows write to **more than one collection** in a single HTTP request (order + line items + GL + inventory, company signup + accounts, product parent + variations, etc.). Without a **MongoDB session / transaction** and **failure logging + rollback**, a mid-flight error can leave **partial data** that is hard to fix manually.

This document lists:

1. Routes that **already** use session + structured failure logging (`logRollbackFailure` or compensating rollback).
2. Routes that perform **multiple CRUD operations** but **do not** use that pattern.
3. **Duplicate** dynamic vs custom routes where the weaker path bypasses transactions.
4. **Cross-cutting** failure logging on generic CRUD helpers.

**“Session and logs” pattern** in this codebase:

| Piece | Typical implementation |
| ----- | ---------------------- |
| **Session** | `mongoose.startSession()` + `session.withTransaction()`, or `withTxnFallback()` in `utils/dynamicRouteGenerator.js` |
| **Rollback logs** | `logRollbackFailure()` in `utils/logControllerError.js` → `logs` collection |
| **Other errors** | `logControllerError()`, `logGenericCrudFailure()` (validation / generic CRUD only) |
| **Rollback** | Transaction abort on replica set, or compensating soft-delete + snapshot restore |

Single-document dynamic CRUD with no side effects is **out of scope** for the gap tables below. Failed **`handleGenericCreate` / `handleGenericUpdate`** still write **`GENERIC CREATE/UPDATE FAILED`** rows (see [Generic CRUD failure logs](#generic-crud-failure-logs)).

---

## Routes with session + rollback logging (current)

| Area | HTTP routes | Controller / notes |
| ---- | ----------- | ------------------- |
| Order | `POST /api/order/order_save`, `PATCH /api/order/order_update/:id` | `controllers/order.js` |
| Purchase order | `POST /api/purchase_order/purchase_order_create`, `PATCH /api/purchase_order/purchase_order_update/:id` | `controllers/purchase_order.js` |
| Expense | `POST /api/expense/save`, `PATCH /api/expense/update/:id` | `controllers/expense.js` |
| Adjustment | `POST /api/adjustment/save`, `PATCH /api/adjustment/update_record/:id` | `controllers/adjustment.js` |
| Amount transfer | `POST /api/amount_transfer/save`, `PATCH /api/amount_transfer/update_record/:id` | `controllers/amount_transfer.js` |
| Assets | `POST /api/assets/save`, `PATCH /api/assets/update/:id` | `controllers/assets.js` (dynamic create/update excluded; custom save/update routes) |
| Payment receipt | `POST /api/payment_receipt/save`, `PATCH /api/payment_receipt/update_receipt/:id` | `controllers/payment_receipt.js` |
| User signup | `POST /api/user/user_company` | `handleUserSignupCompany` — `controllers/user.js` |
| User (dynamic) | `POST /api/user/create`, `PATCH /api/user/update/:id` | `withTxnFallback` + opening GL in `dynamicRouteGenerator.js` |
| Company | `POST /api/company/create`, `POST /api/companies/create` | `companyCreate` — `controllers/company.js` (dynamic create **excluded**) |
| Account | `POST /api/account/custom-create`, `PATCH /api/account/custom-update/:id` | Also `POST /api/account/create`, `/api/accounts/create` — `controllers/account.js` |
| Product | `PATCH /api/product/update/:id` | Custom route (`product` model excluded from dynamic registry) — `controllers/product.js` |
| Product variations | `POST /api/product/create-product-variation`, `PATCH /api/product/update-product-variation/:id` | `controllers/product.js` |
| Transaction bulk | `POST /api/transaction/bulk-create`, `POST /api/transactions/bulk-create` | **Atomic by default** (`atomic: true`); `atomic: false` → legacy partial **207** — `controllers/transaction.js` |

**Txn without `logRollbackFailure` (weaker):**

| Area | Routes | Notes |
| ---- | ------ | ----- |
| Inventory movement | `POST /api/inventory_movements/save`, stock transfer routes | `withTransaction` in `inventory_movements.js` / `stock_movement.js`; errors mostly `console` / generic catch |

**Internal (not HTTP):** `createTransactionsFromItems` accepts `{ session, stopOnError: true }` — used from order, PO, amount transfer, account flows, etc.

---

## Hardening changelog (2026-06 session)

| Route(s) | What was added |
| -------- | -------------- |
| `user_company`, product variations, transaction bulk-create | Txn + compensating rollback + `logRollbackFailure` |
| `account/custom-create`, `account/custom-update` | Txn + opening GL + snapshot rollback + `logRollbackFailure` |
| `product/update/:id` | Txn + stock audit `Logs.insertMany` in session + snapshot rollback + `logRollbackFailure` |
| `company/create` | Custom handler (replaces non-txn dynamic create) + link user + rollback + `logRollbackFailure` |
| All generic create/update | `logGenericCrudFailure` on `success: false` (`utils/modelHelper.js`) |

---

## Generic CRUD failure logs

**Not** a substitute for multi-write rollback.

| Trigger | Action tag | Tags (examples) |
| ------- | ---------- | ---------------- |
| `handleGenericCreate` → `success: false` | `GENERIC CREATE FAILED` | `api`, `error`, `generic_create`, `{model}` |
| `handleGenericUpdate` → `success: false` | `GENERIC UPDATE FAILED` | `api`, `error`, `generic_update`, `{model}` |

Includes `error`, `message`, `details`, `missing`, redacted body sample, `in_transaction` when `options.session` is set.

**Opt-out:** `options.skipFailureLog: true` or `req._skipGenericCrudFailureLog = true`.

---

## Still missing full session / rollback

### High impact

| Method | Route | What it does | Failure handling today |
| ------ | ----- | ------------ | ---------------------- |
| GET | `/api/integration/sync-store-category/:id` | Loop: find / restore / create many `category` rows | Per-item results only |
| GET | `/api/integration/sync-store-product/:id` | Categories + products + variants + images | Per-item results only |

### Medium / variable impact

| Method | Route | What it does | Failure handling today |
| ------ | ----- | ------------ | ---------------------- |
| GET | `/api/process/execute-process` | Runs store `process` handler; may write many rows | No `logRollbackFailure` |

### Duplicate routes — dynamic path has no txn (P0)

Clients using the **left** URL get generic CRUD **without** the transactional custom pipeline:

| Dynamic (no multi-write txn) | Custom (has txn) |
| ---------------------------- | ---------------- |
| `POST /api/purchase_order/create` | `POST /api/purchase_order/purchase_order_create` |
| `PATCH /api/purchase_order/update/:id` | `PATCH /api/purchase_order/purchase_order_update/:id` |
| `POST /api/order/create` | `POST /api/order/order_save` |
| `PATCH /api/order/update/:id` | `PATCH /api/order/order_update/:id` |

**Recommendation:** Add `create` and `update` to `excludedRoutes` for `order` and `purchase_order` in `routes/api.js` `modelConfigs`, or delegate dynamic handlers to custom controllers.

---

## Lower risk (not prioritized)

| Method | Route | Notes |
| ------ | ----- | ----- |
| GET | `/api/integration/find-product-relations/:id` | Mostly read |
| GET | `/api/integration/check-active/:id` | Mostly read |
| PATCH | `/api/order/invoice-update/:id` | Single `order` update |
| PATCH | `/api/product/update-cost/:id` | Read/aggregate focused |
| POST | `/api/product/create` | Single create via `productCreate` (no multi-write side effects in handler) |

---

## Route registration map (`routes/api.js`)

| Model / area | Dynamic CRUD | Custom / notes |
| ------------ | ------------- | -------------- |
| `product` | **Excluded** (`excludedModels`) | All product routes in `api.js` (update, variations, etc.) |
| `company` | Create **excluded** | `POST /company/create`, `/companies/create` → `companyCreate` |
| `account` | Create **excluded** | `POST /account/create`, `/accounts/create` → `accountCreate` |
| `assets` | Create + update **excluded** | `POST /assets/save`, `PATCH /assets/update/:id` |
| `user` | Full dynamic + `user_company` | Dynamic create uses `withTxnFallback` + GL |
| `order`, `purchase_order` | **Still registered** (create + update) | Custom txn routes also registered — **duplicate risk** |
| `logs`, `user` | List cache bypass | `LIST_CACHE_BYPASS_MODULES` in `redisCache.js` |

Legacy dynamic `company` `afterCreate` (link user) in `dynamicRouteGenerator.js` is **not** used for `POST /company/create` once custom route is registered.

---

## Reference — key files

| File | Role |
| ---- | ---- |
| `utils/logControllerError.js` | `logRollbackFailure`, `logGenericCrudFailure`, `serializeErrorForLog` |
| `utils/mongoTransactionSupport.js` | `isMongoTransactionUnsupportedError` |
| `utils/applicationLogs.js` | `logListAccess`, API vs Cache tags |
| `utils/dynamicRouteGenerator.js` | `withTxnFallback`, dynamic CRUD; company link only if dynamic create used |
| `utils/modelHelper.js` | `handleGenericCreate` / `handleGenericUpdate` + failure log wrappers |
| `controllers/order.js` | Reference multi-write + rollback |
| `controllers/purchase_order.js` | PO create/update txn |
| `controllers/user.js` | `user_company`, user GL helpers |
| `controllers/company.js` | `companyCreate` |
| `controllers/account.js` | `accountCreate`, `accountUpdate`, `performAccountCreate` |
| `controllers/product.js` | `productUpdate`, variations, stock audit logs |
| `controllers/transaction.js` | `transactionBulkCreate`, `createTransactionsFromItems` |
| `controllers/integration.js` | Sync GET handlers |
| `routes/api.js` | Custom routes + `registerAllModelRoutes` |

---

## Suggested hardening order (remaining)

| Priority | Target | Why |
| -------- | ------ | --- |
| **P0** | Exclude or delegate `order` / `purchase_order` dynamic create & update | Clients can still hit non-txn URLs |
| **P1** | `sync-store-category`, `sync-store-product` | Many writes per GET; no atomicity |
| **P2** | `execute-process` | Handler-dependent multi-writes |
| **P3** | Inventory movement save | Has txn; add `logRollbackFailure` + compensating pattern for parity |

---

## Audit criteria (re-runs)

List under **still missing** when:

1. **Multiple CRUDs** in one HTTP request (create/update/delete loops, GL, etc.).
2. **No** session for the **full** flow.
3. **No** `logRollbackFailure` or documented compensating rollback.

`logGenericCrudFailure` / `logControllerError` alone = diagnosis only, not rollback coverage.

---

## Summary counts

| Category | Count |
| -------- | ----- |
| HTTP handler groups with txn + `logRollbackFailure` (or compensating rollback) | **15** |
| Handler groups with txn only (no rollback log) | **2** (inventory / stock movement) |
| High-impact gaps | **2** (integration sync GETs) |
| Medium gaps | **1** (`execute-process`) |
| Duplicate dynamic vs transactional pairs | **4** |
| Generic CRUD failure logs | **All models** using `modelHelper` wrappers |

# Billion-Record Readiness Audit

**Project:** Node.js + Express + Mongoose multi-tenant POS  
**Tenant key:** `company_id`  
**Target shard key:** `{ company_id: 1, _id: 1 }`  
**Audit date:** 2026-06-01  
**Mode:** Read-only — no code changes

---

## 1. Executive Summary

This audit reviews the full repository for scalability and sharded-MongoDB readiness at **100M**, **1B**, and **10B** document scales (cluster-wide and per-tenant).

### Verdict by scale (realistic, with current architecture)

| Scale | Verdict | Summary |
|-------|---------|---------|
| **~100M** (well-sharded, bounded tenants) | **Achievable with fixes** | Shard keys on 18 hot collections, multi-doc transactions on POS flows, reporting `$push` removed on three endpoints. Remaining risks: admin cross-tenant queries, ledger-from-history inventory, offset pagination, regex search. |
| **~1B** | **Not ready** | Inventory and GL paths still scan movement/transaction history; correlated `$lookup` on reports; admin scatter queries; no materialized balances or OLAP layer. |
| **~10B** | **Not ready** | Requires dedicated analytics store, event streaming, pre-aggregated facts, and strict elimination of per-request full-ledger math. |

### Overall readiness score

```text
Current readiness: 5 / 10
```

(For **tenant-scoped OLTP at 100M** with sharding deployed and P0 fixes: **~6.5 / 10**.)

### Recent improvements (since first aggregation audit)

- `findSales`, `findProfitByOrderItem`, `costOfGoodsSoldByOrderItem`: removed unbounded `$push`; default **365-day** `createdAt` windows when dates omitted.
- **18** high-volume models declare `shardKey: { company_id: 1, _id: 1 }`.
- Order numbering uses per-tenant `findOne` + counter (not full-collection `$max` scan).

### Top systemic risks

1. **Inventory derived from full `inventory_movements` ledger** (aggregate in − out) on hot paths — linear in movement history.
2. **Order save: per-line ledger aggregation + movement write** — does not scale to large carts × huge catalogs.
3. **Admin UI / forms: queries without `company_id`** — cross-tenant scatter-gather and data-leak class bugs on sharded clusters.
4. **Offset pagination (`skip`)** on all list APIs — degrades past ~10k–100k offset.
5. **Generic regex search** in `handleGenericGetAll` — non-indexable scans at scale.
6. **GL bulk create: sequential `handleGenericCreate` per row** (up to 500) — write amplification.

---

## 2. Critical Findings (P0)

Ranked by outage / security / hard MongoDB failure at scale.

### P0-1 — Admin dashboard: global counts and recent activity (no tenant filter)

| | |
|---|---|
| **File** | `routes/admin.js` ~3300–3320 |
| **Pattern** | `User.countDocuments()`, `Product.countDocuments()`, `Order.countDocuments()`, etc. without `company_id`; `Order.find().sort({ createdAt: -1 }).limit(5)` |
| **Risk** | **Sharding:** scatter-gather across all shards. **Security:** exposes cross-tenant data on multi-tenant admin. **Scale:** each count is a collection scan or index scan on entire cluster. |
| **Failure mode** | Timeouts, wrong dashboard numbers, potential data leak to tenant admins if route is not super-admin only. |

---

### P0-2 — Admin product form: cross-tenant `Product.aggregate` and reference data

| | |
|---|---|
| **File** | `routes/admin.js` ~1734–1755 |
| **Pattern** | `$match: { deletedAt: null, parent_product_id: … }` — **no `company_id`** |
| **Also** | `Category.find({ status: "active", deletedAt: null })`, `Brands.find({ deletedAt: null })` without tenant (~1705, 1722) |
| **Failure mode** | Full-cluster scan; dropdowns show other tenants’ products/categories/brands. |

---

### P0-3 — Order save: per-line full ledger aggregation

| | |
|---|---|
| **File** | `controllers/order.js` — `resolveWarehouseForOutboundLine` (~297), `order_save` loop (~1106) |
| **Pattern** | For **each** cart line: `aggregateNetQtyByWarehouse(productId, companyId)` then `runInventoryMovementTxnBody` (additional aggregation on movements) |
| **Why it breaks** | O(lines × movement history) per order. Tenant with 500M movements and 20-line cart → 20 full ledger aggregations per checkout. |
| **Failure mode** | POS timeout, transaction abort, MongoDB CPU saturation. **At 1B movements: unusable.** |

---

### P0-4 — Inventory on-hand = replay entire movement ledger

| | |
|---|---|
| **Files** | `controllers/inventory_movements.js` — `aggregateNetQtyByWarehouse`, `getLedgerNetQtyForWarehouse`, `cost_of_goods_available` (~224), product warehouse breakdown (~872) |
| **Pattern** | `$match` tenant + product (optional) → `$group` sum in/out — **no materialized `warehouse_inventory` balance** (model commented out; `product.js` still aggregates `warehouse_inventories` in places) |
| **Failure mode** | Any stock check or COGS report scans proportional to **all historical movements** for SKU/tenant. |

---

### P0-5 — Transaction list summary: full-tenant GL scan (no default date window)

| | |
|---|---|
| **File** | `controllers/transaction.js` ~267 — `getTransactionsListWithDebitCreditSummary` |
| **Pattern** | `Transaction.aggregate([{ $match: filter }, { $group: … }])` where `filter` has `company_id` but **no required `createdAt` range** |
| **Failure mode** | At 100M+ GL lines per tenant, every list+summary request scans entire journal. Timeout / 16MB not an issue (scalar group) but **latency and IXSCAN volume**. |

---

### P0-6 — Bulk GL posting: N sequential creates

| | |
|---|---|
| **File** | `controllers/transaction.js` — `createTransactionsFromItems` (~59–104) |
| **Pattern** | `for` loop → `handleGenericCreate(req, "transaction")` per row (max 500) |
| **Failure mode** | 500 round-trips per journal batch; slow under concurrency; amplifies index write load. **Not OOM**, but **write throughput ceiling**. |

---

### P0-7 — Generic list search: regex across string fields

| | |
|---|---|
| **File** | `utils/modelHelper.js` — `mergeSearchIntoFilter` (~2411), used by `handleGenericGetAll` |
| **Pattern** | `{ field: { $regex: escaped, $options: "i" } }` on default string schema fields |
| **Failure mode** | COLLSCAN or inefficient index use on large collections; unusable for “search box” on orders/products at 100M+. |

---

## 3. Warning Findings (P1)

### Aggregations

| File | Function | Issue | Risk |
|------|----------|-------|------|
| `controllers/order.js` | `findProfitByOrderItem` | Correlated `$lookup` → `inventory_movements` per line | CPU / latency at high line volume |
| `controllers/order_item.js` | `costOfGoodsSoldByOrderItem` | Same `$lookup` pattern | Same |
| `controllers/inventory_movements.js` | `cost_of_goods_available` | `$group` by `product_id` over movements; optional product filter only | Medium memory; full ledger scan |
| `controllers/transaction.js` | `getTransactionsListWithDebitCreditSummary` | `.skip(skip)` on `find()` after full agg | Deep pagination |
| `utils/modelHelper.js` | `handleGenericGetAll` + `group` | Optional `$skip` on aggregation; caller-defined `$group` | Latent unbounded `$push` if misused |
| `routes/admin.js` | parent products agg | `$sort` on `product_name` post-match | OK at dropdown scale if tenant-scoped |

**No remaining unbounded `$push` in aggregations** (verified). `controllers/url.js` uses `$push` on `findOneAndUpdate` (visit history) — document growth per URL, not agg.

**No `$graphLookup` found.**

### Queries & pagination

| Pattern | Locations | Class |
|---------|-----------|-------|
| `skip: req.query.skip` | `modelHelper`, most `getAll*` controllers, `transaction` list | **Warning** — critical if `skip` > ~10k |
| `sort: { createdAt: -1 }` | Widespread via `handleGenericGetAll` default | **Safe** if `{ company_id: 1, createdAt: -1 }` index exists per collection |
| `Url.find({})` | `controllers/url.js`, `routes/staticRouter.js` | **Warning** — global short-URL table (may be intentional) |
| `adminCrudGenerator` regex search | `utils/adminCrudGenerator.js` ~122 | **Warning** |

### Sharding

| Topic | Status |
|-------|--------|
| **18 models** with `shardKey: { company_id: 1, _id: 1 }` | orders, order_items, transactions, inventory_movements, logs, users, products, etc. |
| **No shardKey** (reference / small) | `company`, `account`, `branch`, `category`, `warehouse`, `brands`, `attribute`, `integration`, `blog`, `alerts`, `url` — acceptable if low volume and cached |
| **Header sync aggs** | `models/order.js`, `purchase_order.js` — `$match` by `order_id` / `purchase_order_id` only; add `company_id` for chunk targeting |
| **Jumbo tenant** | Single `company_id` with 1B docs → **hot shard**; shard key does not split one tenant |

### Writes

| Pattern | Location | Note |
|---------|----------|------|
| `OrderItem.insertMany` | `order_save` | Good batching for lines |
| Per-line inventory in loop | `order_save` | See P0-3 |
| `createTransactionsFromItems` loop | `transaction.js` | See P0-6 |
| `withTransaction` | order, PO, payment, inventory, stock_movement, expense, etc. | **Good** for same-tenant docs on one shard |
| Counter `findByIdAndUpdate` | `order.js` / `purchase_order.js` + shared `counters` collection | **Global counter docs** — low volume but hot document per tenant key |

### Accounting / ledger

| Area | Behavior | Scale note |
|------|----------|------------|
| Journal lines | `transaction` collection; 2+ lines per economic event | Grows ~2× event count |
| Account balances | `aggregateTransactionSumsByAccountIds` — agg per account set | OK for COA size; not per request on full history |
| List + summary | Full match set aggregated | Needs date bounds (P0-5) |
| No running-balance collection | Balances computed from queries | Full history replay risk |

### Reporting endpoints (tenant-scoped API)

| Endpoint | Date default | Scalar-only agg |
|----------|--------------|-----------------|
| `GET /order/sales` | 365 days | Yes |
| `GET /order/profit-by-order-item` | 365 days | Yes (+ `$lookup`) |
| `GET /order_item/cost-of-goods-sold-by-order-item` | 365 days | Yes (+ `$lookup`) |
| `GET /transaction/list-with-summary` | **No** | Yes |

### Caching

| Component | File | Scale note |
|-----------|------|------------|
| Redis list cache | `utils/redisCache.js`, `dynamicRouteGenerator`, `inventory_movements` | Reduces read load; invalidation must stay correct; not a substitute for index/agg design |

---

## 4. Safe Areas
    
- **Multi-doc transactions** on critical POS / inventory / payment flows (when replica set supports them).
- **Tenant injection** on API CRUD via `handleGenericCreate` / `handleGenericGetAll` when `filter: { company_id }` passed from controllers (majority of API routes).
- **Scalar reporting aggs** on orders / order_items (post-`$push` removal).
- **Partial unique indexes** on orders (`company_id` + `order_no`), stock_movement idempotency keys, user email per tenant.
- **Bulk line insert** `insertMany` on order save (lines batched).
- **Movement subpipeline** in reports uses `$limit: 1` (bounded lookup result).
- **Logs schema** caps string lengths (`models/logs.js`) — reduces document bloat.
- **No background cron** found scanning full collections (no hidden batch jobs in repo).

---

## 5. Missing / Recommended Indexes

### High-volume collections — current vs recommended

| Collection | Existing (representative) | Gap / recommendation |
|------------|---------------------------|----------------------|
| `transactions` | `{ company_id: 1, createdAt: -1 }`, `{ company_id: 1, account_id: 1 }`, journal batch index | Add reporting partials if filtering `status` + `deletedAt` always |
| `inventory_movements` | `{ company_id, product_id, warehouse_id, createdAt }`, `{ company_id, warehouse_id }` | **Add** `{ company_id: 1, reference_type: 1, reference_id: 1, product_id: 1, movement_type: 1 }` for order-item `$lookup` |
| `order_items` | `{ company_id: 1, order_id: 1 }` | **Add** `{ company_id: 1, createdAt: -1 }` for reporting |
| `orders` | `{ company_id, order_no }` unique partial; `{ company_id, order_status, createdAt }` partial | Align `findSales` filters with partial index |
| `payment_receipts` | shardKey only | **Add** `{ company_id: 1, createdAt: -1 }`, `{ company_id: 1, transaction_number: 1 }` |
| `purchase_order_items` | `{ purchase_order_id: 1, company_id: 1 }` | OK for header sync |
| `products` | company + slug indexes | Ensure list sorts use indexed fields |
| `accounts` | `{ company_id, name }` unique, `{ company_id, account_number }` | Low volume per tenant |
| `categories` | `{ company_id, name }`, etc. | Admin must filter by `company_id` in queries |

### Reference data (no shardKey)

`branch`, `warehouse`, `category`, `account` — low cardinality per tenant; replicate or place on config shards; **always filter by `company_id` in application code**.

---

## 6. Sharding Risks

| Risk | Explanation | Impact |
|------|-------------|--------|
| **Scatter-gather** | Queries without `company_id` hit all shards | Admin routes, `Url.find({})`, unscoped aggregates |
| **Hot shard** | One mega-tenant’s `company_id` owns disproportionate data | Single-shard CPU/disk hotspot despite compound key |
| **Cross-shard `$lookup`** | `order_items` → `inventory_movements` if collections chunked differently | Currently same `company_id` prefix helps co-location **only if** both use same shard key and same `company_id` value |
| **Multi-doc transaction** | Must target single shard in 4.2+ | OK if all writes share same `company_id` |
| **`counters` collection** | Global `_id` per tenant string, not `{ company_id, _id }` on data collections | Minor hotspot, not billion-scale |
| **Company collection** | Root tenant metadata | Not sharded same way; child rows point to `_id` |

---

## 7. Billion-Record Readiness Score

| Category | Score / 10 | Notes |
|----------|:----------:|-------|
| **Queries** | 5 | Tenant API generally OK; admin + regex + unscoped finds drag down |
| **Aggregations** | 6 | `$push` fixed on reports; ledger + `$lookup` remain |
| **Writes** | 5 | Transactions good; per-line inventory + sequential GL bad |
| **Sharding** | 6 | 18/31 active models declare shardKey; ops gaps in admin |
| **Inventory** | 4 | Ledger replay architecture |
| **Reporting** | 6 | Defaults on 3 endpoints; transaction summary open |
| **Accounting** | 5 | Append-only GL OK; scanning all lines for summary not |

```text
Overall readiness: 5 / 10
```

**Interpretation:**

- **100M:** Possible for **median tenants** with sharding, P0 fixes, materialized stock, cursor pagination, bounded reports.
- **1B:** Needs **event sourcing read models**, **pre-aggregated inventory**, **OLAP** for dashboards, removal of per-line ledger scans on checkout.
- **10B:** **Platform redesign** tier (separate analytics DB, stream processing, tenant isolation policies, possibly per-tenant databases for whales).

---

## 8. Memory and CPU Hotspots

| Endpoint / path | Hotspot | OOM risk |
|-----------------|---------|----------|
| `order_save` | Per-line agg + movement + GL bulk | Medium (transaction timeout first) |
| `cost_of_goods_available` | Group all products with movements | Medium result set (one row per SKU) |
| `handleGenericGetAll` | Large `limit`, deep populate | High if `limit` unbounded |
| `createTransactionsFromItems` (500) | 500× validate + hooks | CPU, not single doc 16MB |
| Report `$lookup` | Many order lines in window | CPU bound |
| Redis cache large lists | Cached JSON payloads | Memory on Redis nodes |

**16MB BSON agg limit:** Mitigated for sales/profit/COGS reports after `$push` removal. **Still applies** if `modelHelper` `group` uses `$push` in future.

---

## 9. Aggregation Inventory (complete)

| # | File:line | Collection | `$match` first | `company_id` | `$push` | `$lookup` | Notes |
|---|-----------|------------|----------------|--------------|---------|-----------|-------|
| 1 | order_item.js:189 | order_items | Yes | Yes | No | Yes | COGS report |
| 2 | order.js:637 | order_items | Yes | Yes | No | Yes | Profit report |
| 3 | order.js:809 | orders | Yes | Yes | No | No | Sales report |
| 4 | transaction.js:267 | transactions | Yes | If user | No | No | Needs date window P1 |
| 5 | account.js:74 | transactions | Yes | Param | No | No | Bounded `$in` accounts |
| 6–10 | inventory_movements.js | inventory_movements | Yes | Yes | No | No | Ledger math |
| 11 | order.js:582 | order_items | Yes | **No** | No | No | Single order — OK |
| 12 | purchase_order.js:447 | purchase_order_items | Yes | **No** | No | No | Single PO — OK |
| 13 | modelHelper.js:2803+ | dynamic | Yes | Caller | Latent | No | `$skip` warning |
| 14 | admin.js:1734 | products | Yes | **No** | No | No | **P0** |
| 15–17 | product.js | warehouse_inventories | Yes | Usually | No | No | Model may be inactive |

---

## 10. Priority Roadmap

### P0 — Before large-scale production

1. Scope **all admin** queries (`dashboard`, dropdowns, aggregates) to `company_id`.
2. **Materialize inventory balances** (`warehouse_inventory` or equivalent); use ledger as source of truth asynchronously, not per checkout line.
3. **Require or default date ranges** on `transaction/list-with-summary` aggregation.
4. Replace **offset pagination** with cursor (`company_id`, `createdAt`, `_id`) on high-volume list APIs.
5. Restrict or disable **full-text regex search** on large collections (Atlas Search / prefix / dedicated index).

### P1 — Fix soon

6. Batch GL: `insertMany` transactions or `bulkWrite` with shared `transaction_number`.
7. Index for movement `$lookup` join keys.
8. Add `company_id` to order/PO header sync `$match`.
9. Harden `modelHelper` group aggregation (tenant merge, no `$push`).
10. Re-enable or replace `warehouse_inventory` consistently in `product.js`.

### P2 — Billion-scale architecture

11. OLAP / warehouse (ClickHouse, BigQuery, MongoDB `$merge` nightly rollups) for dashboards.
12. Per-tenant rate limits and checkout queue for whale tenants.
13. Archive cold `inventory_movements` / `transactions` to cheaper tier.
14. Consider **separate DB per whale tenant**.
15. Load tests: order save with 50 lines @ 10M movements/tenant.

---

## 11. Related audits

- `aggregation-scalability-audit.md` — aggregation-only deep dive (updated after report fixes).
- `models-shard-key-audit.md` — Mongoose `shardKey` declaration status.

---

_Audit performed by static analysis of the repository. Validate with load tests and `.explain("executionStats")` on staging clusters at target data volumes._

# Mongoose Shard Key Audit — `models/` Directory

**Project:** Node.js + Express + Mongoose + MongoDB multi-tenant POS  
**Scope:** All files under `models/` (including subdirectories)  
**Initial audit:** 2026-06-01  
**Latest re-audit:** 2026-06-01 (after all REVIEW schema fixes)  
**Status:** **Complete** — 0 CRITICAL, 0 REVIEW. All actionable tenant collections declare `{ company_id: 1, _id: 1 }`.

---

## Re-audit snapshot

| Metric | Count |
|--------|------:|
| Registered models with correct `shardKey` | **18** |
| Open CRITICAL | **0** |
| Open REVIEW | **0** |
| SKIP (no shard key needed) | **17** rows in summary table |

**Resolved in latest pass:** `adjustment.js`, `assets.js`, `expense.js`, `process.js`, `product.js`, `product_relations.js`, `complain.js` (including new optional `company_id` on complains).

---

## Purpose

Each tenant is scoped with `company_id`. High-volume collections should declare a compound shard key `{ company_id: 1, _id: 1 }` on the Mongoose schema so writes spread within a tenant (monotonic `_id`) instead of hotspotting on `company_id` alone.

**Target shard key (when required):**

```javascript
{ shardKey: { company_id: 1, _id: 1 } }
```

Pass as the second argument to `new mongoose.Schema({ ... }, { timestamps: true, shardKey: { company_id: 1, _id: 1 } })`.

**DBA note:** Schema declaration only. Run `sh.shardCollection()` separately on each collection name.

---

## Checks Per Schema

| Check | Description |
| ----- | ----------- |
| **1** | Is `shardKey` present in the schema options (second argument)? → Yes / No |
| **2** | If present, is it exactly `{ company_id: 1, _id: 1 }`? → Correct / Wrong / Missing |
| **3** | Is `company_id` defined as `mongoose.Schema.Types.ObjectId` (typically `ref: "company"`)? → Yes / No / N/A |
| **4** | Growth rate from schema shape → Very fast / Fast / Medium / Slow |
| **5** | Urgency from Check 2 + 4 → CRITICAL / REVIEW / OK / SKIP |

### Urgency rules

| Urgency | Condition |
| ------- | --------- |
| **CRITICAL** | shardKey wrong or missing **and** growth = Very fast or Fast |
| **REVIEW** | shardKey wrong or missing **and** growth = Medium |
| **OK** | shardKey correct (any growth) |
| **SKIP** | Slow collections, global counters, embedded sub-schemas, inactive/commented models |

### Growth classification guide

| Rate | Examples |
| ---- | -------- |
| **Very fast** | transactions, inventory_movements, logs, order_items |
| **Fast** | orders, payment_receipts, stock_movements, purchase_order_items, amount_transfers |
| **Medium** | users, products, purchase_orders, expenses, adjustments, assets, process, product_relations, complains |
| **Slow** | companies, branches, accounts, categories, warehouses, counters, integrations, blogs, attributes, brands, alerts (config), urls |

---

## Summary Table (All Schemas) — current

Collection names inferred from `mongoose.model("<name>", …)` default pluralization unless `collection:` is set in options (none found).

| File | Collection | shardKey declared | shardKey correct | company_id field | Growth | Urgency |
| ---- | ---------- | :---------------: | :--------------: | :--------------: | ------ | ------- |
| models/account.js | accounts | No | — | Yes | Slow | SKIP |
| models/adjustment.js | adjustments | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/alerts.js | alerts | No | — | Yes | Slow | SKIP |
| models/amount_transfer.js | amount_transfers | Yes | Correct | Yes | Fast | OK |
| models/assets.js | assets | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/attribute.js | attributes | No | — | Yes | Slow | SKIP |
| models/blog.js | blogs | No | — | Yes | Slow | SKIP |
| models/branch.js | branches | No | — | Yes | Slow | SKIP |
| models/brands.js | brands | No | — | Yes | Slow | SKIP |
| models/category.js | categories | No | — | Yes | Slow | SKIP |
| models/company.js | companies | No | — | Yes\* | Slow | SKIP |
| models/complain.js | complains | **Yes** | **Correct** | **Yes** | Medium | **OK** |
| models/expense.js | expenses | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/integration.js | integrations | No | — | Yes | Slow | SKIP |
| models/inventory_movements.js | inventory_movements | Yes | Correct | Yes | Very fast | OK |
| models/logs.js | logs | Yes | Correct | Yes | Very fast | OK |
| models/order.js → `counterSchema` | counters | No | — | N/A | Slow | SKIP |
| models/order.js → `modelSchema` | orders | Yes | Correct | Yes | Fast | OK |
| models/order_item.js | order_items | Yes | Correct | Yes | Very fast | OK |
| models/payment_receipt.js | payment_receipts | Yes | Correct | Yes | Fast | OK |
| models/process.js | processes | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/product.js | products | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/product_relations.js | product_relations | **Yes** | **Correct** | Yes | Medium | **OK** |
| models/purchase_order.js → `counterSchema` | counters | No | — | N/A | Slow | SKIP |
| models/purchase_order.js → `modelSchema` | purchase_orders | Yes | Correct | Yes | Medium | OK |
| models/purchase_order_item.js | purchase_order_items | Yes | Correct | Yes | Fast | OK |
| models/stock_movement.js | stock_movements | Yes | Correct | Yes | Fast | OK |
| models/stock_transfer.js → `stockTransferSchema` | stock_transfers | No | — | Yes† | Fast | SKIP‡ |
| models/transaction.js → `referenceEmbedSchema` | (embedded) | No | — | N/A | — | SKIP |
| models/transaction.js → `modelSchema` | transactions | Yes | Correct | Yes | Very fast | OK |
| models/url.js | urls | No | — | No | Slow | SKIP |
| models/user.js → `permissionSetSchema` | (embedded) | No | — | N/A | — | SKIP |
| models/user.js → `userSchema` | users | Yes | Correct | Yes | Medium | OK |
| models/warehouse.js | warehouses | No | — | Yes | Slow | SKIP |
| models/warehouse_inventory.js → `modelSchema` | warehouse_inventories | No | — | Yes† | Medium | SKIP‡ |

**Footnotes**

- \* **company.js:** `company_id` is an optional **parent-tenant** self-reference (`ObjectId`, `ref: "company"`), not the usual “this document belongs to tenant X” field. Root tenants omit it.
- † **stock_transfer.js / warehouse_inventory.js:** `company_id` appears only in **commented-out** schema code.
- ‡ Entire model file is commented; `mongoose.model()` is not registered — no live collection.

**Shard key finding:** All **18** declared keys match `{ company_id: 1, _id: 1 }`. No schemas use wrong keys such as `{ company_id: 1 }`, `{ createdAt: 1 }`, or `{ _id: 1 }` alone.

---

## Files Requiring Shard Key Changes

### CRITICAL — none

All very-fast and fast-growth tenant models that need sharding now declare `shardKey` in schema options.

### REVIEW — none

All medium-growth tenant models in scope now declare `shardKey`. `complain.js` includes optional `company_id` (`ref: "company"`, not `required`).

---

## Files Already Correct (OK) — 18 collections

| File | Collection |
| ---- | ---------- |
| models/adjustment.js | adjustments |
| models/amount_transfer.js | amount_transfers |
| models/assets.js | assets |
| models/complain.js | complains |
| models/expense.js | expenses |
| models/inventory_movements.js | inventory_movements |
| models/logs.js | logs |
| models/order.js (`modelSchema`) | orders |
| models/order_item.js | order_items |
| models/payment_receipt.js | payment_receipts |
| models/process.js | processes |
| models/product.js | products |
| models/product_relations.js | product_relations |
| models/purchase_order.js (`modelSchema`) | purchase_orders |
| models/purchase_order_item.js | purchase_order_items |
| models/stock_movement.js | stock_movements |
| models/transaction.js (`modelSchema`) | transactions |
| models/user.js (`userSchema`) | users |

---

## Files to Skip

No shard key action needed for:

| Category | Files |
| -------- | ----- |
| **Slow / config** | account.js, alerts.js, attribute.js, blog.js, branch.js, brands.js, category.js, company.js, integration.js, url.js, warehouse.js |
| **Global counters** | order.js (`counterSchema` → `counters`), purchase_order.js (`counterSchema` → `counters`) |
| **Embedded sub-schemas** | transaction.js (`referenceEmbedSchema`), user.js (`permissionSetSchema`) |
| **Inactive (fully commented)** | stock_transfer.js, warehouse_inventory.js |

Optional future work (not required by growth/urgency rules): add `shardKey` to slow tenant collections (e.g. `branches`, `accounts`, `products` catalog neighbors) only if you plan to shard those collections at scale.

---

## Schema update history

### Batch 1 — high-volume POS collections (8 files)

`order`, `order_item`, `transaction`, `inventory_movements`, `stock_movement`, `user`, `payment_receipt`, `purchase_order`

### Batch 2 — CRITICAL follow-up (3 files)

`logs`, `purchase_order_item`, `amount_transfer`

### Batch 3 — REVIEW follow-up (7 files)

`adjustment`, `assets`, `expense`, `process`, `product`, `product_relations`, `complain` (+ `company_id` on complains)

---

## DBA: `sh.shardCollection` for all OK collections

Replace `<dbname>` with your database name.

```javascript
sh.shardCollection("<dbname>.orders", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.order_items", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.transactions", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.inventory_movements", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.stock_movements", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.users", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.payment_receipts", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.purchase_orders", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.logs", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.purchase_order_items", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.amount_transfers", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.adjustments", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.assets", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.complains", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.expenses", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.processes", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.products", { company_id: 1, _id: 1 });
sh.shardCollection("<dbname>.product_relations", { company_id: 1, _id: 1 });
```

---

## Audit Methodology

1. Scanned all `models/**/*.js` files (31 active model files; no `index.js` barrel).
2. Located `new mongoose.Schema(...)` definitions; reported multiple schemas per file separately.
3. Verified `shardKey` in schema options and `company_id` field types.
4. Classified growth and urgency per rules above.

---

## File Inventory (`models/`)

| File | Active model registered? |
| ---- | ------------------------ |
| account.js | Yes |
| adjustment.js | Yes |
| alerts.js | Yes |
| amount_transfer.js | Yes |
| assets.js | Yes |
| attribute.js | Yes |
| blog.js | Yes |
| branch.js | Yes |
| brands.js | Yes |
| category.js | Yes |
| company.js | Yes |
| complain.js | Yes |
| expense.js | Yes |
| integration.js | Yes |
| inventory_movements.js | Yes |
| logs.js | Yes |
| order.js | Yes (order + counter) |
| order_item.js | Yes |
| payment_receipt.js | Yes |
| process.js | Yes |
| product.js | Yes |
| product_relations.js | Yes |
| purchase_order.js | Yes (purchase_order + counter) |
| purchase_order_item.js | Yes |
| stock_movement.js | Yes |
| stock_transfer.js | No (commented out) |
| transaction.js | Yes |
| url.js | Yes |
| user.js | Yes |
| warehouse.js | Yes |
| warehouse_inventory.js | No (commented out) |

---

_End of report_

# Aggregation Scalability Audit

**Project:** Node.js + Express + Mongoose multi-tenant POS  
**Shard key target (tenant collections):** `{ company_id: 1, _id: 1 }`  
**Initial audit:** 2026-06-01  
**Latest re-audit:** 2026-06-01 (after `findSales` + `findProfitByOrderItem` fixes)  
**Mode:** Report only (code fixes applied separately in controllers)

---

## Re-audit snapshot

| Metric | First audit | After `findSales` | **Now** |
|--------|-------------|-------------------|---------|
| Critical | 5 | 4 | **3** |
| Warning | 12 | 11 | **10** |
| Safe / OK | 8 | 9 | **10** |

### Fixed since first audit

| Endpoint | File | Change |
|----------|------|--------|
| `GET /order/sales` | `controllers/order.js` ~809 | No `$push`; scalar `total_amount` + `order_count`; default **365-day** `createdAt` when `from`/`to` omitted |
| `GET /order/profit-by-order-item` | `controllers/order.js` ~637 | No `$push`; scalar `profit` + `line_count`; default **365-day** window; `$lookup` unchanged with scale comment |

### Still open (P0)

1. **`costOfGoodsSoldByOrderItem`** — `controllers/order_item.js` ~171 — `order_item_ids: { $push: "$_id" }` + `$lookup`; **no** default date range  
2. **`routes/admin.js`** ~1734 — product parent dropdown — **no `company_id`** in `$match`  
3. **`utils/modelHelper.js`** ~2772 — optional `group` agg — latent unbounded `$push` / missing tenant filter (no callers today)

---

## Summary

| Metric | Count |
|--------|------:|
| **Total aggregation call sites** | **17** |
| **Critical** | **3** |
| **Warning** | **10** |
| **Safe** | **10** |

---

## Discovery index

| # | File | Line(s) | Collection | Purpose |
|---|------|---------|------------|---------|
| 1 | `controllers/order_item.js` | 171 | `order_items` | COGS + `$lookup` + **`$push` ids** ⚠️ |
| 2 | `controllers/order.js` | 637 | `order_items` | **`findProfitByOrderItem`** ✅ |
| 3 | `controllers/order.js` | 809 | `orders` | **`findSales`** ✅ |
| 4 | `controllers/transaction.js` | 267 | `transactions` | Debit/credit summary |
| 5 | `controllers/account.js` | 74 | `transactions` | Per-account sums |
| 6–10 | `controllers/inventory_movements.js` | 111, 158, 224, 420, 872 | `inventory_movements` | Ledger / COGS / stock |
| 11 | `models/order.js` | 582 | `order_items` | Header subtotal sync |
| 12 | `models/purchase_order.js` | 447 | `purchase_order_items` | PO header subtotal sync |
| 13 | `utils/modelHelper.js` | 2803, 2813 | *dynamic* | Optional `group` in `handleGenericGetAll` |
| 14 | `routes/admin.js` | 1734 | `products` | Parent-product dropdown ⚠️ |
| 15–17 | `controllers/product.js` | 942, 1048, 1214 | `warehouse_inventories` | Stock / qty reports |

---

## Critical findings

### `controllers/order_item.js` (lines 171–247) — `costOfGoodsSoldByOrderItem`

**Issue:** `order_item_ids: { $push: "$_id" }` after correlated `$lookup` on `inventory_movements`. Optional `from`/`to` only — **no default reporting window**.

**Why dangerous:** 16 MB BSON aggregation output limit; unbounded ID array per tenant.

**Recommended fix:** Mirror `findProfitByOrderItem`: scalar `$group` (`cost_of_goods_sold`, `line_count`); add `FIND_COGS_DEFAULT_RANGE_DAYS`; drop `order_item_ids` from response.

---

### `routes/admin.js` (lines 1734–1755)

**Issue:** `$match` without `company_id` on `products` aggregate.

**Recommended fix:** `company_id: req.user.company_id` (or document super-admin exception).

---

### `utils/modelHelper.js` (lines 2772–2813)

**Issue:** Caller-defined `group` may use `$push`; `mongoFilter` not auto-scoped to tenant.

**Recommended fix:** Inject `company_id`; whitelist accumulators (`$sum`, `$count`, `$first`).

---

## Resolved (no longer critical)

### `findSales` — `controllers/order.js` ~809

- `$match`: `company_id`, `status`, `deletedAt`, optional `order_status`, `createdAt` (default last **365** days)  
- `$group`: `total_amount`, `order_count` only  
- Response: no `order_ids`

### `findProfitByOrderItem` — `controllers/order.js` ~637

- `$match`: `company_id` first; default **365** days when dates omitted (`FIND_PROFIT_DEFAULT_RANGE_DAYS`)  
- `$lookup`: `inventory_movements` (unchanged; documented as scale risk)  
- `$group`: `profit`, `line_count` only  
- Response: no `order_item_ids`

---

## Warning findings

| Location | Issue |
|----------|--------|
| `findSales` / `findProfitByOrderItem` | Default **365-day** scan — bounded vs full history, still heavy for huge tenants |
| `costOfGoodsSoldByOrderItem` | Same `$lookup` fan-out as profit (until refactored) |
| `controllers/transaction.js` ~267 | Summary agg may scan full tenant GL history without date filter |
| `controllers/inventory_movements.js` ~224 | Full ledger `$group` by `product_id`, no date range |
| `models/order.js` / `purchase_order.js` sync | `$match` by order/PO id only — add `company_id` for shards |
| `controllers/product.js` | `warehouse_inventories` model commented out in `models/` |
| `utils/modelHelper.js` | `$skip` on group aggregation path |

---

## Safe aggregations

| File | Line | Notes |
|------|------|--------|
| `controllers/order.js` | 637, 809 | Reporting endpoints (fixed) |
| `controllers/transaction.js` | 267 | `$sum` only |
| `controllers/account.js` | 74 | Bounded `account_id` `$in` |
| `controllers/inventory_movements.js` | 111, 158, 420, 872 | Low-cardinality or single-product scope |
| `models/order.js` | 582 | Single-order sum |
| `models/purchase_order.js` | 447 | Single PO sum |
| `controllers/product.js` | 1214 | Single-product sum |

---

## `$push` in aggregations

| File | Function | Status |
|------|----------|--------|
| `controllers/order.js` | `findSales` | ✅ Removed |
| `controllers/order.js` | `findProfitByOrderItem` | ✅ Removed |
| `controllers/order_item.js` | `costOfGoodsSoldByOrderItem` | ❌ **Still present** |
| `controllers/url.js` | `findOneAndUpdate` | N/A (not aggregation) |

---

## Recommended indexes

| Collection | Index |
|------------|--------|
| `inventory_movements` | `{ company_id: 1, reference_type: 1, reference_id: 1, product_id: 1, movement_type: 1 }` partial `deletedAt: null` |
| `order_items` | `{ company_id: 1, createdAt: -1 }` |
| `orders` | Use `company_order_status_created_1` where filters include `order_status` + `createdAt` |

---

## Priority roadmap

### P0

1. Fix `costOfGoodsSoldByOrderItem` (`order_item.js`) — same pattern as profit/sales.  
2. Add `company_id` to `routes/admin.js` product aggregate.  
3. Harden `modelHelper` group path.

### P1

4. Batch or denormalize `inventory_movements` `$lookup` on line reports.  
5. Add `company_id` to header sync aggregations in models.  
6. Default date range on transaction list summary.  
7. Align reporting constants (365 vs 90 days) with product requirements.

### P2

8. Materialized dashboard rollups.  
9. Cursor pagination vs `$skip` in `modelHelper`.  
10. Staging `.explain("executionStats")` at volume.

---

## Checklist

| Check | Result |
|-------|--------|
| `$match` first | 17/17 ✅ |
| `company_id` in first `$match` | ❌ `admin.js`; ⚠️ sync totals; ⚠️ `modelHelper` caller-dependent |
| Unbounded `$push` in agg | ❌ **1** (`order_item.js` COGS); ✅ sales + profit fixed |
| High-volume `$lookup` | ⚠️ profit (fixed push), COGS (open) |

---

_End of report_

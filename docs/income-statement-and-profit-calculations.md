# Income statement & profit calculations

This document describes how **profit**, **discounts**, and **expense** amounts are computed in the API, how they appear on the **Balance Sheet** and **Income Statement** screens (ai-pos frontend), and what the backend route `GET /api/reports/income-statement` returns.

> **Frontend repo:** `brands/ai-pos` — `IncomeStatementView.jsx`, `BalanceSheetView.jsx`, `incomeStatementAPI.js`, `balanceSheetAPI.js`.

---

## 1. Quick reference

| Field / label                      | Primary API                                                             | Source collection / account              | Date filter on API?                                                     |
| ---------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| **Profit** (order)                 | `GET /api/order/profit-by-order-item`                                   | `order_item.profit`                      | Yes — `from` / `to` on line `createdAt`; default **90 days** if omitted |
| **Sales return profit**            | `GET /api/sales_return/profit-by-sales-return-item`                     | `sales_return_item.profit`               | Yes — same; default **90 days**                                         |
| **Sales discount**                 | `GET /api/account/default-discount-sums`                                | GL → `default_sales_discount_account`    | **No** — all-time GL                                                    |
| **Purchase discount**              | same                                                                    | GL → `default_purchase_discount_account` | **No** — all-time GL                                                    |
| **Expense**                        | `GET /api/account/fetch-account-by-type?account_type=operating_expense` | Chart account **Expense**                | **No** — all-time GL                                                    |
| **Salary**                         | same (`operating_expense`)                                              | Chart account **Salary**                 | **No**                                                                  |
| **Shipping**                       | same                                                                    | Chart account **Shipping**               | **No**                                                                  |
| **Utilities**                      | same                                                                    | Chart account **Utilities**              | **No**                                                                  |
| **Other expense**                  | `fetch-account-by-type?account_type=other_expense`                      | Chart account **Other Expense**          | **No**                                                                  |
| **Withdraw**                       | same (`other_expense`)                                                  | Chart account **Withdraw**               | **No**                                                                  |
| **Income statement (grouped P&L)** | `GET /api/reports/income-statement`                                     | GL by `account_type` in period           | Yes — `startDate` / `endDate`                                           |

Default chart of accounts (names and types) are created at company signup in `controllers/user.js`.

---

## 2. Line-level profit (orders)

### 2.1 Formula (stored on create/update)

When order lines are built, profit is denormalized on each `order_item` row:

```text
profit = subtotal − (cost_price_at_sale × qty)
```

**Code:** `controllers/order.js` — `buildOrderItemDocsFromLines()`.

```javascript
profit: Number(line.subtotal) - Number(cost_price_at_sale * line.qty),
```

- `subtotal` — line selling total
- `cost_price_at_sale` — frozen unit cost from product at sale time
- `qty` — quantity sold

### 2.2 Report aggregation

**Endpoint:** `GET /api/order/profit-by-order-item`  
**Handler:** `findProfitByOrderItem` in `controllers/order.js`

**Query params:**

| Param                    | Effect                                                   |
| ------------------------ | -------------------------------------------------------- |
| `from`, `to`             | Filter `order_item.createdAt` (inclusive)                |
| _(both omitted)_         | Last **90 days** only (`FIND_PROFIT_DEFAULT_RANGE_DAYS`) |
| `order_id`, `product_id` | Optional filters                                         |

**MongoDB pipeline (summary):**

```javascript
OrderItem.aggregate([
  { $match: { company_id, status: "active", deletedAt: null, createdAt: { ... } } },
  // Correlated $lookup: require matching inventory_movements "out" for this order+product
  { $lookup: { from: "inventory_movements", pipeline: [ /* movement_type: out */ ] } },
  { $match: { "out_movements.0": { $exists: true } } },
  { $group: {
      _id: null,
      profit: { $sum: { $ifNull: ["$profit", 0] } },
      line_count: { $sum: 1 },
  }},
])
```

**Response:**

```json
{ "success": true, "profit": 1234.56, "line_count": 42, "company_id": "..." }
```

**Balance sheet usage:** Frontend calls this without date params → backend applies the **90-day default**, not the balance sheet month picker.

---

## 3. Line-level profit (sales returns)

### 3.1 Formula (stored on create/update)

```text
profit = (cost_price_at_return − price) × qty
```

**Code:** `controllers/sales_return.js` — `applyFrozenCostAndProfitToSrLineDocs()`.

```javascript
doc.profit = roundSrMoney2((cost - Number(doc.price)) * Number(doc.qty));
```

- `cost_price_at_return` — weighted / frozen cost at return time
- `price` — return line unit price
- Positive profit means returning inventory at a lower price than cost (typical margin impact)

### 3.2 Report aggregation

**Endpoint:** `GET /api/sales_return/profit-by-sales-return-item`  
**Handler:** `findProfitBySalesReturnItem` in `controllers/sales_return.js`

Same date rules as order profit (90-day default, optional `from` / `to`).

**MongoDB pipeline (summary):**

```javascript
SalesReturnItem.aggregate([
  { $match: { company_id, status: "active", deletedAt: null, createdAt: { ... } } },
  { $group: {
      _id: null,
      profit: { $sum: { $ifNull: ["$profit", 0] } },
      line_count: { $sum: 1 },
  }},
])
```

**Balance sheet label:** “Sales Return Profit”.

---

## 4. Discounts (GL)

**Endpoint:** `GET /api/account/default-discount-sums`  
**Handler:** `getCompanyDefaultDiscountSums` in `controllers/account.js`

Resolves company defaults:

- `default_sales_discount_account` → chart name **Sales Discount** (`account_type: other`)
- `default_purchase_discount_account` → **Purchase Discount** (`account_type: other`)

### 4.1 GL aggregation (all time)

```javascript
Transaction.aggregate([
  {
    $match: {
      account_id: { $in: [salesDiscountId, purchaseDiscountId] },
      company_id,
      deletedAt: null,
    },
  },
  {
    $group: {
      _id: "$account_id",
      total_debit: {
        $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
      },
      total_credit: {
        $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
      },
    },
  },
]);
```

Derived fields per account:

- `net_debit_minus_credit` = total_debit − total_credit
- `credit_minus_debit` = total_credit − total_debit

### 4.2 Amount rules

| Role                  | Amount used              |
| --------------------- | ------------------------ |
| **sales_discount**    | `net_debit_minus_credit` |
| **purchase_discount** | `credit_minus_debit`     |

Frontend (`balanceSheetAPI.js`) **negates** sales discount for display on Owner’s equity.

---

## 5. Operating & other expenses (named GL accounts)

Loaded via:

```http
GET /api/account/fetch-account-by-type?account_type=operating_expense
GET /api/account/fetch-account-by-type?account_type=other_expense
```

**Handler:** `fetchAccountsByType` in `controllers/account.js`

Each account in the response includes `transactions_sum` from `aggregateTransactionSumsByAccountIds()` — **lifetime** totals (no `createdAt` filter on `transactions`).

### 5.1 Default account names (signup)

| UI / report label | Account name  | `account_type`      |
| ----------------- | ------------- | ------------------- |
| Expense           | Expense       | `operating_expense` |
| Salary            | Salary        | `operating_expense` |
| Shipping          | Shipping      | `operating_expense` |
| Utilities         | Utilities     | `operating_expense` |
| Other Expense     | Other Expense | `other_expense`     |
| Withdraw          | Withdraw      | `other_expense`     |

Created in `controllers/user.js` during `user_company` signup.

### 5.2 Amount on balance sheet

Frontend maps each account (`BalanceSheetView.jsx`):

```javascript
// Operating / other expense lines on Owner's equity:
amount = account.transactions_sum.credit_minus_debit;
// credit_minus_debit = total_credit − total_debit
```

For normal debit-heavy expense accounts, this is usually **negative** (shown as a deduction from equity).

Assets on the same screen use `net_debit_minus_credit` instead.

---

## 6. Income statement screen (frontend composition)

The ai-pos **Income Statement** page does **not** rely on a single backend payload for all lines. It merges several APIs (`incomeStatementAPI.js`):

| Step | API                                                                 | What it contributes                                                                                |
| ---- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1    | `GET reports/income-statement?startDate&endDate`                    | Base sections (if deployed); normalized to `revenue`, `costOfGoodsSold`, `operatingExpenses`, etc. |
| 2    | `GET order/sales?startDate&endDate`                                 | **Sales** revenue line → `SUM(order.total_amount)`                                                 |
| 3    | `GET order_item/cost-of-goods-sold-by-order-item?startDate&endDate` | **COGS** line                                                                                      |
| 4    | `GET account/fetch-account-by-type?account_type=operating_expense`  | All operating expense accounts (**lifetime** GL)                                                   |

**Totals on UI:**

```text
grossProfit        = totalRevenue − totalCOGS
operatingIncome    = grossProfit − totalOperatingExpenses
netIncome          = operatingIncome + totalOtherIncome − totalOtherExpenses
```

(`computeIncomeStatementTotals` in `incomeStatementAPI.js`)

### 6.1 COGS for income statement

**Endpoint:** `GET /api/order_item/cost-of-goods-sold-by-order-item`  
**Handler:** `costOfGoodsSoldByOrderItem` in `controllers/order_item.js`

```text
cost_of_goods_sold = SUM(cost_price_at_sale × qty)
```

Only for lines with a matching `inventory_movements` **out** row (same lookup pattern as order profit). Default **90 days** if `from` / `to` omitted.

### 6.2 Sales total for income statement

**Endpoint:** `GET /api/order/sales`  
**Handler:** `findSales` in `controllers/order.js`

```javascript
{ $group: { _id: null, total_amount: { $sum: "$total_amount" }, order_count: { $sum: 1 } } }
```

Default **365 days** if `from` / `to` omitted.

---

## 7. Backend income statement route

**Endpoint:** `GET /api/reports/income-statement`  
**Handler:** `getIncomeStatement` in `controllers/reports.js`  
**Logic:** `utils/incomeStatementReport.js`

### 7.1 Query parameters

| Param        | Required | Notes                                      |
| ------------ | -------- | ------------------------------------------ |
| `startDate`  | Yes      | `YYYY-MM-DD` (local calendar day start)    |
| `endDate`    | Yes      | `YYYY-MM-DD` (inclusive, end of local day) |
| `from`, `to` | Aliases  | Same as above                              |
| `company_id` | Optional | Must match authenticated tenant            |

### 7.2 Period GL aggregation

Unlike balance-sheet account fetches, this **filters transactions by `createdAt`** inside the selected range:

```javascript
Transaction.aggregate([
  {
    $match: {
      account_id: { $in: accountIds },
      company_id,
      deletedAt: null,
      status: "active",
      createdAt: { $gte: fromDate, $lte: toDate },
    },
  },
  { $group: { _id: "$account_id", total_debit, total_credit, line_count } },
]);
```

Account types included: `revenue`, `cost_of_goods_sold_account`, `operating_expense`, `other_expense`.

### 7.3 Period amount per account type

| `account_type`                                                     | Period amount             |
| ------------------------------------------------------------------ | ------------------------- |
| `revenue`                                                          | `credit_minus_debit`      |
| `cost_of_goods_sold_account`, `operating_expense`, `other_expense` | `−net_debit_minus_credit` |

### 7.4 Response totals

```text
gross_profit     = revenue.total − cost_of_goods_sold.total
operating_income = gross_profit − operating_expenses.total
net_income       = operating_income − other_expenses.total
```

Response shape uses nested sections (`revenue.accounts[]`, etc.), **not** flat keys like `profit` or `salary`.

---

## 8. Balance sheet Owner’s equity (how fields appear together)

The balance sheet loads parallel API calls (`BalanceSheetView.jsx`) and builds equity lines from:

1. Equity accounts (`account_type=equity`)
2. **Profit** — `order/profit-by-order-item`
3. **Sales return profit** — `sales_return/profit-by-sales-return-item`
4. Stock adjustments — `adjustment/get-all-active`
5. **Sales / purchase discount** — `account/default-discount-sums`
6. **Operating expenses** — each `operating_expense` account (Expense, Salary, Shipping, Utilities, …)
7. **Other expenses** — each `other_expense` account (Other Expense, Withdraw, …)

There is **no single backend document** that returns all of these keys in one JSON object today.

---

## 9. Known inconsistencies (for implementers)

1. **Date params:** Income statement frontend sends `startDate` / `endDate`, but `order/sales` and COGS handlers read **`from` / `to`** only — period filtering may not apply unless aliases are added on the backend.

2. **Mixed time windows:** Profit/COGS default to 90 days; sales default to 365 days; GL expense accounts are **all-time**; `/reports/income-statement` is **period-only**.

3. **Balance sheet month picker** does not pass dates to profit/discount/expense APIs — equity profit reflects backend defaults, not the selected UI range.

4. **Two COGS concepts:**
   - Line COGS: `cost_price_at_sale × qty` on sold lines
   - Inventory valuation: `inventory_movements/cost-of-goods-available` (balance sheet inventory section)

5. **`/reports/income-statement`** groups by GL account type; it does **not** expose `profit`, `sales_return_profit`, or named accounts (`salary`, `withdraw`, etc.) as top-level fields.

---

## 10. File index

| Area                                     | Path                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| Order line profit (write + report)       | `controllers/order.js`                                         |
| Sales return line profit                 | `controllers/sales_return.js`                                  |
| COGS by order item                       | `controllers/order_item.js`                                    |
| Discount sums                            | `controllers/account.js`                                       |
| Accounts by type + GL sums               | `controllers/account.js`                                       |
| Income statement route                   | `controllers/reports.js`, `utils/incomeStatementReport.js`     |
| Route registration                       | `routes/api.js`                                                |
| Balance sheet line profit (GL reconcile) | `utils/balanceSheetReconcile.js` — `aggregateLineProfitSums()` |
| Default chart of accounts                | `controllers/user.js`                                          |
| Company default account IDs              | `models/company.js`                                            |
| Frontend income statement                | `brands/ai-pos/src/features/incomeStatement/`                  |
| Frontend balance sheet                   | `brands/ai-pos/src/features/balanceSheet/`                     |

---

## 11. Related endpoints (curl examples)

Replace `{BASE}` with e.g. `https://host/pos_admin/api` and add `Authorization: Bearer {token}`.

```http
GET {BASE}/order/profit-by-order-item?from=2026-06-01&to=2026-06-30
GET {BASE}/sales_return/profit-by-sales-return-item?from=2026-06-01&to=2026-06-30
GET {BASE}/account/default-discount-sums
GET {BASE}/account/fetch-account-by-type?account_type=operating_expense
GET {BASE}/account/fetch-account-by-type?account_type=other_expense
GET {BASE}/order/sales?from=2026-06-01&to=2026-06-30
GET {BASE}/order_item/cost-of-goods-sold-by-order-item?from=2026-06-01&to=2026-06-30
GET {BASE}/reports/income-statement?startDate=2026-06-01&endDate=2026-06-30
```

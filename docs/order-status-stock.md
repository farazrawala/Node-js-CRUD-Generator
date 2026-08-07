# Order status & stock (in / out)

Source of truth: `models/order.js`  
Applied on status change by: `applyOrderStatusStockTransition` in `controllers/order.js` (e.g. `PATCH|POST /api/order/update-status/:id`).

Stock is adjusted on **`warehouse_inventory`** and **`inventory_movements`** only when the status **stock effect** changes (IN ↔ OUT). Same effect → no stock movement.

---

## 1. `ORDER_STATUS_VALUES` (Mongoose enum)

Allowed values for `order.order_status`, with stock effect:

| Status | Typical meaning | Stock |
|--------|-----------------|-------|
| `active` | Live / open POS-style order | **out** |
| `placed` | Order placed | **out** |
| `confirmed` | Confirmed for fulfillment | **out** |
| `duplicate` | Marked duplicate | **in** |
| `packed` | Packed | **out** |
| `delivered` | Delivered | **out** |
| `draft` | Draft / not finalized | **in** |
| `pending` | Pending | **out** |
| `pending_payment` | Received, payment not started (unpaid) | **out** |
| `on_hold` | Awaiting payment confirmation (e.g. bank transfer) | **in** |
| `cancelled` | Cancelled by admin or customer | **in** |
| `failed` | Payment failed or declined | **in** |
| `processing` | Payment received, awaiting fulfillment | **out** |
| `return` | Return in progress / recorded | **in** |
| `return_received` | Return received | **in** |

Export: `Order.ORDER_STATUS_VALUES` / `require("../models/order").ORDER_STATUS_VALUES`.

---

## 2. Stock effect map (`ORDER_STATUS_STOCK`)

| Effect | Movement | Enum statuses |
|--------|----------|---------------|
| **out** | Deduct stock (`movement_type: "out"`) | `active`, `placed`, `confirmed`, `packed`, `delivered`, `pending`, `pending_payment`, `processing` |
| **in** | Hold / restore stock (no sale deduction; restore on cancel etc.) | `duplicate`, `draft`, `on_hold`, `cancelled`, `failed`, `return`, `return_received` |

```text
ORDER_STATUS_STOCK.out  → stock deducted
ORDER_STATUS_STOCK.in   → stock not deducted / restored on transition from out
```

### Quick reference (enum only)

```text
active            → out
placed            → out
confirmed         → out
duplicate         → in
packed            → out
delivered         → out
draft             → in
pending           → out
pending_payment   → out
on_hold           → in
cancelled         → in
failed            → in
processing        → out
return            → in
return_received   → in
```

### Statuses outside the enum but used for stock

These appear in `ORDER_STATUS_STOCK` (and website imports) even when not in `ORDER_STATUS_VALUES`:

- **out:** `shipped`, `completed`
- **in:** `refunded`

---

## 3. Transition rules

Helpers (also on `Order` model):

| Helper | Returns |
|--------|---------|
| `getOrderStatusStockEffect(status)` | `"out"` \| `"in"` \| `null` |
| `getOrderStatusStockAction(fromStatus, toStatus)` | `"out"` \| `"in"` \| `"none"` |

Rules:

1. If `toStatus` has no known effect → **`none`** (no stock change).
2. Missing / unknown `fromStatus` is treated as **`in`** (so create / first commit to an **out** status deducts stock).
3. If from-effect === to-effect → **`none`**.
4. Otherwise action = **to** effect:
   - **IN → OUT** → deduct (`out`)
   - **OUT → IN** → restore (`in`)

### Examples

| From | To | Action |
|------|-----|--------|
| *(new / empty)* | `placed` | `out` |
| `draft` | `processing` | `out` |
| `confirmed` | `delivered` | `none` (both out) |
| `placed` | `cancelled` | `in` (restore) |
| `cancelled` | `on_hold` | `none` (both in) |
| `pending` | `draft` | `in` (restore; pending is out) |
| `packed` | `duplicate` | `in` (restore) |
| `delivered` | `return_received` | `in` (restore) |

---

## 4. Lifecycle groups (`ORDER_STATUS_GROUPS`)

Not enforced by Mongoose. Used via `Order.classifyOrderStatus(status)` → `draftLike` | `open` | `fulfillment` | `terminal` | `unknown`.

| Group | Statuses |
|-------|----------|
| `draftLike` | `drafted`, `draft`, `checkout_draft` |
| `open` | `active`, `placed`, `confirmed`, `pending`, `pending_payment`, `on_hold`, `processing` |
| `fulfillment` | `packed`, `shipped`, `delivered` |
| `terminal` | `completed`, `cancelled`, `refunded`, `failed` |

---

## 5. Website / import statuses

`ORDER_WEBSITE_STATUS_VALUES` holds Shopify / WooCommerce import slugs (e.g. `on-hold`, `checkout-draft`, `paid`, `fulfilled`). These are **not** the same list as `ORDER_STATUS_VALUES`; map them into POS statuses before relying on stock helpers.

---

## 6. Related code

| Piece | Location |
|-------|----------|
| Constants + helpers | `models/order.js` |
| Apply stock on status change | `controllers/order.js` → `applyOrderStatusStockTransition` |
| Status update API | `/api/order/update-status/:id` |
| Broader inventory guide | `docs/stock-inventory-management.md` |

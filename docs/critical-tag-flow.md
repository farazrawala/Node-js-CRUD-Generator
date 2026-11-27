# Critical tag flow

Source of truth: `Order.shouldMarkCritical` and `Order.isCriticalStatus` in `models/order.js`.

The `critical` tag is an order tag. It is added or removed automatically. It is not typed in by hand during a status change.

---

## 1. When an order is critical

All three of these must be true:

1. The order has a live tracking number (`courier_tracking_number` or `tracking_number`).
2. `tracking_status` does not contain "cancel" (a cancelled CN is not a live shipment).
3. `order_status` or `tracking_status` is one of: `return`, `returned`, `pending`, `cancelled`, `canceled`.

Spaces and hyphens are treated as underscores, so `Return` and `returned` both match.

If any check fails, the tag is removed.

`pending_payment` is not critical. Only the exact key `pending` is.

---

## 2. Where it is applied

### Status update

`order_update_status` in `controllers/order.js` runs `shouldMarkCritical` with the new `order_status` and the order's current tracking number and tracking status.

- Critical: `$addToSet` `critical` on `tags`.
- Not critical: `$pullAll` `critical`.

### Courier tracking fetch

`persistOrderTracking` in `src/services/CourierService.js` runs the same check after each Flaship, Leopard, TCS, and Trax scan.

It uses the status about to be saved (new order status if the scan changed it, otherwise the current one) and the latest tracking status.

- Critical: a second update `$addToSet`s `critical`. `$addToSet` and `$pullAll` cannot both target `tags` in one Mongo update.
- Not critical: `critical` is pulled off with the other tag cleanups from that scan.

A scan that does not change the booking status still re-evaluates the tag.

### Manual resync

`POST /api/order/sync-critical-tag`  
`POST /api/order/sync-critical-tag/:id`

Implemented by `order_sync_critical_tag` in `controllers/order.js`.

- With an id, or `order_ids` / `ids` in the body: only those orders.
- With no id: every order that is not deleted.

Each order is marked, unmarked, or left unchanged. The response returns `checked`, `marked`, and `unmarked`. Selected orders also return a per-order `action`.

---

## 3. Flow

```text
status change or courier scan or sync-critical-tag
        |
        v
tracking number present?
        | no
        +----> remove critical
        | yes
        v
tracking_status contains "cancel"?
        | yes
        +----> remove critical
        | no
        v
order_status or tracking_status is
return / returned / pending / cancelled / canceled?
        | no
        +----> remove critical
        | yes
        v
add critical (only if it is not already on the order)
```

---

## 4. Examples

| Tracking number | Order status | Tracking status | Tag |
|-----------------|--------------|-----------------|-----|
| empty | return | Returned | off |
| CN-100 | delivered | Delivered | off |
| CN-100 | return | Returned | on |
| CN-100 | in_transit | Pending | on |
| CN-100 | cancelled | Cancelled | off (cancelled CN) |
| CN-100 | pending | Booked | on |

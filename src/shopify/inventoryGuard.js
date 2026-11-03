/**
 * Stop Shopify webhooks from applying the quantity we just pushed.
 * When inventory direction is POS-led, OrdersHub stays the source of truth.
 * @module src/shopify/inventoryGuard
 */

const ECHO_WINDOW_MS = 3 * 60 * 1000;

function shouldApplyRemoteInventory({
  direction,
  incomingQty,
  lastPushedQty,
  lastPushedAt,
  now = Date.now(),
} = {}) {
  if (direction === "pos_to_shopify") {
    return { apply: false, reason: "pos_is_source_of_truth" };
  }
  if (lastPushedQty != null && Number(incomingQty) === Number(lastPushedQty)) {
    const pushedAt = new Date(lastPushedAt || 0).getTime();
    const age = now - pushedAt;
    if (age >= 0 && age < ECHO_WINDOW_MS) {
      return { apply: false, reason: "echo_suppressed" };
    }
  }
  return { apply: true, reason: "apply" };
}

module.exports = {
  ECHO_WINDOW_MS,
  shouldApplyRemoteInventory,
};

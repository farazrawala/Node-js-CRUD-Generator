const ProcessModel = require("../models/process");
const { coalesceObjectId } = require("./modelHelper");
const { enqueueProcess } = require("./processQueue");
const {
  findIntegrationIfActive,
  logIntegrationInactiveSkip,
} = require("./integrationActiveGuard");
const { resolveRemoteOrderIdFromPosOrder } = require("./processHelpers");

const PUSH_ORDER_STORE_TYPES = new Set(["shopify", "woocommerce"]);
const TRACKING_PUSH_STORE_TYPES = new Set(["shopify", "woocommerce"]);
const WOO_TRACKING_PUSH_STORE_TYPES = new Set(["woocommerce"]);

const TRACKING_QUEUE_FIELDS = [
  "courier_tracking_number",
  "tracking_status",
  "courier_id",
];

/**
 * Orders imported via fetch_order from Shopify/WooCommerce use order_type "website"
 * and carry integration_id + integration_order_id.
 */
function isWebsiteIntegrationOrder(order) {
  const integrationId = coalesceObjectId(order?.integration_id);
  if (!integrationId) return false;
  const orderType = String(order?.order_type || "").trim().toLowerCase();
  return orderType === "website";
}

function normalizeTrackingField(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "object" && value._id) {
    return String(value._id);
  }
  return String(value).trim();
}

function orderTrackingFieldsChanged(beforeOrder, afterOrder) {
  if (!afterOrder) {
    return false;
  }
  const before = beforeOrder || {};
  for (const field of TRACKING_QUEUE_FIELDS) {
    if (
      normalizeTrackingField(before[field]) !==
      normalizeTrackingField(afterOrder[field])
    ) {
      return true;
    }
  }
  return false;
}

async function createPushOrderProcess({
  order,
  companyId,
  createdBy,
  action,
  remarks,
  priority = 50,
}) {
  const orderId = coalesceObjectId(order?._id);
  const company_id = coalesceObjectId(companyId || order?.company_id);
  const integration_id = coalesceObjectId(order?.integration_id);

  if (!orderId || !company_id) {
    return { queued: false, reason: "missing_ids" };
  }

  if (!isWebsiteIntegrationOrder(order)) {
    return { queued: false, reason: "not_website_integration_order" };
  }

  const integration = await findIntegrationIfActive(integration_id, company_id);
  if (!integration) {
    await logIntegrationInactiveSkip(null, {
      action,
      integrationId: integration_id,
      companyId: company_id,
      createdBy: coalesceObjectId(createdBy),
      message: `Skipped ${action} queue: integration is inactive`,
      extra: {
        source: "orderPushQueue",
        order_id: String(orderId),
      },
    });
    return { queued: false, reason: "integration_inactive" };
  }

  const storeType = String(integration.store_type || "").trim().toLowerCase();
  if (!PUSH_ORDER_STORE_TYPES.has(storeType)) {
    return {
      queued: false,
      reason: "unsupported_store_type",
      store_type: storeType || null,
    };
  }

  const remoteId = resolveRemoteOrderIdFromPosOrder(order, storeType);
  if (!remoteId) {
    return { queued: false, reason: "no_remote_order_ref" };
  }

  const doc = await ProcessModel.create({
    integration_id,
    order_id: orderId,
    action,
    company_id,
    created_by: coalesceObjectId(createdBy),
    status: "active",
    progress: "not_started",
    priority: Number(priority) || 50,
    limit: 1,
    page: 1,
    offset: 0,
    count: 0,
    hits: 0,
    remarks,
  });

  const queueResult = await enqueueProcess(doc);

  return {
    queued: Boolean(queueResult?.queued),
    process_id: doc._id,
    integration_id,
    order_id: orderId,
    action,
    backend: queueResult?.backend || null,
  };
}

/**
 * Queue a push_order process job so POS status changes sync back to the store.
 */
async function enqueuePushOrderJob({
  order,
  companyId,
  createdBy = null,
  remarks = "Auto-queued push_order after order status update",
  priority = 50,
}) {
  return createPushOrderProcess({
    order,
    companyId,
    createdBy,
    action: "push_order",
    remarks,
    priority,
  });
}

/**
 * Queue push_order_tracking when courier / tracking fields change on a website order.
 */
async function enqueuePushOrderTrackingJob({
  order,
  companyId,
  createdBy = null,
  remarks = "Auto-queued push_order_tracking after tracking update",
  priority = 50,
}) {
  return createPushOrderProcess({
    order,
    companyId,
    createdBy,
    action: "push_order_tracking",
    remarks,
    priority,
  });
}

/**
 * Queue tracking push only when courier / tracking fields changed.
 */
async function maybeEnqueuePushOrderTrackingJob({
  beforeOrder,
  afterOrder,
  companyId,
  createdBy = null,
  remarks = "Auto-queued push_order_tracking after tracking update",
  priority = 50,
}) {
  if (!orderTrackingFieldsChanged(beforeOrder, afterOrder)) {
    return { queued: false, reason: "no_tracking_change" };
  }

  return enqueuePushOrderTrackingJob({
    order: afterOrder,
    companyId,
    createdBy,
    remarks,
    priority,
  });
}

/**
 * After courier tracking API: queue push_order_tracking for website orders (Shopify + WooCommerce).
 */
async function enqueuePushOrderTrackingForWebsiteOrder({
  orderId,
  companyId,
  createdBy = null,
  remarks = "Auto push_order_tracking after GET /courier/order/:orderId/tracking",
  priority = 50,
  shipment = null,
}) {
  const Order = require("../models/order");
  const order_id = coalesceObjectId(orderId);
  const company_id = coalesceObjectId(companyId);

  if (!order_id) {
    return { queued: false, reason: "missing_order_id" };
  }

  const filter = {
    _id: order_id,
    deletedAt: null,
  };
  if (company_id) {
    filter.company_id = company_id;
  }

  let order = await Order.findOne(filter)
    .populate({ path: "courier_id", select: "name type" })
    .lean();

  if (!order) {
    return { queued: false, reason: "order_not_found" };
  }

  const trackingNumber = String(shipment?.tracking_number || "").trim();
  if (trackingNumber && trackingNumber !== String(order.courier_tracking_number || "").trim()) {
    order = await Order.findByIdAndUpdate(
      order_id,
      { $set: { courier_tracking_number: trackingNumber } },
      { new: true },
    )
      .populate({ path: "courier_id", select: "name type" })
      .lean();
  }

  if (!isWebsiteIntegrationOrder(order)) {
    return { queued: false, reason: "not_website_integration_order" };
  }

  const integration_id = coalesceObjectId(order.integration_id);
  const integration = await findIntegrationIfActive(
    integration_id,
    order.company_id,
  );
  if (!integration) {
    return { queued: false, reason: "integration_inactive" };
  }

  const storeType = String(integration.store_type || "").trim().toLowerCase();
  if (!TRACKING_PUSH_STORE_TYPES.has(storeType)) {
    return {
      queued: false,
      reason: "unsupported_store_type",
      store_type: storeType || null,
    };
  }

  return enqueuePushOrderTrackingJob({
    order,
    companyId: order.company_id,
    createdBy,
    remarks,
    priority,
  });
}

module.exports = {
  isWebsiteIntegrationOrder,
  orderTrackingFieldsChanged,
  enqueuePushOrderJob,
  enqueuePushOrderTrackingJob,
  maybeEnqueuePushOrderTrackingJob,
  enqueuePushOrderTrackingForWebsiteOrder,
  /** @deprecated use enqueuePushOrderTrackingForWebsiteOrder */
  enqueuePushOrderTrackingForWooCommerceOrder: enqueuePushOrderTrackingForWebsiteOrder,
};

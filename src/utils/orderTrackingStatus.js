function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTrackingStatusFilter(value) {
  const requestedStatus = String(value || "")
    .trim()
    .replace(/^\s*(?:shipment|shipper)\s*[-:–]\s*/i, "");
  if (!requestedStatus) return {};

  const isInTransit = /^in[\s_-]*transit$/i.test(requestedStatus);
  const trackingStatusRegex = isInTransit
    ? /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:in[\s_-]*transit|transit|dispatched|departed|on[\s_-]*route)$/i
    : new RegExp(
        `^(?:(?:shipment|shipper)\\s*[-:–]\\s*)?${escapeRegex(requestedStatus)}$`,
        "i",
      );

  if (isInTransit) {
    return {
      $or: [
        { tracking_status: trackingStatusRegex },
        { order_status: /^in[\s_-]*transit$/i },
      ],
    };
  }

  return { tracking_status: trackingStatusRegex };
}

function isStoredInTransitTrackingStatus(value) {
  return /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:in[\s_-]*transit|transit|dispatched|departed|on[\s_-]*route)$/i.test(
    String(value || "").trim(),
  );
}

async function findStuckInTransitOrderIds({
  CourierTracking,
  CourierShipment,
  companyId,
  days,
  now = Date.now(),
}) {
  if (!CourierTracking || !CourierShipment) {
    throw new Error("Courier tracking models are unavailable");
  }

  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const shipmentIds = await CourierTracking.distinct("shipment_id", {
    company_id: companyId,
    status: "In Transit",
    event_time: { $lte: cutoff },
  });
  if (!shipmentIds.length) return [];

  return CourierShipment.distinct("order_id", {
    _id: { $in: shipmentIds },
    company_id: companyId,
    deletedAt: null,
    tracking_number: { $nin: [null, ""] },
    shipment_status: { $nin: ["Cancelled", "Failed"] },
  });
}

module.exports = {
  buildTrackingStatusFilter,
  findStuckInTransitOrderIds,
  isStoredInTransitTrackingStatus,
};

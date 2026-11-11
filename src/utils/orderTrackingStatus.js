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

module.exports = {
  buildTrackingStatusFilter,
  isStoredInTransitTrackingStatus,
};

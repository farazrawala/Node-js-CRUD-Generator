function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTrackingStatusFilter(value) {
  const requestedStatus = String(value || "")
    .trim()
    .replace(/^\s*(?:shipment|shipper)\s*[-:–]\s*/i, "");
  if (!requestedStatus) return {};

  const isReturnInTransit = isReturnInTransitStatus(requestedStatus);
  const isInTransit =
    !isReturnInTransit && /^in[\s_-]*transit$/i.test(requestedStatus);
  const isShipperAdvise = /^shipper[\s_-]*advi[cs]e(?:[\s_-]*requested)?$/i.test(
    requestedStatus,
  );
  const isReattempt = /^re[\s_-]*attempt(?:[\s_-]*call(?:[\s_-]*requested)?)?$/i.test(
    requestedStatus,
  );
  const trackingStatusRegex = isReturnInTransit
    ? returnInTransitStatusPattern()
    : isInTransit
    ? /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:in[\s_-]*transit|transit|dispatched|departed|on[\s_-]*route)$/i
    : isShipperAdvise
      ? /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:shipper[\s_-]*advi[cs]e(?:[\s_-]*requested)?)$/i
      : isReattempt
        ? /^(?:(?:shipment|shipper)\s*[-:–]\s*)?re[\s_-]*attempt(?:[\s_-]*call(?:[\s_-]*requested)?)?(?:\s*[-—–:].*)?$/i
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

/** OMS tiles that match the saved exact_courier_status label. */
function buildExactCourierStatusFilter(value) {
  const requestedStatus = String(value || "").trim();
  if (!requestedStatus) return {};
  const pattern = /^in[\s_-]*transit$/i.test(requestedStatus)
    ? /^in[\s_-]*transit$/i
    : /^out[\s_-]*for[\s_-]*delivery$/i.test(requestedStatus)
      ? /^out[\s_-]*for[\s_-]*delivery$/i
      : /^exception$/i.test(requestedStatus)
        ? /^(?:(?:courier|shipment|shipper)\s*[-:–]\s*)?exception$/i
        : new RegExp(`^${escapeRegex(requestedStatus)}$`, "i");
  return { exact_courier_status: pattern };
}

/** OMS Returned tile: POS return, store refunded/returned, and courier return scans. */
function buildOrderStatusFilter(raw) {
  const value = String(raw || "").trim();
  if (!value) return {};
  const key = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (key === "return" || key === "returned" || key === "refunded") {
    return {
      $or: [
        { order_status: /^(?:return|returned|refunded)$/i },
        { order_website_status: /^(?:returned|refunded)$/i },
        { tracking_status: returnInTransitStatusPattern() },
        {
          tracking_status:
            /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:returned|rto(?:[\s_-]*received)?|return(?:ed)?(?:[\s_-]+to[\s_-]+(?:shipper|origin|sender))?)$/i,
        },
      ],
    };
  }
  if (key === "return_received" || key === "rto_received") {
    return { order_status: /^(?:return_received|rto_received)$/i };
  }
  return {
    order_status: new RegExp(`^${escapeRegex(value)}$`, "i"),
  };
}

function isReturnFamilyStatusKey(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return key === "return" || key === "returned" || key === "refunded";
}

function isReturnInTransitStatus(value) {
  const text = String(value || "")
    .trim()
    .replace(/^\s*(?:shipment|shipper)\s*[-:–]\s*/i, "");
  return /^return[\s_-]*in[\s_-]*transit$/i.test(text);
}

function returnInTransitStatusPattern() {
  return /^(?:(?:shipment|shipper)\s*[-:–]\s*)?return[\s_-]*in[\s_-]*transit$/i;
}

function isStoredReturnInTransitTrackingStatus(value) {
  return returnInTransitStatusPattern().test(String(value || "").trim());
}

function isStoredInTransitTrackingStatus(value) {
  const text = String(value || "").trim();
  if (isStoredReturnInTransitTrackingStatus(text)) return false;
  return /^(?:(?:shipment|shipper)\s*[-:–]\s*)?(?:in[\s_-]*transit|transit|dispatched|departed|on[\s_-]*route)$/i.test(
    text,
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
  buildOrderStatusFilter,
  buildTrackingStatusFilter,
  buildExactCourierStatusFilter,
  findStuckInTransitOrderIds,
  isReturnFamilyStatusKey,
  isStoredInTransitTrackingStatus,
  isStoredReturnInTransitTrackingStatus,
};

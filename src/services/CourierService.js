/**
 * CourierService — single entry for createShipment / tracking / cancel / label.
 * Controller and other modules must NOT know which provider is used.
 * @module src/services/CourierService
 */

const mongoose = require("mongoose");
const CourierFactory = require("../couriers/CourierFactory");
const {
  UNIFIED_STATUSES,
  TERMINAL_STATUSES,
  normalizeProviderKey,
} = require("../couriers/constants");
const {
  CourierError,
  alreadyShipped,
  shipmentNotFound,
  configMissing,
  providerUnavailable,
  invalidCredentials,
  fromProviderMessage,
} = require("../couriers/errors");
const { loadOrderContext } = require("../utils/orderContextLoader");
const {
  decryptProviderSecrets,
} = require("../utils/encryptCredentials");
const courierLogger = require("../utils/courierLogger");
const { enqueueJob, isQueueEnabled } = require("../../utils/redisQueue");

const CourierProvider = require("../models/courier_provider.model");
const CourierShipment = require("../models/courier_shipment.model");
const CourierTracking = require("../models/courier_tracking.model");

/** Public track page for known Pakistani couriers. */
function buildPublicCourierTrackingUrl(provider, trackingId) {
  const id = trackingId != null ? String(trackingId).trim() : "";
  if (!id) return "";
  const key = String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (key === "tcs") {
    return `https://www.tcsexpress.com/track/?consignmentNo=${encodeURIComponent(id)}`;
  }
  if (key === "leopard" || key === "leopards" || key === "lcs") {
    return `https://www.leopardscourier.com/tracking/?cn=${encodeURIComponent(id)}`;
  }
  if (key === "blueex") {
    return `https://www.blue-ex.com/tracking?cn=${encodeURIComponent(id)}`;
  }
  if (key === "m&p" || key === "mnp" || key === "mp") {
    return `https://www.mulphilog.com/tracking/${encodeURIComponent(id)}`;
  }
  if (key === "callcourier") {
    return `https://callcourier.com.pk/tracking/?tc=${encodeURIComponent(id)}`;
  }
  if (key === "trax") {
    return `https://sonic.pk/tracking?tracking_number=${encodeURIComponent(id)}`;
  }
  return "";
}

/**
 * Map a legacy `courier` CRUD row into provider driver config.
 * @param {object} legacy
 * @param {string} providerKey
 */
function mapLegacyCourierToConfig(legacy, providerKey) {
  const settings = {
    ...(legacy.settings && typeof legacy.settings === "object" ? legacy.settings : {}),
  };
  const token = legacy.token || settings.token || settings.bearer_token || null;
  if (token && !settings.bearer_token) {
    settings.bearer_token = token;
  }
  if (token && !settings.token) {
    settings.token = token;
  }

  return {
    company_id: legacy.company_id,
    provider: providerKey,
    enabled: true,
    username: legacy.login,
    password: legacy.password,
    token: token || null,
    base_url: legacy.url,
    sandbox:
      legacy.sandbox ??
      /devconnect|staging|sandbox|uat/i.test(String(legacy.url || "")),
    api_key: settings.api_key || null,
    secret: settings.secret || null,
    account_no: legacy.account_no || settings.account_no || null,
    pickup_location:
      legacy.cost_center ||
      legacy.pickup_location ||
      settings.costcentercode ||
      settings.cost_center ||
      settings.pickup_location ||
      null,
    service_type: legacy.service_type || settings.service_type || null,
    settings: {
      ...settings,
      costcentercode:
        settings.costcentercode ||
        legacy.cost_center ||
        settings.cost_center ||
        legacy.pickup_location ||
        null,
    },
    _legacy: true,
    _legacy_id: legacy._id,
  };
}

/**
 * Load enabled provider config for company + provider key.
 * Falls back to legacy `courier` model when courier_provider row is missing.
 * @param {string|import('mongoose').Types.ObjectId} companyId
 * @param {string} providerKey
 * @param {string} [courierId] optional specific legacy courier integration id
 */
async function loadProviderConfig(companyId, providerKey, courierId = null) {
  const key = normalizeProviderKey(providerKey) || providerKey;

  // Prefer an explicitly selected Courier Integration row.
  if (courierId) {
    try {
      const LegacyCourier = mongoose.model("courier");
      const legacy = await LegacyCourier.findOne({
        _id: courierId,
        company_id: companyId,
        status: "active",
        deletedAt: null,
      }).lean();
      if (legacy) {
        const fromType =
          String(legacy.type || "").toLowerCase().includes("leopard")
            ? "Leopard"
            : String(legacy.type || "").toLowerCase().includes("tcs")
              ? "TCS"
              : key;
        return mapLegacyCourierToConfig(
          legacy,
          normalizeProviderKey(fromType) || key,
        );
      }
    } catch {
      /* legacy model may be absent */
    }
  }

  let config = await CourierProvider.findOne({
    company_id: companyId,
    provider: key,
    enabled: true,
    deletedAt: null,
  }).lean();

  if (config) {
    const settings =
      config.settings && typeof config.settings === "object" ? { ...config.settings } : {};
    const token = config.token || settings.token || settings.bearer_token || null;
    if (token) {
      settings.bearer_token = settings.bearer_token || token;
      settings.token = settings.token || token;
    }
    return { ...config, token: token || null, settings };
  }

  // Legacy admin CRUD model: models/courier.js (type: tcs|leopard)
  try {
    const LegacyCourier = mongoose.model("courier");
    const legacyType =
      String(key).toLowerCase().includes("leopard") ? "leopard"
      : String(key).toLowerCase().includes("tcs") ? "tcs"
      : String(key).toLowerCase();

    const legacy = await LegacyCourier.findOne({
      company_id: companyId,
      type: legacyType,
      status: "active",
      deletedAt: null,
    }).lean();

    if (legacy) {
      return mapLegacyCourierToConfig(legacy, key);
    }
  } catch {
    /* legacy model may be absent in tests */
  }

  return null;
}

/**
 * @param {object} company
 * @param {string} [providerOverride]
 * @param {string} [courierId]
 */
async function resolveDriver(company, providerOverride, courierId = null) {
  let providerKey =
    normalizeProviderKey(providerOverride) ||
    CourierFactory.resolvePreferredProvider(company);

  const config = await loadProviderConfig(company._id, providerKey, courierId);
  if (!config) {
    throw configMissing(providerKey, company._id);
  }
  providerKey = normalizeProviderKey(config.provider) || providerKey;
  return {
    driver: CourierFactory.get(company, config, providerKey),
    providerKey,
    config,
  };
}

/**
 * Create a courier shipment for an order. Only orderId is required from callers.
 * @param {string} orderId
 * @param {object} [options]
 * @param {string} [options.companyId]
 * @param {string} [options.provider] override preferred courier
 * @param {string} [options.courierId] specific Courier Integration row
 * @param {string} [options.userId]
 * @param {boolean} [options.async] queue when true / provider down
 * @returns {Promise<object>}
 */
async function createShipment(orderId, options = {}) {
  const order = await loadOrderContext(orderId, {
    companyId: options.companyId,
  });
  const company = order.company;
  if (!company?._id) {
    throw new CourierError("Order company not found", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  const existing = await CourierShipment.findOne({
    order_id: order._id,
    company_id: company._id,
    deletedAt: null,
    shipment_status: { $nin: [UNIFIED_STATUSES.CANCELLED, UNIFIED_STATUSES.FAILED] },
    tracking_number: { $nin: [null, ""] },
  })
    .sort({ created_at: -1 })
    .lean();

  if (existing) {
    throw alreadyShipped(orderId, existing.tracking_number);
  }

  let driver;
  let providerKey;
  let config;
  try {
    ({ driver, providerKey, config } = await resolveDriver(
      company,
      options.provider,
      options.courierId,
    ));
  } catch (err) {
    if (options.async || options.queueOnUnavailable) {
      return enqueueShipmentCreation(order, options, err);
    }
    throw err;
  }

  try {
    const healthy = await driver.healthCheck();
    if (!healthy?.ok) {
      // Auth/config failures should surface immediately — do not book or silently queue.
      const msg = healthy?.message || `Courier provider unavailable: ${providerKey}`;
      if (/credential|unauthor|auth/i.test(msg)) {
        throw invalidCredentials(providerKey, msg);
      }
      if (options.async || options.queueOnUnavailable) {
        return enqueueShipmentCreation(order, options, healthy);
      }
      throw providerUnavailable(providerKey, { message: msg });
    }

    const result = await driver.createShipment(order);

    const shipment = await CourierShipment.create({
      company_id: company._id,
      order_id: order._id,
      courier: providerKey,
      tracking_number: result.trackingNumber,
      booking_reference: result.bookingReference,
      shipment_status: result.status || UNIFIED_STATUSES.BOOKED,
      status_code: result.statusCode,
      label_url: result.labelUrl,
      cod_amount: result.codAmount ?? order.codAmount,
      weight: result.weight ?? order.weightKg,
      pieces: result.pieces ?? order.pieces,
      api_request: result.request,
      api_response: result.response,
      last_tracking_sync: null,
      created_by: options.userId || null,
    });

    await appendTrackingEvent({
      shipment,
      trackingNumber: result.trackingNumber,
      status: result.status || UNIFIED_STATUSES.BOOKED,
      description: result.message || "Shipment booked",
      location: null,
      eventTime: new Date(),
      raw: result.response,
    });

    try {
      const courierRef =
        options.courierId || config?._legacy_id || config?._id || null;
      const orderUpdate = {
        order_status: "shipped",
        courier_tracking_number: String(result.trackingNumber || ""),
      };
      if (courierRef) {
        orderUpdate.courier_id = courierRef;
      }
      await mongoose.model("order").findByIdAndUpdate(order._id, orderUpdate);
    } catch {
      /* non-fatal */
    }

    return {
      success: true,
      shipment,
      tracking_number: result.trackingNumber,
      tracking_id: result.trackingNumber,
      tracking_url:
        result.labelUrl ||
        buildPublicCourierTrackingUrl(providerKey, result.trackingNumber) ||
        null,
      courier: providerKey,
      status: result.status,
    };
  } catch (err) {
    courierLogger.bookingFailed({
      provider: providerKey,
      orderId: String(orderId),
      orderNo: order.order_no || null,
      error: err.message,
      code: err.code,
      retryable: Boolean(err.retryable),
      details: err.details || null,
    });

    if (err.retryable && (options.async || options.queueOnUnavailable)) {
      return enqueueShipmentCreation(order, options, err);
    }

    await CourierShipment.create({
      company_id: company._id,
      order_id: order._id,
      courier: providerKey,
      shipment_status: UNIFIED_STATUSES.FAILED,
      api_request: err.details?.request || null,
      api_response: err.details?.response || err.details || { message: err.message },
      error_message: err.message,
      created_by: options.userId || null,
    }).catch(() => {});

    throw err instanceof CourierError ? err : fromProviderMessage(err.message, {
      provider: providerKey,
    });
  }
}

async function enqueueShipmentCreation(order, options, reason) {
  const companyId = String(order.company_id || order.company?._id);
  courierLogger.log("warn", "shipment_queued", {
    orderId: String(order._id),
    reason: reason?.message || reason,
  });

  if (isQueueEnabled()) {
    // Job id encodes payload; a courier queue worker can parse create:<orderId>.
    await enqueueJob(
      companyId,
      "courier",
      `create:${order._id}`,
      { priority: 50 },
    );
  }

  return {
    success: true,
    queued: true,
    message: "Shipment creation queued — provider temporarily unavailable",
    order_id: order._id,
  };
}

/**
 * @param {string} orderId
 * @param {object} [options]
 */
async function getTracking(orderId, options = {}) {
  const shipment = await CourierShipment.findOne({
    order_id: orderId,
    deletedAt: null,
    ...(options.companyId ? { company_id: options.companyId } : {}),
  })
    .sort({ created_at: -1 })
    .lean();

  if (!shipment) throw shipmentNotFound(`order:${orderId}`);

  return refreshTrackingForShipment(shipment, options);
}

/**
 * @param {string} trackingNumber
 * @param {object} [options]
 */
async function getTrackingByTrackingNumber(trackingNumber, options = {}) {
  const shipment = await CourierShipment.findOne({
    tracking_number: String(trackingNumber),
    deletedAt: null,
    ...(options.companyId ? { company_id: options.companyId } : {}),
  })
    .sort({ created_at: -1 })
    .lean();

  if (!shipment) {
    // Attempt detect provider from company preferred + live API is not possible
    // without company — require existing shipment row.
    throw shipmentNotFound(trackingNumber);
  }

  return refreshTrackingForShipment(shipment, options);
}

/**
 * @param {object} shipment
 * @param {object} [options]
 */
async function refreshTrackingForShipment(shipment, options = {}) {
  const Company = mongoose.model("company");
  const company = await Company.findById(shipment.company_id).lean();
  if (!company) {
    throw new CourierError("Company not found for shipment", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  const { driver } = await resolveDriver(company, shipment.courier);
  const result = await driver.getTracking(shipment.tracking_number);

  for (const event of result.events || []) {
    await appendTrackingEvent({
      shipment,
      trackingNumber: shipment.tracking_number,
      status: event.status,
      description: event.description,
      location: event.location,
      eventTime: event.eventTime,
      raw: event.raw,
    });
  }

  await CourierShipment.updateOne(
    { _id: shipment._id },
    {
      $set: {
        shipment_status: result.status || shipment.shipment_status,
        status_code: result.statusCode || shipment.status_code,
        last_tracking_sync: new Date(),
      },
    },
  );

  const history = await CourierTracking.find({ shipment_id: shipment._id })
    .sort({ event_time: -1, created_at: -1 })
    .lean();

  return {
    success: true,
    order_id: shipment.order_id,
    tracking_number: shipment.tracking_number,
    courier: shipment.courier,
    status: result.status,
    status_code: result.statusCode,
    history,
    raw: options.includeRaw ? result.raw : undefined,
  };
}

/**
 * Insert tracking history only when this event is new.
 */
async function appendTrackingEvent({
  shipment,
  trackingNumber,
  status,
  description,
  location,
  eventTime,
  raw,
}) {
  const eventTimeDate = eventTime ? new Date(eventTime) : null;
  const dupFilter = {
    shipment_id: shipment._id,
    status,
    description: description || null,
  };
  if (eventTimeDate && !Number.isNaN(eventTimeDate.getTime())) {
    dupFilter.event_time = eventTimeDate;
  }

  const exists = await CourierTracking.findOne(dupFilter).select("_id").lean();
  if (exists) return exists;

  return CourierTracking.create({
    shipment_id: shipment._id,
    company_id: shipment.company_id,
    tracking_number: trackingNumber,
    status,
    description: description || null,
    location: location || null,
    event_time: eventTimeDate,
    raw_response: raw || null,
  });
}

/**
 * @param {string} orderId
 * @param {object} [options]
 */
async function cancelShipment(orderId, options = {}) {
  const shipment = await CourierShipment.findOne({
    order_id: orderId,
    deletedAt: null,
    ...(options.companyId ? { company_id: options.companyId } : {}),
    shipment_status: { $nin: TERMINAL_STATUSES },
  })
    .sort({ created_at: -1 });

  if (!shipment) throw shipmentNotFound(`order:${orderId}`);

  const company = await mongoose.model("company").findById(shipment.company_id).lean();
  const { driver } = await resolveDriver(company, shipment.courier);
  const result = await driver.cancelShipment(shipment.toObject());

  shipment.shipment_status = UNIFIED_STATUSES.CANCELLED;
  shipment.api_response = result.raw || shipment.api_response;
  await shipment.save();

  await appendTrackingEvent({
    shipment,
    trackingNumber: shipment.tracking_number,
    status: UNIFIED_STATUSES.CANCELLED,
    description: "Shipment cancelled",
    location: null,
    eventTime: new Date(),
    raw: result.raw,
  });

  return { success: true, shipment };
}

/**
 * @param {string} orderId
 * @param {object} [options]
 */
async function printLabel(orderId, options = {}) {
  const shipment = await CourierShipment.findOne({
    order_id: orderId,
    deletedAt: null,
    ...(options.companyId ? { company_id: options.companyId } : {}),
  })
    .sort({ created_at: -1 });

  if (!shipment) throw shipmentNotFound(`order:${orderId}`);

  const company = await mongoose.model("company").findById(shipment.company_id).lean();
  const { driver } = await resolveDriver(company, shipment.courier);
  const result = await driver.printLabel(shipment.toObject(), {
    printtype: options.printtype,
    shipperDetails: options.shipperDetails,
    accounttype: options.accounttype,
  });

  if (result.labelUrl) {
    shipment.label_url = result.labelUrl;
    await shipment.save();
  }

  return {
    success: true,
    label_url: result.labelUrl || shipment.label_url || null,
    label_base64: result.labelBase64 || null,
    content_type: result.contentType || "application/pdf",
    tracking_number: shipment.tracking_number,
    printtype: result.printtype ?? options.printtype ?? null,
  };
}

/**
 * Sync open shipments (used by cron job).
 * @param {object} [options]
 * @param {number} [options.limit]
 */
async function syncOpenShipments(options = {}) {
  const limit = Number(options.limit) || 100;
  const open = await CourierShipment.find({
    deletedAt: null,
    tracking_number: { $nin: [null, ""] },
    shipment_status: { $nin: TERMINAL_STATUSES },
  })
    .sort({ last_tracking_sync: 1, created_at: 1 })
    .limit(limit)
    .lean();

  const summary = { total: open.length, updated: 0, errors: 0 };

  for (const shipment of open) {
    try {
      await refreshTrackingForShipment(shipment);
      summary.updated += 1;
    } catch (err) {
      summary.errors += 1;
      courierLogger.apiError({
        event: "sync_error",
        shipmentId: String(shipment._id),
        error: err.message,
      });
    }
  }

  return summary;
}

module.exports = {
  createShipment,
  getTracking,
  getTrackingByTrackingNumber,
  cancelShipment,
  printLabel,
  syncOpenShipments,
  loadProviderConfig,
  resolveDriver,
  appendTrackingEvent,
  decryptProviderSecrets,
};

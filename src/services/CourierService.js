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
  readCourierSandboxEnv,
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
  if (key === "postex" || key === "post-ex" || key === "postex.pk") {
    return `https://postex.pk/tracking?cn=${encodeURIComponent(id)}`;
  }
  if (
    key === "flagship" ||
    key === "flaship" ||
    key === "flag-ship" ||
    key === "flash-ip"
  ) {
    return `https://partners.flaship.pk`;
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

  const clientId =
    legacy.client_id ||
    settings.clientId ||
    settings.client_id ||
    settings.api_key ||
    null;
  const clientSecret =
    legacy.client_secret ||
    settings.clientSecret ||
    settings.client_secret ||
    settings.secret ||
    null;

  if (clientId) {
    settings.clientId = settings.clientId || clientId;
    settings.client_id = settings.client_id || clientId;
  }
  if (clientSecret) {
    settings.clientSecret = settings.clientSecret || clientSecret;
    settings.client_secret = settings.client_secret || clientSecret;
  }

  const isTokenAuth = /postex|flagship|flaship/i.test(String(providerKey));

  return {
    company_id: legacy.company_id,
    provider: providerKey,
    enabled: true,
    username: legacy.login,
    password: legacy.password,
    token: token || null,
    base_url: legacy.url,
    sandbox:
      (() => {
        const fromEnv = readCourierSandboxEnv();
        if (fromEnv != null) return fromEnv;
        if (legacy.sandbox === false || legacy.sandbox === "false") return false;
        if (legacy.sandbox === true || legacy.sandbox === "true") return true;
        return /devconnect|staging|sandbox|uat/i.test(String(legacy.url || ""));
      })(),
    api_key: clientId || settings.api_key || (isTokenAuth ? token : null) || null,
    secret: clientSecret || settings.secret || null,
    account_no: legacy.account_no || settings.account_no || null,
    pickup_location:
      legacy.cost_center ||
      legacy.pickup_location ||
      settings.pickuplocation ||
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
              : String(legacy.type || "").toLowerCase().includes("postex")
                ? "PostEx"
                : /flagship|flaship/.test(String(legacy.type || "").toLowerCase())
                  ? "Flagship"
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
      : String(key).toLowerCase().includes("postex") ? "postex"
      : /flagship|flaship/.test(String(key).toLowerCase()) ? "flagship"
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
      if (/credential|unauthor|auth|bearer token is missing/i.test(msg)) {
        // healthCheck often already returns a CourierError message — don't wrap twice
        if (msg.toLowerCase().startsWith("invalid api credentials")) {
          throw new CourierError(msg, {
            code: "INVALID_CREDENTIALS",
            httpStatus: 401,
          });
        }
        throw invalidCredentials(providerKey, msg);
      }
      if (options.async || options.queueOnUnavailable) {
        return enqueueShipmentCreation(order, options, healthy);
      }
      // Network blips: skip soft health-check and let createShipment report the real API error
      if (
        healthy?.retryable ||
        /fetch failed|timeout|ECONN|ENOTFOUND|network|socket/i.test(msg)
      ) {
        courierLogger.apiError({
          event: "health_check_skipped",
          provider: providerKey,
          message: msg,
        });
      } else {
        throw providerUnavailable(providerKey, { message: msg });
      }
    }

    order.bookingOptions = {
      courierCompany:
        options.courierCompany ||
        options.courier_company ||
        null,
      courierOption:
        options.courierOption ||
        options.courier_option ||
        null,
      pickuplocation:
        options.pickuplocation ||
        options.pickup_location ||
        null,
    };

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
        order_status: "packed",
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

  let result;
  try {
    result = await driver.getTracking(shipment.tracking_number);
  } catch (err) {
    courierLogger.apiError({
      event: "tracking_live_failed",
      provider: shipment.courier,
      trackingNumber: shipment.tracking_number,
      orderId: String(shipment.order_id || ""),
      error: err.message,
    });
    if (options.allowStale === false) throw err;
    return loadPreviousTrackingResponse(shipment, options, err);
  }

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

  await persistOrderTracking(shipment, result);

  const lastStatus =
    result.lastStatus ||
    result.statusCode ||
    result.status ||
    null;

  const history = await CourierTracking.find({ shipment_id: shipment._id })
    .sort({ event_time: -1, created_at: -1 })
    .lean();

  return {
    success: true,
    stale: false,
    order_id: shipment.order_id,
    tracking_number: shipment.tracking_number,
    courier: shipment.courier,
    status: result.status,
    status_code: result.statusCode,
    tracking_status: lastStatus,
    tracking_details: result.raw ?? null,
    history,
    last_tracking_sync: new Date(),
    raw: options.includeRaw ? result.raw : undefined,
  };
}

function parseStoredTrackingDetails(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Return last saved order tracking so the UI still has records
 * when the live courier API fails.
 */
async function loadPreviousTrackingResponse(shipment, options = {}, err) {
  const Order = mongoose.model("order");
  const order = shipment.order_id
    ? await Order.findById(shipment.order_id)
        .select("tracking_status tracking_details")
        .lean()
    : null;

  const history = await CourierTracking.find({ shipment_id: shipment._id })
    .sort({ event_time: -1, created_at: -1 })
    .lean();

  const trackingDetails = parseStoredTrackingDetails(order?.tracking_details);
  const trackingStatus =
    order?.tracking_status ||
    shipment.status_code ||
    shipment.shipment_status ||
    null;

  return {
    success: true,
    stale: true,
    order_id: shipment.order_id,
    tracking_number: shipment.tracking_number,
    courier: shipment.courier,
    status: shipment.shipment_status,
    status_code: shipment.status_code,
    tracking_status: trackingStatus,
    tracking_details: trackingDetails,
    history,
    last_tracking_sync: shipment.last_tracking_sync || null,
    warning: err?.message || "Courier tracking unavailable; showing last saved records",
    raw: options.includeRaw ? trackingDetails : undefined,
  };
}

/**
 * Persist courier last status + full tracking payload onto the order.
 * `tracking_status` is the latest provider status (e.g. PostEx "Out For Delivery").
 * `tracking_details` stores the full API response as JSON.
 */
async function persistOrderTracking(shipment, result) {
  if (!shipment?.order_id) return;

  const lastStatus =
    result.lastStatus ||
    result.statusCode ||
    result.events?.[0]?.description ||
    result.status ||
    null;

  let details = null;
  if (result.raw != null) {
    details =
      typeof result.raw === "string"
        ? result.raw
        : JSON.stringify(result.raw);
  }

  const update = {};
  if (lastStatus) update.tracking_status = String(lastStatus);
  if (details) update.tracking_details = details;
  if (!Object.keys(update).length) return;

  try {
    await mongoose.model("order").findByIdAndUpdate(shipment.order_id, {
      $set: update,
    });
  } catch (err) {
    courierLogger.apiError({
      event: "order_tracking_persist_failed",
      orderId: String(shipment.order_id),
      error: err.message,
    });
  }
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
      await refreshTrackingForShipment(shipment, { allowStale: false });
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

/**
 * Lightweight auth / connectivity check for a Courier Integration row.
 * Optional overrides let the UI test form values before save
 * (blank password/token keep the stored secrets).
 *
 * @param {object} options
 * @param {string} options.companyId
 * @param {string} [options.courierId]
 * @param {object} [options.overrides]
 * @returns {Promise<{ success: boolean, ok: boolean, message: string, provider: string }>}
 */
async function testCredentials(options = {}) {
  const companyId = options.companyId;
  const courierId = options.courierId;
  const overrides =
    options.overrides && typeof options.overrides === "object"
      ? options.overrides
      : {};

  if (!companyId) {
    throw new CourierError("Company id is required", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  const Company = mongoose.model("company");
  const company = await Company.findById(companyId).lean();
  if (!company) {
    throw new CourierError("Company not found", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  let legacy = null;
  if (courierId) {
    try {
      const LegacyCourier = mongoose.model("courier");
      legacy = await LegacyCourier.findOne({
        _id: courierId,
        company_id: companyId,
        deletedAt: null,
      }).lean();
    } catch {
      legacy = null;
    }
    if (!legacy) {
      throw new CourierError("Courier integration not found", {
        code: "COURIER_NOT_FOUND",
        httpStatus: 404,
      });
    }
  }

  const merged = legacy ? { ...legacy } : {};
  const pickOverride = (key) => {
    if (!(key in overrides)) return;
    const value = overrides[key];
    if (value == null) return;
    const text = String(value);
    // Keep stored password/token when the form field is left blank.
    if ((key === "password" || key === "token") && !text.trim()) return;
    merged[key] = typeof value === "string" ? text.trim() || text : value;
  };

  for (const key of [
    "type",
    "url",
    "login",
    "password",
    "token",
    "account_no",
    "name",
  ]) {
    pickOverride(key);
  }

  if (!merged.url || !String(merged.url).trim()) {
    throw new CourierError("API URL is required", {
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  }
  const typeKey = String(merged.type || overrides.type || "tcs")
    .trim()
    .toLowerCase();
  const isTokenCourier = /postex|flagship|flaship/.test(typeKey);

  if (isTokenCourier) {
    const hasKey = [merged.token, merged.login, merged.password].some((v) =>
      String(v || "").trim(),
    );
    if (!hasKey) {
      throw new CourierError("API key (Token) is required", {
        code: "VALIDATION_ERROR",
        httpStatus: 400,
      });
    }
  } else if (!merged.login || !String(merged.login).trim()) {
    throw new CourierError("Login is required", {
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  }

  const providerKey =
    normalizeProviderKey(typeKey) ||
    normalizeProviderKey(overrides.provider) ||
    normalizeProviderKey(merged.type);

  if (!providerKey || !CourierFactory.isRegistered(providerKey)) {
    throw new CourierError(
      `Credential check is not available for courier type "${merged.type || typeKey}". Supported: TCS, Leopard, PostEx, Flagship.`,
      {
        code: "UNSUPPORTED_COURIER",
        httpStatus: 400,
      },
    );
  }

  const config = mapLegacyCourierToConfig(merged, providerKey);
  const driver = CourierFactory.get(company, config, providerKey);

  let healthy;
  try {
    healthy = await driver.healthCheck();
  } catch (err) {
    healthy = {
      ok: false,
      message: err.message || "Credential check failed",
    };
  }

  const ok = Boolean(healthy?.ok);
  return {
    success: ok,
    ok,
    message:
      healthy?.message ||
      (ok ? "Credentials OK" : "Credential check failed"),
    provider: providerKey,
  };
}

/**
 * Aggregator booking extras (Flaship underlying companies, rate cards, pickups).
 * @param {object} options
 * @param {string} options.companyId
 * @param {string} [options.provider]
 * @param {string} [options.courierId]
 */
async function getBookingOptions(options = {}) {
  const companyId = options.companyId;
  if (!companyId) {
    throw new CourierError("Company id is required", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  const company = await mongoose.model("company").findById(companyId).lean();
  if (!company) {
    throw new CourierError("Company not found", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }

  const { driver, providerKey } = await resolveDriver(
    company,
    options.provider,
    options.courierId,
  );

  const extras =
    typeof driver.getBookingOptions === "function"
      ? await driver.getBookingOptions()
      : { requires_company: false, companies: [] };

  return {
    success: true,
    provider: providerKey,
    ...extras,
  };
}

module.exports = {
  createShipment,
  getTracking,
  getTrackingByTrackingNumber,
  cancelShipment,
  printLabel,
  syncOpenShipments,
  testCredentials,
  getBookingOptions,
  loadProviderConfig,
  resolveDriver,
  appendTrackingEvent,
  decryptProviderSecrets,
};

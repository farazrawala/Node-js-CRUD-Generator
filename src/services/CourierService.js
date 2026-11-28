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
const { mapCourierStatusToOrderStatus } = require("../couriers/statusMap");
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
const { createApplicationLog } = require("../../utils/applicationLogs");
const { enqueueJob, isQueueEnabled } = require("../../utils/redisQueue");

function pickShipmentCourierCompany(shipment) {
  const req = shipment?.api_request;
  if (!req || typeof req !== "object") return null;
  const value = String(req.courierCompany || req.courier_company || "").trim();
  return value || null;
}

/** Skip a repeat health check for the same courier during a bulk run. */
const healthOkUntil = new Map();
const HEALTH_OK_MS = 10 * 60 * 1000;
/** Do not scan a shipment again until this long after last_tracking_sync. */
const MIN_TRACKING_SYNC_GAP_MS = 3 * 60 * 60 * 1000;

const CourierProvider = require("../models/courier_provider.model");
const CourierShipment = require("../models/courier_shipment.model");
const CourierTracking = require("../models/courier_tracking.model");
const CourierStatus = require("../models/courier_status.model");

async function recordCourierStatuses(courier, result) {
  const name = normalizeProviderKey(courier) || String(courier || "").trim();
  if (!name) return;
  const statuses = new Set();
  if (result?.status) statuses.add(String(result.status).trim());
  for (const event of result?.events || []) {
    const status = String(event?.status || "").trim();
    if (status) statuses.add(status);
  }
  for (const status of statuses) {
    if (!status) continue;
    try {
      await CourierStatus.updateOne(
        { courier: name, status },
        { $setOnInsert: { courier: name, status } },
        { upsert: true },
      );
    } catch (err) {
      if (err?.code === 11000) continue;
      courierLogger.apiError({
        event: "courier_status_save_failed",
        courier: name,
        status,
        error: err.message,
      });
    }
  }
}

async function findSyncableShipments(limit, options = {}) {
  const syncable = [];
  const providerConfigs = new Map();
  const Order = mongoose.model("order");
  const companyId = options.companyId || null;
  const hasCourierSelection = Array.isArray(options.courierIds);
  const courierIds = Array.isArray(options.courierIds)
    ? options.courierIds.map(String).filter(Boolean)
    : [];
  const pageSize = 100;
  let offset = 0;
  const excludeIds = Array.isArray(options.excludeIds)
    ? options.excludeIds.filter(Boolean)
    : [];

  while (syncable.length < limit) {
    const syncedBefore = new Date(Date.now() - MIN_TRACKING_SYNC_GAP_MS);
    const shipmentFilter = {
      deletedAt: null,
      tracking_number: { $nin: [null, ""] },
      // Keep polling returned, cancelled, and failed shipments. Stop only once delivered.
      shipment_status: { $ne: UNIFIED_STATUSES.DELIVERED },
    };
    if (excludeIds.length) shipmentFilter._id = { $nin: excludeIds };
    if (companyId) shipmentFilter.company_id = companyId;

    const candidates = await CourierShipment.find(shipmentFilter)
      .sort({ last_tracking_sync: 1, created_at: 1, _id: 1 })
      .skip(offset)
      .limit(pageSize)
      .lean();

    if (!candidates.length) break;
    offset += candidates.length;

    const orderFilter = {
      _id: { $in: candidates.map((shipment) => shipment.order_id) },
      deletedAt: null,
      // Keep scanning returns and cancellations. Stop once delivered, or once
      // the order is tagged return_received.
      order_status: { $ne: "delivered" },
      tags: { $ne: "return_received" },
      // Same clock as the Next courier sync screen: never synced, or at least 3 hours ago.
      $or: [
        { last_tracking_sync: null },
        { last_tracking_sync: { $lte: syncedBefore } },
      ],
      ...(hasCourierSelection ? { courier_id: { $in: courierIds } } : {}),
    };
    if (companyId) orderFilter.company_id = companyId;

    const ordersInTransit = await Order.find(orderFilter)
      .select("_id")
      .lean();
    const inTransitOrderIds = new Set(
      ordersInTransit.map((order) => String(order._id)),
    );

    for (const shipment of candidates) {
      if (!inTransitOrderIds.has(String(shipment.order_id))) continue;

      const provider = normalizeProviderKey(shipment.courier) || shipment.courier;
      const configKey = `${shipment.company_id}:${provider}`;
      if (!providerConfigs.has(configKey)) {
        providerConfigs.set(
          configKey,
          Boolean(await loadProviderConfig(shipment.company_id, provider)),
        );
      }

      if (providerConfigs.get(configKey)) syncable.push(shipment);
      if (syncable.length >= limit) break;
    }

    if (candidates.length < pageSize) break;
  }

  return syncable;
}

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

  // Top-level fields are the current form values; they must win over stale settings.*.
  if (clientId) {
    settings.clientId = clientId;
    settings.client_id = clientId;
  }
  if (clientSecret) {
    settings.clientSecret = clientSecret;
    settings.client_secret = clientSecret;
  }

  const isTokenAuth = /postex|flagship|flaship|trax/i.test(String(providerKey));
  const isLeopard = /leopard/i.test(String(providerKey));

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
    api_key:
      clientId ||
      settings.api_key ||
      (isTokenAuth ? token : null) ||
      (isLeopard ? legacy.login : null) ||
      null,
    secret: clientSecret || settings.secret || (isLeopard ? legacy.password : null) || null,
    account_no: legacy.account_no || settings.account_no || null,
    pickup_location:
      legacy.cost_center ||
      legacy.pickup_location ||
      settings.pickuplocation ||
      settings.costcentercode ||
      settings.cost_center ||
      settings.pickup_location ||
      null,
    pickup_address:
      legacy.pickup_address ||
      settings.pickup_address ||
      null,
    return_address:
      legacy.return_address ||
      settings.return_address ||
      null,
    service_type: legacy.service_type || settings.service_type || null,
    settings: {
      ...settings,
      costcentercode:
        legacy.cost_center ||
        settings.costcentercode ||
        settings.cost_center ||
        null,
      pickup_address:
        legacy.pickup_address || settings.pickup_address || null,
      return_address:
        legacy.return_address || settings.return_address || null,
      shipper_address:
        settings.shipper_address ||
        legacy.pickup_address ||
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
                  : String(legacy.type || "").toLowerCase().includes("trax")
                    ? "Trax"
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

  const healthKey = `${company._id}:${providerKey}:${options.courierId || ""}`;
  const healthStillFresh =
    options.skipHealthCheck === true ||
    (healthOkUntil.get(healthKey) || 0) > Date.now();

  try {
    const healthy = healthStillFresh
      ? { ok: true, message: "Courier health check reused" }
      : await driver.healthCheck();
    if (healthy?.ok) {
      healthOkUntil.set(healthKey, Date.now() + HEALTH_OK_MS);
    }
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

    // Override COD collect amount from booking UI when provided.
    const rawIsCod = options.isCod ?? options.is_cod ?? options.cod;
    const hasCodFlag = rawIsCod !== undefined && rawIsCod !== null && rawIsCod !== "";
    const isCod =
      rawIsCod === true ||
      rawIsCod === "true" ||
      rawIsCod === "1" ||
      rawIsCod === 1;
    const rawAmount = options.codAmount ?? options.cod_amount ?? options.amount ?? options.total_amount;
    if (hasCodFlag) {
      if (isCod) {
        let amount = Number(rawAmount);
        // Fall back to order total when UI sent COD without a usable amount
        // (common when amount_received > total_amount leaves remaining COD at 0).
        if (!Number.isFinite(amount) || amount <= 0) {
          amount = Number(
            order.declaredValue ??
              order.total_amount ??
              order.order_items_total ??
              order.codAmount ??
              0,
          );
        }
        order.codAmount = Number.isFinite(amount) && amount >= 0 ? amount : 0;
        order.isCod = true;
      } else {
        order.codAmount = 0;
        order.isCod = false;
      }
    } else if (rawAmount != null && rawAmount !== "") {
      const amount = Number(rawAmount);
      if (Number.isFinite(amount) && amount >= 0) {
        order.codAmount = amount;
        order.isCod = amount > 0;
      }
    }

    // Override destination city from booking UI / request body when provided.
    // Prefer order.city (invoice City field) over warehouse/pickup defaults.
    const destCity = String(
      options.city ||
        options.destinationCity ||
        options.destination_city ||
        options.cityName ||
        options.city_name ||
        "",
    ).trim();
    if (destCity) {
      order.city = destCity;
      if (order.shippingAddress && typeof order.shippingAddress === "object") {
        order.shippingAddress = { ...order.shippingAddress, city: destCity };
      }
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
        order_status: "packed",
        courier_tracking_number: String(result.trackingNumber || ""),
      };
      if (courierRef) {
        orderUpdate.courier_id = courierRef;
      }
      // Cancelling the previous shipment put this order's stock back; booking
      // again takes it out, so the two always net to zero.
      try {
        const currentOrder = await mongoose
          .model("order")
          .findById(order._id)
          .lean();
        if (
          currentOrder &&
          String(currentOrder.order_status || "").trim() === "shipment_cancel"
        ) {
          const {
            applyOrderStatusStockTransition,
          } = require("../../controllers/order");
          await applyOrderStatusStockTransition({
            order: currentOrder,
            toStatus: orderUpdate.order_status,
            req: buildSystemReq(
              currentOrder.company_id || order.company_id,
              "/api/courier/shipment",
            ),
            logUrl: "/api/courier/shipment",
          });
        }
      } catch (err) {
        courierLogger.apiError({
          event: "order_status_stock_after_rebook_failed",
          orderId: String(order._id),
          error: err.message,
        });
      }
      await mongoose.model("order").findByIdAndUpdate(order._id, orderUpdate);
      try {
        const updatedOrder = await mongoose
          .model("order")
          .findById(order._id)
          .lean();
        const {
          maybeEnqueuePushOrderTrackingJob,
        } = require("../../utils/orderPushQueue");
        await maybeEnqueuePushOrderTrackingJob({
          beforeOrder: order,
          afterOrder: updatedOrder,
          companyId: order.company_id,
          remarks: "Auto push_order_tracking after courier booking",
        });
      } catch {
        /* non-fatal */
      }
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

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Book many orders with one courier login and a few bookings in flight at once.
 * One failure does not stop the rest.
 * @param {string[]} orderIds
 * @param {object} [options] same fields as createShipment
 * @returns {Promise<object>}
 */
async function createShipmentsBulk(orderIds, options = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) {
    throw new CourierError("order_ids is required", {
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  }
  if (ids.length > 100) {
    throw new CourierError("Bulk booking is limited to 100 orders", {
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  }

  const concurrency = Math.min(
    8,
    Math.max(1, Number(options.concurrency) || 5),
  );

  // One login / city-list check for the whole batch, then bookings run together.
  try {
    const sample = await loadOrderContext(ids[0], {
      companyId: options.companyId,
    });
    const resolved = await resolveDriver(
      sample.company,
      options.provider,
      options.courierId,
    );
    const healthy = await resolved.driver.healthCheck();
    if (healthy?.ok && sample.company?._id) {
      healthOkUntil.set(
        `${sample.company._id}:${resolved.providerKey}:${options.courierId || ""}`,
        Date.now() + HEALTH_OK_MS,
      );
    } else if (
      /credential|unauthor|auth|bearer token is missing/i.test(
        healthy?.message || "",
      )
    ) {
      throw invalidCredentials(
        resolved.providerKey,
        healthy?.message || "Invalid courier credentials",
      );
    }
  } catch (err) {
    if (err instanceof CourierError && err.code === "INVALID_CREDENTIALS") {
      throw err;
    }
  }

  const results = await mapWithConcurrency(ids, concurrency, async (orderId) => {
    try {
      const result = await createShipment(orderId, options);
      return {
        order_id: orderId,
        success: true,
        tracking_number: result.tracking_number || null,
        queued: Boolean(result.queued),
        status: result.status || null,
        message: result.message || null,
      };
    } catch (err) {
      return {
        order_id: orderId,
        success: false,
        error: err.message || "Booking failed",
        code: err.code || "COURIER_ERROR",
      };
    }
  });

  const booked = results.filter((row) => row.success).length;
  return {
    success: booked === results.length,
    total: results.length,
    booked,
    failed: results.length - booked,
    results,
  };
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
 * Queue push_order_tracking only when courier / tracking fields actually changed.
 */
async function queueWooTrackingPushAfterCourierPoll(shipment, options = {}) {
  try {
    const {
      maybeEnqueuePushOrderTrackingJob,
    } = require("../../utils/orderPushQueue");
    const Order = mongoose.model("order");
    const afterOrder = shipment.order_id
      ? await Order.findById(shipment.order_id).lean()
      : null;
    return await maybeEnqueuePushOrderTrackingJob({
      beforeOrder: options.beforeOrder || null,
      afterOrder,
      companyId: options.companyId || shipment.company_id,
      createdBy: options.createdBy || null,
      remarks:
        options.trackingPushRemarks ||
        "Auto push_order_tracking after courier tracking change",
      priority: options.trackingPushPriority ?? 50,
    });
  } catch (err) {
    courierLogger.apiError({
      event: "push_order_tracking_queue_failed",
      orderId: String(shipment?.order_id || ""),
      error: err?.message || String(err),
    });
    return {
      queued: false,
      reason: "queue_error",
      error: err?.message || String(err),
    };
  }
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

const BULK_TRACKING_LIMIT = 25;

/**
 * Live-fetch tracking for the given orders or consignment numbers.
 * One failure does not stop the rest. Each call is capped at 45s.
 * @param {object} options
 * @param {string[]} [options.orderIds]
 * @param {string[]} [options.trackingNumbers]
 */
async function syncTrackingBulk(options = {}) {
  const orderIds = [
    ...new Set(
      (Array.isArray(options.orderIds) ? options.orderIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ];
  const trackingNumbers = [
    ...new Set(
      (Array.isArray(options.trackingNumbers) ? options.trackingNumbers : [])
        .map((cn) => String(cn || "").trim())
        .filter(Boolean),
    ),
  ];
  if (!orderIds.length && !trackingNumbers.length) {
    throw new CourierError("order_ids or tracking_numbers is required", {
      code: "VALIDATION_ERROR",
      httpStatus: 400,
    });
  }
  if (orderIds.length + trackingNumbers.length > BULK_TRACKING_LIMIT) {
    throw new CourierError(
      `Bulk tracking sync is limited to ${BULK_TRACKING_LIMIT} shipments`,
      { code: "VALIDATION_ERROR", httpStatus: 400 },
    );
  }

  const companyFilter = options.companyId ? { company_id: options.companyId } : {};
  const jobs = [];
  const seen = new Set();

  const pushShipment = (shipment, requested) => {
    const key = String(shipment?._id || "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    jobs.push({ shipment, requested });
  };

  if (orderIds.length) {
    const rows = await CourierShipment.find({
      order_id: { $in: orderIds },
      deletedAt: null,
      ...companyFilter,
    })
      .sort({ created_at: -1 })
      .lean();
    const byOrder = new Map();
    for (const row of rows) {
      const id = String(row.order_id);
      if (!byOrder.has(id)) byOrder.set(id, row);
    }
    for (const orderId of orderIds) {
      const shipment = byOrder.get(orderId);
      if (shipment) pushShipment(shipment, { order_id: orderId });
      else jobs.push({ shipment: null, requested: { order_id: orderId } });
    }
  }

  if (trackingNumbers.length) {
    const rows = await CourierShipment.find({
      tracking_number: { $in: trackingNumbers },
      deletedAt: null,
      ...companyFilter,
    })
      .sort({ created_at: -1 })
      .lean();
    const byCn = new Map();
    for (const row of rows) {
      const cn = String(row.tracking_number);
      if (!byCn.has(cn)) byCn.set(cn, row);
    }
    for (const trackingNumber of trackingNumbers) {
      const shipment = byCn.get(trackingNumber);
      if (shipment) pushShipment(shipment, { tracking_number: trackingNumber });
      else if (![...jobs].some((job) => job.requested.tracking_number === trackingNumber && !job.shipment)) {
        jobs.push({ shipment: null, requested: { tracking_number: trackingNumber } });
      }
    }
  }

  const concurrency = Math.min(3, Math.max(1, Number(options.concurrency) || 3));
  const summary = { checked: [], changes: [], failures: [] };
  const results = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const base = {
      order_id: job.shipment?.order_id ? String(job.shipment.order_id) : job.requested.order_id || null,
      tracking_number: job.shipment?.tracking_number || job.requested.tracking_number || null,
      courier: job.shipment?.courier || null,
      company_id: job.shipment?.company_id || options.companyId || null,
    };
    if (!job.shipment) {
      summary.checked.push(base);
      summary.failures.push({ ...base, reason: "Shipment not found" });
      return { ...base, success: false, error: "Shipment not found" };
    }
    try {
      const live = await withTimeout(
        refreshTrackingForShipment(job.shipment, { allowStale: false }),
        SHIPMENT_SYNC_TIMEOUT_MS,
        `Tracking sync timed out for ${base.tracking_number || base.order_id}`,
      );
      const checked = {
        ...base,
        order_no: live?.order_no || null,
        integration_order_id: live?.integration_order_id || null,
      };
      summary.checked.push(checked);
      if (live?.order_status_change || live?.tracking_status_change) {
        summary.changes.push({
          ...checked,
          order_status_change: live.order_status_change || null,
          tracking_status_change: live.tracking_status_change || null,
        });
      }
      return {
        ...base,
        success: true,
        exact_courier_status: live?.exact_courier_status || null,
        tracking_status: live?.tracking_status || null,
        status: live?.status || null,
        order_status: live?.order_status || null,
      };
    } catch (err) {
      const reason = String(err?.message || "Tracking sync failed").slice(0, 300);
      summary.checked.push(base);
      summary.failures.push({ ...base, reason });
      return { ...base, success: false, error: reason };
    }
  });

  await attachOrderNumbers(summary.checked);
  await attachOrderNumbers(summary.failures);
  await logTrackingSyncOrders(summary, { url: "/api/courier/tracking/bulk" });

  const updated = results.filter((row) => row.success).length;
  return {
    success: updated > 0,
    total: results.length,
    updated,
    errors: results.length - updated,
    results,
  };
}

async function findShipmentForAdvice({ trackingNumber, orderId, companyId }) {
  const query = { deletedAt: null };
  if (companyId) query.company_id = companyId;
  const cn = String(trackingNumber || "").trim();
  const oid = String(orderId || "").trim();
  if (cn) query.tracking_number = cn;
  else if (oid) query.order_id = oid;
  else {
    throw new CourierError("Tracking number or order id is required", {
      code: "VALIDATION",
      httpStatus: 400,
    });
  }
  const shipment = await CourierShipment.findOne(query).sort({ created_at: -1 }).lean();
  if (!shipment) throw shipmentNotFound(cn || `order:${oid}`);
  return shipment;
}

async function flagshipDriverForShipment(shipment) {
  const Company = mongoose.model("company");
  const company = await Company.findById(shipment.company_id).lean();
  if (!company) {
    throw new CourierError("Company not found for shipment", {
      code: "COMPANY_NOT_FOUND",
      httpStatus: 400,
    });
  }
  const { driver } = await resolveDriver(company, "flagship");
  if (typeof driver.checkShipperAdvice !== "function") {
    throw new CourierError("Shipper advice is only available on the Flaship integration", {
      code: "ADVICE_UNSUPPORTED",
      httpStatus: 400,
    });
  }
  return driver;
}

async function checkShipperAdvice(options = {}) {
  const shipment = await findShipmentForAdvice(options);
  const driver = await flagshipDriverForShipment(shipment);
  const result = await driver.checkShipperAdvice(shipment.tracking_number);
  return {
    success: true,
    tracking_number: shipment.tracking_number,
    order_id: shipment.order_id,
    ...result,
  };
}

async function submitShipperAdvice(options = {}) {
  const shipment = await findShipmentForAdvice(options);
  const driver = await flagshipDriverForShipment(shipment);
  const result = await driver.submitShipperAdvice({
    tracking_number: shipment.tracking_number,
    status: options.status,
    remarks: options.remarks,
    reason: options.reason,
    address: options.address,
    phone: options.phone,
  });
  const liveStatus = String(result.live_courier_status || result.order_status || "").trim();
  if (liveStatus) {
    await persistOrderTracking(shipment, {
      lastStatus: liveStatus,
      status: liveStatus,
      raw: { live_courier_status: result.live_courier_status || liveStatus },
    });
  }
  return {
    success: true,
    tracking_number: shipment.tracking_number,
    order_id: shipment.order_id,
    status: String(options.status || "").trim().toUpperCase(),
    ...result,
  };
}

function isCourierInputError(...parts) {
  return parts.some((part) => /error\(s\) in input/i.test(String(part || "")));
}

/**
 * Flagship books Trax CNs on Flaship's shipper account. Tracking that CN with
 * the store's Trax key returns "Error(s) in Input". Try the other integration.
 */
async function trackWithAlternateCourier(company, shipment, err) {
  const message = String(err?.message || "");
  if (!/error\(s\) in input|invalid api token/i.test(message)) return null;
  const current = String(shipment.courier || "").toLowerCase();
  const alternateKey = /trax/.test(current)
    ? "flagship"
    : /flagship|flaship/.test(current)
      ? "trax"
      : null;
  if (!alternateKey) return null;
  try {
    const alt = await resolveDriver(company, alternateKey);
    const result = await alt.driver.getTracking(shipment.tracking_number);
    if (!result || isCourierInputError(result.status, result.statusCode, result.lastStatus)) {
      return null;
    }
    courierLogger.apiError({
      event: "tracking_alternate_courier",
      provider: shipment.courier,
      alternate: alternateKey,
      trackingNumber: shipment.tracking_number,
      orderId: String(shipment.order_id || ""),
    });
    return result;
  } catch (altErr) {
    courierLogger.apiError({
      event: "tracking_alternate_failed",
      provider: alternateKey,
      trackingNumber: shipment.tracking_number,
      error: altErr.message,
    });
    return null;
  }
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
    const alternate = await trackWithAlternateCourier(company, shipment, err);
    if (alternate) {
      result = alternate;
    } else {
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
  }

  for (const event of result.events || []) {
    if (isCourierInputError(event.status, event.description)) continue;
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

  await recordCourierStatuses(shipment.courier, result);

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

  const Order = mongoose.model("order");
  const beforeOrder = shipment.order_id
    ? await Order.findById(shipment.order_id).lean()
    : null;

  const orderTracking = await persistOrderTracking(shipment, result);

  const lastStatus =
    result.lastStatus ||
    result.statusCode ||
    result.status ||
    null;

  const history = liveTrackingHistory(result);

  const push_order_tracking = await queueWooTrackingPushAfterCourierPoll(
    shipment,
    { ...options, beforeOrder },
  );

  return {
    success: true,
    stale: false,
    order_id: shipment.order_id,
    tracking_number: shipment.tracking_number,
    courier: shipment.courier,
    courier_company: pickShipmentCourierCompany(shipment),
    status: result.status,
    status_code: result.statusCode,
    tracking_status: lastStatus,
    exact_courier_status: pickExactCourierStatus(result) || null,
    order_status: orderTracking?.order_status || null,
    order_status_change: orderTracking?.order_status_change || null,
    tracking_status_change: orderTracking?.tracking_status_change || null,
    order_no: orderTracking?.order_no || null,
    integration_order_id: orderTracking?.integration_order_id || null,
    tracking_details: result.raw ?? null,
    tracking: history,
    history,
    last_tracking_sync: new Date(),
    push_order_tracking,
    raw: options.includeRaw ? result.raw : undefined,
  };
}

/**
 * Timeline the courier returned (`tracking` / `tracking_history`), not the
 * mapped rows stored in courier_tracking.
 */
function isTrackingDetailRow(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return (
    raw.Status != null ||
    raw.Status_With_City != null ||
    raw.Activity_datetime != null ||
    raw.Activity_Date != null ||
    raw.status != null ||
    raw.transactionStatus != null ||
    raw.description != null ||
    raw.datetime != null
  );
}

/** Courier's own tracking-detail objects, unchanged (Status, Activity_datetime, Reason, …). */
function courierTrackingDetailRows(result) {
  const fromEvents = (Array.isArray(result?.events) ? result.events : [])
    .map((event) => event?.raw)
    .filter(isTrackingDetailRow);
  if (fromEvents.length) return fromEvents;

  const raw = result?.raw && typeof result.raw === "object" ? result.raw : null;
  const packet = Array.isArray(raw?.packet_list) ? raw.packet_list[0] : null;
  const candidates = [
    packet?.["Tracking Detail"],
    packet?.Tracking_Detail,
    packet?.TrackingDetail,
    raw?.details?.tracking_history,
    raw?.tracking,
    raw?.checkpoints,
    raw?.deliveryinfo,
  ];
  const list = candidates.find((rows) => Array.isArray(rows) && rows.some(isTrackingDetailRow));
  return Array.isArray(list) ? list.filter(isTrackingDetailRow) : [];
}

function liveTrackingHistory(result) {
  const raw = result?.raw && typeof result.raw === "object" ? result.raw : null;
  const rows = Array.isArray(raw?.tracking)
    ? raw.tracking
    : Array.isArray(raw?.details?.tracking_history)
      ? raw.details.tracking_history
      : Array.isArray(raw?.details?.tracking)
        ? raw.details.tracking
        : null;

  if (rows) {
    return rows
      .map((ev) => {
        const status = String(
          ev?.status || ev?.description || ev?.message || "",
        ).trim();
        if (!status || isCourierInputError(status)) return null;
        const time =
          ev.time || ev.dateTime || ev.datetime || ev.date_time || ev.createdAt || null;
        return {
          status,
          description: status,
          time,
          event_time: time,
          location: ev.station || ev.location || ev.city || null,
        };
      })
      .filter(Boolean);
  }

  return (Array.isArray(result?.events) ? result.events : [])
    .map((ev) => {
      const status = String(ev?.description || ev?.status || "").trim();
      if (!status || isCourierInputError(status)) return null;
      return {
        status,
        description: status,
        time: ev.eventTime || null,
        event_time: ev.eventTime || null,
        location: ev.location || null,
      };
    })
    .filter(Boolean);
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
        .select("tracking_status tracking_details tracking_history order_status exact_courier_status")
        .lean()
    : null;

  const trackingDetails = parseStoredTrackingDetails(order?.tracking_details);
  const history = liveTrackingHistory({ raw: trackingDetails });
  const trackingStatus =
    order?.tracking_status ||
    shipment.status_code ||
    shipment.shipment_status ||
    null;
  const exactCourierStatus = pickExactCourierStatus({
    raw: trackingDetails,
    statusCode: shipment.status_code,
    status: shipment.shipment_status,
  });
  const previousExactStatus = String(order?.exact_courier_status || "").trim();
  const storedHistory = Array.isArray(trackingDetails?.tracking)
    ? trackingDetails.tracking.filter((row) => row && typeof row === "object")
    : history;
  const previousHistory = Array.isArray(order?.tracking_history) ? order.tracking_history : [];
  const statusPatch = {};
  if (exactCourierStatus && exactCourierStatus !== previousExactStatus) {
    statusPatch.exact_courier_status = exactCourierStatus;
    statusPatch.last_tracking_activity_sync = new Date();
  }
  if (storedHistory.length && storedHistory.length !== previousHistory.length) {
    statusPatch.tracking_history = storedHistory;
  }
  if (shipment.order_id && Object.keys(statusPatch).length) {
    await Order.updateOne(
      { _id: shipment.order_id },
      { $set: statusPatch },
    ).catch((saveErr) => {
      courierLogger.apiError({
        event: "exact_courier_status_stale_save_failed",
        orderId: String(shipment.order_id),
        error: saveErr.message,
      });
    });
  }

  return {
    success: true,
    stale: true,
    order_id: shipment.order_id,
    tracking_number: shipment.tracking_number,
    courier: shipment.courier,
    courier_company: pickShipmentCourierCompany(shipment),
    status: shipment.shipment_status,
    status_code: shipment.status_code,
    tracking_status: trackingStatus,
    exact_courier_status: exactCourierStatus || previousExactStatus || null,
    order_status: order?.order_status || null,
    tracking_details: trackingDetails,
    tracking: history,
    history,
    last_tracking_sync: shipment.last_tracking_sync || null,
    push_order_tracking: {
      queued: false,
      reason: "stale_tracking",
    },
    warning: err?.message || "Courier tracking unavailable; showing last saved records",
    raw: options.includeRaw ? trackingDetails : undefined,
  };
}

const TERMINAL_ORDER_STATUSES = new Set([
  "delivered",
  "return",
  "cancelled",
  "failed",
]);

function pickMappedOrderStatus(result, lastStatus) {
  const candidates = [
    mapCourierStatusToOrderStatus(result?.status),
    mapCourierStatusToOrderStatus(result?.statusCode),
    mapCourierStatusToOrderStatus(lastStatus),
    ...(Array.isArray(result?.events) ? result.events : []).map((event) =>
      mapCourierStatusToOrderStatus(event?.description || event?.status),
    ),
  ].filter(Boolean);
  return (
    candidates.find((status) => TERMINAL_ORDER_STATUSES.has(status)) ||
    candidates[0] ||
    null
  );
}

/**
 * Portal status from the courier payload (`RETURN_IN_TRANSIT`), not the mapped
 * bucket (`Returned`) and not the live scan (`Return - Arrived at Origin`).
 */
function pickExactCourierStatus(result) {
  const packet = Array.isArray(result?.raw?.packet_list)
    ? result.raw.packet_list[0]
    : Array.isArray(result?.raw?.data)
      ? result.raw.data[0]
      : null;
  const bookedPacketStatus = String(packet?.booked_packet_status || "").trim();
  if (bookedPacketStatus && !isCourierInputError(bookedPacketStatus)) {
    return bookedPacketStatus;
  }
  const rawStatus = result?.raw?.status;
  const portal = typeof rawStatus === "string" ? rawStatus.trim() : "";
  // Flagship portal status: DELIVERED, RETURN_IN_TRANSIT, IN_TRANSIT, …
  // TCS has no field like this; its scan text is on the checkpoint.
  if (portal && /^[A-Z0-9_]+$/.test(portal) && !isCourierInputError(portal)) {
    return portal;
  }
  const events = Array.isArray(result?.events) ? result.events : [];
  for (const event of events) {
    const text = String(event?.description || event?.raw?.status || "").trim();
    if (!text || isCourierInputError(text)) continue;
    if (/^[A-Z0-9]{1,4}$/.test(text)) continue;
    return text;
  }
  if (portal && portal !== "true" && portal !== "false" && !isCourierInputError(portal)) {
    return portal;
  }
  return String(result?.status || "").trim();
}

/**
 * Persist courier last status + full tracking payload onto the order.
 * `tracking_status` is the latest provider status (e.g. PostEx "Out For Delivery").
 * `tracking_details` stores the full API response as JSON.
 * `order_status` is set from the last courier scan (Delivered → delivered, etc.).
 *
 * @returns {Promise<{ order_status: string|null }>}
 */
async function persistOrderTracking(shipment, result) {
  if (!shipment?.order_id) return { order_status: null };

  const liveCourierStatus = String(result?.raw?.live_courier_status || "").trim();
  const lastStatus =
    liveCourierStatus ||
    result.lastStatus ||
    result.statusCode ||
    result.events?.[0]?.description ||
    result.status ||
    null;

  const mappedOrderStatus = pickMappedOrderStatus(result, lastStatus);

  let details = null;
  if (result.raw != null) {
    details =
      typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw);
  }

  const Order = mongoose.model("order");
  let order = null;
  try {
    order = await Order.findById(shipment.order_id)
      .select(
        "order_status company_id deletedAt status courier_tracking_number tracking_status exact_courier_status order_no integration_order_id integration_id name email createdAt",
      )
      .lean();
  } catch (err) {
    courierLogger.apiError({
      event: "order_tracking_load_failed",
      orderId: String(shipment.order_id),
      error: err.message,
    });
  }

  const update = {};
  const exactCourierStatus = pickExactCourierStatus(result);
  const previousExactStatus = String(order?.exact_courier_status || "").trim();
  if (exactCourierStatus && exactCourierStatus !== previousExactStatus) {
    update.exact_courier_status = exactCourierStatus;
    update.last_tracking_activity_sync = new Date();
  }
  const previousTrackingStatus = String(order?.tracking_status || "").trim();
  const nextTrackingStatus = lastStatus ? String(lastStatus) : "";
  if (
    nextTrackingStatus &&
    nextTrackingStatus !== String(order?.tracking_status || "").trim()
  ) {
    update.tracking_status = nextTrackingStatus;
  }
  if (details) update.tracking_details = details;
  if (shipment?.order_id) update.last_tracking_sync = new Date();

  const trackingNumber = String(shipment?.tracking_number || "").trim();
  if (
    trackingNumber &&
    trackingNumber !== String(order?.courier_tracking_number || "").trim()
  ) {
    update.courier_tracking_number = trackingNumber;
  }

  const currentStatus = String(order?.order_status || "").trim();
  const shouldSetOrderStatus = Boolean(
    order &&
      !order.deletedAt &&
      mappedOrderStatus &&
      mappedOrderStatus !== currentStatus,
  );

  if (shouldSetOrderStatus) {
    try {
      const { applyOrderStatusStockTransition } = require("../../controllers/order");
      await applyOrderStatusStockTransition({
        order,
        toStatus: mappedOrderStatus,
        req: buildSystemReq(
          order.company_id || shipment.company_id,
          "/api/courier/tracking",
        ),
        logUrl: "/api/courier/tracking",
      });
    } catch (err) {
      courierLogger.apiError({
        event: "order_status_stock_from_tracking_failed",
        orderId: String(shipment.order_id),
        from: currentStatus,
        to: mappedOrderStatus,
        error: err.message,
      });
    }
    update.order_status = mappedOrderStatus;
    const OrderModel = mongoose.model("order");
    const websiteStatus =
      typeof OrderModel.mapPosOrderStatusToWebsiteStatus === "function"
        ? OrderModel.mapPosOrderStatusToWebsiteStatus(mappedOrderStatus)
        : null;
    if (websiteStatus) update.order_website_status = websiteStatus;
  }

  const trackingStatusChanged = Boolean(previousTrackingStatus && update.tracking_status);

  if (!Object.keys(update).length) {
    return {
      order_status: currentStatus || mappedOrderStatus || null,
      order_status_change: null,
      tracking_status_change: null,
    };
  }

  try {
    const statusSet = {};
    if (update.exact_courier_status) {
      statusSet.exact_courier_status = update.exact_courier_status;
    }
    if (update.last_tracking_activity_sync) {
      statusSet.last_tracking_activity_sync = update.last_tracking_activity_sync;
    }
    if (update.tracking_status) statusSet.tracking_status = update.tracking_status;
    if (update.last_tracking_sync) statusSet.last_tracking_sync = update.last_tracking_sync;
    if (Object.keys(statusSet).length) {
      await Order.findByIdAndUpdate(shipment.order_id, { $set: statusSet });
    }

    const orderUpdateOp = { $set: update };
    const pullTags = [];
    if (
      mappedOrderStatus === "in_transit" ||
      currentStatus === "in_transit"
    ) {
      pullTags.push("stock_awaiting", "incomplete_address");
    }
    // Booked keeps the packed tag. Any later courier update removes it.
    if (result?.status && result.status !== UNIFIED_STATUSES.BOOKED) {
      pullTags.push("packed");
    }
    const statusForTag = update.order_status || currentStatus;
    const trackingForTag = nextTrackingStatus || previousTrackingStatus;
    const critical =
      typeof Order.shouldMarkCritical === "function" &&
      Order.shouldMarkCritical({
        order_status: statusForTag,
        tracking_status: trackingForTag,
        courier_tracking_number:
          trackingNumber || order?.courier_tracking_number || "",
      });
    if (!critical) pullTags.push("critical");
    let trackingHistory = courierTrackingDetailRows(result);
    if (!trackingHistory.length) {
      trackingHistory = liveTrackingHistory(result).map((row) => ({
        status: row.status,
        time: row.time,
        location: row.location,
      }));
    }
    if (trackingHistory.length) {
      orderUpdateOp.$set.tracking_history = trackingHistory;
    }
    if (pullTags.length) {
      orderUpdateOp.$pullAll = { tags: [...new Set(pullTags)] };
    }
    // $addToSet and $pullAll cannot both target `tags` in one update.
    await Order.findByIdAndUpdate(shipment.order_id, orderUpdateOp);
    if (critical) {
      await Order.findByIdAndUpdate(shipment.order_id, {
        $addToSet: { tags: "critical" },
      });
    }
  } catch (err) {
    courierLogger.apiError({
      event: "order_tracking_persist_failed",
      orderId: String(shipment.order_id),
      error: err.message,
    });
    return {
      order_status: currentStatus || null,
      order_status_change: null,
      tracking_status_change: null,
    };
  }

  if (shouldSetOrderStatus) {
    try {
      const { recordOrderStatusUpdate } = require("../../utils/orderStatusHistory");
      await recordOrderStatusUpdate({
        orderId: shipment.order_id,
        orderStatus: mappedOrderStatus,
        companyId: order.company_id || shipment.company_id,
      });
    } catch (err) {
      courierLogger.apiError({
        event: "order_status_history_from_tracking_failed",
        orderId: String(shipment.order_id),
        error: err.message,
      });
    }
  }

  if (trackingStatusChanged) {
    try {
      const integration = order?.integration_id
        ? await mongoose
            .model("integration")
            .findById(order.integration_id)
            .select("image name")
            .lean()
        : null;
      const { emailTrackingStatusUpdate } = require("../utils/trackingStatusUpdateMail");
      const trackingNumber =
        String(shipment?.tracking_number || order?.courier_tracking_number || "").trim();
      const mail = await emailTrackingStatusUpdate({
        orderNo: order?.order_no,
        status: update.tracking_status,
        integrationImage: integration?.image,
        integrationName: integration?.name,
        customerName: order?.name,
        orderDate: order?.createdAt,
        trackingNumber,
        trackingUrl: buildPublicCourierTrackingUrl(
          shipment?.courier || pickShipmentCourierCompany(shipment),
          trackingNumber,
        ),
      });
      if (!mail.sent) {
        courierLogger.apiError({
          event: "tracking_status_email_not_sent",
          orderId: String(shipment.order_id),
          reason: mail.reason,
        });
      }
    } catch (err) {
      courierLogger.apiError({
        event: "tracking_status_email_failed",
        orderId: String(shipment.order_id),
        error: err.message,
      });
    }
  }

  return {
    order_status: update.order_status || currentStatus || mappedOrderStatus || null,
    order_status_change: shouldSetOrderStatus
      ? { from: currentStatus || null, to: mappedOrderStatus }
      : null,
    tracking_status_change: update.tracking_status
      ? { from: previousTrackingStatus || null, to: update.tracking_status }
      : null,
    order_no: order?.order_no || null,
    integration_order_id: order?.integration_order_id || null,
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

const SHIPPING_ORDER_STATUSES = new Set(["packed", "in_transit"]);

/**
 * Request stand-in for order helpers called outside an HTTP request. They read
 * and temporarily rewrite `params` / `body`, so those must exist.
 */
function buildSystemReq(companyId, url) {
  return {
    user: { company_id: companyId },
    params: {},
    body: {},
    query: {},
    headers: {},
    method: "POST",
    originalUrl: url,
    path: url,
  };
}

/**
 * After a courier cancel: order packed / in_transit → shipment_cancel (+ website status).
 * Orders in any other status (delivered, cancelled, return…) are left alone.
 */
async function revertOrderStatusAfterShipmentCancel(shipment) {
  if (!shipment?.order_id) return null;
  const Order = mongoose.model("order");
  const order = await Order.findById(shipment.order_id).lean();
  if (!order || order.deletedAt) return null;

  const currentStatus = String(order.order_status || "").trim();
  if (!SHIPPING_ORDER_STATUSES.has(currentStatus)) return null;

  const nextStatus = "shipment_cancel";
  const companyId = order.company_id || shipment.company_id;

  // Stock restore must not block the status change (same as tracking updates).
  try {
    const { applyOrderStatusStockTransition } = require("../../controllers/order");
    await applyOrderStatusStockTransition({
      order,
      toStatus: nextStatus,
      req: buildSystemReq(companyId, "/api/courier/cancel"),
      logUrl: "/api/courier/cancel",
    });
  } catch (err) {
    courierLogger.apiError({
      event: "order_status_stock_after_cancel_failed",
      orderId: String(order._id),
      from: currentStatus,
      to: nextStatus,
      error: err.message,
    });
  }

  const $set = { order_status: nextStatus };
  const websiteStatus =
    typeof Order.mapPosOrderStatusToWebsiteStatus === "function"
      ? Order.mapPosOrderStatusToWebsiteStatus(nextStatus)
      : null;
  if (websiteStatus) $set.order_website_status = websiteStatus;

  await Order.updateOne({ _id: order._id }, { $set });

  const { recordOrderStatusUpdate } = require("../../utils/orderStatusHistory");
  await recordOrderStatusUpdate({
    orderId: order._id,
    orderStatus: nextStatus,
    companyId,
  });

  // Tell the store: the fulfillment carrying the cancelled CN is cancelled there too.
  let push_order = null;
  try {
    const updatedOrder = await Order.findById(order._id).lean();
    const { enqueuePushOrderJob } = require("../../utils/orderPushQueue");
    push_order = await enqueuePushOrderJob({
      order: updatedOrder,
      companyId,
      remarks: `Auto push_order after courier shipment cancel (${currentStatus} → ${nextStatus})`,
    });
  } catch (err) {
    courierLogger.apiError({
      event: "push_order_after_shipment_cancel_failed",
      orderId: String(order._id),
      error: err.message,
    });
  }

  return { from: currentStatus, to: nextStatus, push_order };
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
  let result;
  try {
    result = await driver.cancelShipment(shipment.toObject());
  } catch (err) {
    // The courier refuses to cancel a CN it already cancelled. If its own
    // tracking says the shipment is cancelled, finish the cancel on our side.
    let alreadyCancelled = false;
    try {
      const live = await driver.getTracking(shipment.tracking_number);
      alreadyCancelled = live?.status === UNIFIED_STATUSES.CANCELLED;
    } catch {
      /* keep the original cancel error */
    }
    if (!alreadyCancelled) throw err;
    result = { success: true, raw: err.details || null };
  }

  shipment.shipment_status = UNIFIED_STATUSES.CANCELLED;
  shipment.api_response = result.raw || shipment.api_response;
  await shipment.save();

  // Drop the cancelled CN from the order so lists stop showing it as live tracking.
  // Only when the order still points at this CN (a newer booking must be kept).
  try {
    const cancelledCn = String(shipment.tracking_number || "").trim();
    if (cancelledCn) {
      await mongoose.model("order").updateOne(
        { _id: shipment.order_id, courier_tracking_number: cancelledCn },
        {
          $set: {
            courier_tracking_number: "",
            tracking_status: "",
            tracking_details: "",
          },
        },
      );
    }
  } catch {
    /* non-fatal */
  }

  // Booking moved the order to packed / in_transit; with the shipment gone it
  // moves to shipment_cancel until it is booked again (stock is restored too).
  try {
    await revertOrderStatusAfterShipmentCancel(shipment);
  } catch (err) {
    courierLogger.apiError({
      event: "order_status_revert_after_cancel_failed",
      orderId: String(shipment.order_id),
      error: err.message,
    });
  }

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

  let labelBase64 = result.labelBase64 || null;
  const courierKey = String(shipment.courier || result.courier || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const providerKey = String(driver?.providerName || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

  const ensureLabelBytes = async () => {
    if (labelBase64) return Buffer.from(labelBase64, "base64");
    if (!result.labelUrl) return null;
    const res = await fetch(String(result.labelUrl));
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    labelBase64 = buf.toString("base64");
    return buf;
  };

  // PostEx airway bill: stamp company logo before PostEx logo on the PDF header.
  // Also stamp COD amount / Order Type when booking stored a collectable amount.
  if (courierKey === "postex" || courierKey === "postexpk") {
    try {
      const pdfBuf = await ensureLabelBytes();
      if (pdfBuf) {
        const shipmentCod = Number(shipment.cod_amount);
        const rawIsCod = options.isCod ?? options.is_cod ?? options.cod;
        const explicitCod =
          rawIsCod === true ||
          rawIsCod === "true" ||
          rawIsCod === "1" ||
          rawIsCod === 1;
        const explicitNotCod =
          rawIsCod === false ||
          rawIsCod === "false" ||
          rawIsCod === "0" ||
          rawIsCod === 0;
        const queryAmount = Number(
          options.codAmount ?? options.cod_amount ?? options.amount ?? options.total_amount,
        );
        const codAmount = Number.isFinite(queryAmount)
          ? queryAmount
          : Number.isFinite(shipmentCod)
            ? shipmentCod
            : 0;
        const isCod = explicitCod || (!explicitNotCod && codAmount > 0);

        const { stampPostexLabelLogos } = require("../utils/stampCourierLabelLogos");
        const stamped = await stampPostexLabelLogos(pdfBuf, company, {
          isCod,
          codAmount,
        });
        labelBase64 = stamped.toString("base64");
      }
    } catch (stampErr) {
      console.warn(
        "[courier] Failed to stamp PostEx label logos:",
        stampErr?.message || stampErr,
      );
    }
  }

  // Flaship / Trax pack: align store logo on the Trax label + draw invoice
  // in the empty bottom half of the A4 (per_page=2) sheet.
  const isFlagshipLabel =
    providerKey === "flagship" ||
    providerKey === "flaship" ||
    courierKey === "flagship" ||
    courierKey === "flaship" ||
    courierKey === "trax" ||
    /flaship|flagship|trax/i.test(String(shipment.courier || result.courier || ""));
  let stampedFlagship = false;
  if (isFlagshipLabel) {
    try {
      const pdfBuf = await ensureLabelBytes();
      if (pdfBuf) {
        let integration = null;
        let order = null;
        let items = [];
        try {
          const Order = mongoose.model("order");
          order = await Order.findById(orderId).lean();
          if (order?.integration_id) {
            integration = await mongoose
              .model("integration")
              .findById(order.integration_id)
              .select("image store_name name phone email address city state")
              .lean();
          }
          const OrderItem = mongoose.model("order_item");
          const rawItems = await OrderItem.find({
            order_id: orderId,
            deletedAt: null,
            status: { $ne: "inactive" },
          })
            .populate(
              "product_id",
              "product_name name product_code sku product_image product_image_thumbnail_url image",
            )
            .lean();
          items = (rawItems || []).map((line) => {
            const product =
              line.product_id && typeof line.product_id === "object"
                ? line.product_id
                : null;
            return {
              name:
                line.name ||
                product?.product_name ||
                product?.name ||
                "Item",
              sku:
                line.sku ||
                line.product_code ||
                product?.sku ||
                product?.product_code ||
                "",
              image:
                line.product_image ||
                product?.product_image_thumbnail_url ||
                product?.product_image ||
                product?.image ||
                "",
              qty: Number(line.qty) || 1,
              price: Number(line.price) || 0,
              subtotal:
                Number(line.subtotal) ||
                (Number(line.qty) || 1) * (Number(line.price) || 0),
            };
          });
        } catch (loadErr) {
          console.warn(
            "[courier] Flagship invoice context load failed:",
            loadErr?.message || loadErr,
          );
        }

        const paymentMethod =
          options.paymentMethod ||
          options.payment_method ||
          (Number(shipment.cod_amount) > 0 ? "COD" : "") ||
          "COD";
        const rawCarrier = String(
          shipment.courier_company ||
            shipment.courier_code ||
            shipment.courierCode ||
            result.courier_company ||
            result.courier ||
            "",
        ).trim();
        const carrierLabel = (() => {
          const key = rawCarrier.toLowerCase().replace(/[\s_-]+/g, "");
          if (!key || /flagship|flaship/.test(key)) return "TRAX";
          if (key.includes("trax")) return "TRAX";
          if (key.includes("leopard") || key === "lcs") return "LEOPARD";
          if (key.includes("tcs")) return "TCS";
          if (key.includes("postex")) return "POSTEX";
          if (key.includes("mnp") || key.includes("m&p") || key === "mp") return "M&P";
          if (key.includes("blueex") || key.includes("blue")) return "BLUEEX";
          if (key.includes("call")) return "CALL COURIER";
          return rawCarrier.toUpperCase();
        })();
        // Aggregator + actual carrier on the printed invoice (e.g. FLAGSHIP/TRAX).
        const courierName = `FLAGSHIP/${carrierLabel}`;

        const bookedDate =
          shipment.booked_at ||
          shipment.bookedAt ||
          shipment.created_at ||
          shipment.createdAt ||
          order?.createdAt ||
          order?.created_at ||
          "";
        const { composeFlagshipLabelWithInvoice } = require("../utils/stampCourierLabelLogos");
        const stamped = await composeFlagshipLabelWithInvoice(pdfBuf, {
          company,
          integration,
          order,
          items,
          courierName,
          paymentMethod,
          bookedDate,
        });
        if (stamped && stamped.length > 0) {
          labelBase64 = stamped.toString("base64");
          stampedFlagship = true;
        }
      }
    } catch (stampErr) {
      console.warn(
        "[courier] Failed to compose Flagship label + invoice:",
        stampErr?.message || stampErr,
      );
    }
  }

  // When we stamped a PDF, do not return Flaship's remote URL — clients prefer
  // label_url and would otherwise open the unstamped "Flaship print pack".
  const remoteLabelUrl =
    stampedFlagship || (isFlagshipLabel && labelBase64)
      ? null
      : result.labelUrl || shipment.label_url || null;

  return {
    success: true,
    label_url: remoteLabelUrl,
    label_base64: labelBase64,
    content_type: result.contentType || "application/pdf",
    tracking_number: shipment.tracking_number,
    printtype: result.printtype ?? options.printtype ?? null,
  };
}

const SHIPMENT_SYNC_TIMEOUT_MS = 45_000;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SYNC_PAGE_SIZE = 25;
const SYNC_MAX_PAGES = 40;

/**
 * Sync open shipments (used by cron job).
 * Walks the oldest `last_tracking_sync` rows in pages so one run is not stuck
 * on the first 25. Each page is at most 25 courier calls.
 * @param {object} [options]
 * @param {number} [options.limit] page size (max 25)
 * @param {number} [options.pages] how many pages to scan (max 40)
 */
async function syncOpenShipments(options = {}) {
  const requestedLimit = Number(options.limit);
  const pageSize =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.min(Math.floor(requestedLimit), SYNC_PAGE_SIZE))
      : SYNC_PAGE_SIZE;
  const requestedPages = Number(options.pages ?? options.maxPages);
  const maxPages =
    Number.isFinite(requestedPages) && requestedPages > 0
      ? Math.max(1, Math.min(Math.floor(requestedPages), SYNC_MAX_PAGES))
      : 1;

  const summary = {
    total: 0,
    updated: 0,
    errors: 0,
    order_status_changed: 0,
    tracking_status_changed: 0,
    pages: 0,
    page_size: pageSize,
    has_more: false,
    changes: [],
    checked: [],
    failures: [],
  };

  const excludeIds = [];
  for (let page = 0; page < maxPages; page += 1) {
    const open = await findSyncableShipments(pageSize, {
      companyId: options.companyId,
      courierIds: options.courierIds,
      excludeIds,
    });
    if (!open.length) break;

    summary.pages += 1;
    summary.total += open.length;

    for (const shipment of open) {
      excludeIds.push(shipment._id);
      await scanOneShipment(shipment, summary);
    }

    if (open.length < pageSize) break;
    if (page + 1 >= maxPages) summary.has_more = true;
  }

  await attachOrderNumbers(summary.checked);
  await attachOrderNumbers(summary.failures);
  await logTrackingSyncOrders(summary);
  return summary;
}

async function scanOneShipment(shipment, summary) {
    const checkedRow = {
      order_id: String(shipment.order_id || ""),
      company_id: shipment.company_id || null,
      order_no: null,
      integration_order_id: null,
      courier: shipment.courier || null,
      tracking_number: shipment.tracking_number || null,
    };
    try {
      // One hung courier call must not block the summary email or later hourly runs.
      const result = await withTimeout(
        refreshTrackingForShipment(shipment, { allowStale: false }),
        SHIPMENT_SYNC_TIMEOUT_MS,
        `Tracking sync timed out for ${shipment.tracking_number || shipment._id}`,
      );
      summary.updated += 1;
      checkedRow.order_no = result?.order_no || null;
      checkedRow.integration_order_id = result?.integration_order_id || null;
      summary.checked.push(checkedRow);
      if (result?.order_status_change) summary.order_status_changed += 1;
      if (result?.tracking_status_change) summary.tracking_status_changed += 1;
      if (result?.order_status_change || result?.tracking_status_change) {
        summary.changes.push({
          order_id: String(shipment.order_id || ""),
          order_no: result.order_no || null,
          integration_order_id: result.integration_order_id || null,
          courier: shipment.courier || null,
          tracking_number: shipment.tracking_number || null,
          last_tracking_sync: shipment.last_tracking_sync || null,
          order_status_change: result.order_status_change || null,
          tracking_status_change: result.tracking_status_change || null,
        });
      }
    } catch (err) {
      summary.errors += 1;
      summary.checked.push(checkedRow);
      summary.failures.push({
        order_id: String(shipment.order_id || ""),
        courier: shipment.courier || null,
        tracking_number: shipment.tracking_number || null,
        reason: String(err?.message || "Unknown error").slice(0, 300),
      });
      courierLogger.apiError({
        event: "sync_error",
        shipmentId: String(shipment._id),
        error: err.message,
      });
      // Move a failed row off the front of the queue so the next page is new work.
      const syncedAt = new Date();
      await CourierShipment.updateOne(
        { _id: shipment._id },
        { $set: { last_tracking_sync: syncedAt } },
      ).catch(() => {});
      if (shipment.order_id) {
        await mongoose
          .model("order")
          .updateOne(
            { _id: shipment.order_id },
            { $set: { last_tracking_sync: syncedAt } },
          )
          .catch(() => {});
      }
    }
}

function statusChangeComment(label, change) {
  const parts = [];
  if (change?.tracking_status_change) {
    const from = change.tracking_status_change.from || "none";
    const to = change.tracking_status_change.to || "none";
    parts.push(`tracking ${from} → ${to}`);
  }
  if (change?.order_status_change) {
    const from = change.order_status_change.from || "none";
    const to = change.order_status_change.to || "none";
    parts.push(`order ${from} → ${to}`);
  }
  return `Tracking scanned for ${label}. Status changed: ${parts.join("; ")}.`;
}

/**
 * One `logs` row per scanned order: order id, comment, tag, and whether status changed.
 */
async function logTrackingSyncOrders(summary, options = {}) {
  const changesByOrder = new Map(
    (summary.changes || []).map((row) => [String(row.order_id), row]),
  );
  const failuresByOrder = new Map(
    (summary.failures || []).map((row) => [String(row.order_id), row]),
  );

  for (const row of summary.checked || []) {
    const orderId = String(row.order_id || "");
    const label = row.order_no || orderId || row.tracking_number || "order";
    const failure = failuresByOrder.get(orderId);
    const change = changesByOrder.get(orderId);
    const statusChanged = Boolean(
      change?.order_status_change || change?.tracking_status_change,
    );
    let comment;
    let tag;
    if (failure) {
      tag = "scan_failed";
      comment = `Tracking scan failed for ${label}. ${failure.reason || "Unknown error"}`;
    } else if (statusChanged) {
      tag = "status_changed";
      comment = statusChangeComment(label, change);
    } else {
      tag = "status_unchanged";
      comment = `Tracking scanned for ${label}. Status not changed.`;
    }

    await createApplicationLog(null, {
      action: "sync courier",
      url: options.url || "/api/courier/sync",
      tags: ["sync_courier", tag],
      reference_id: orderId,
      reference_type: "order",
      company_id: row.company_id,
      description: {
        order_id: orderId,
        order_no: row.order_no || null,
        courier: row.courier || null,
        tracking_number: row.tracking_number || null,
        status_changed: statusChanged,
        comment,
      },
    });
  }
}

/** Fill order_no / integration_order_id on failure rows (one query). */
async function attachOrderNumbers(rows) {
  const ids = rows
    .map((r) => r.order_id)
    .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
  if (!ids.length) return;
  try {
    const orders = await mongoose
      .model("order")
      .find({ _id: { $in: ids } })
      .select("order_no integration_order_id")
      .lean();
    const byId = new Map(orders.map((o) => [String(o._id), o]));
    for (const row of rows) {
      const order = byId.get(row.order_id);
      row.order_no = order?.order_no || null;
      row.integration_order_id = order?.integration_order_id || null;
    }
  } catch {
    /* order numbers are cosmetic for the summary email */
  }
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
    if (
      (key === "password" || key === "token" || key === "client_secret") &&
      !text.trim()
    ) {
      return;
    }
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
    "client_id",
    "client_secret",
  ]) {
    pickOverride(key);
  }

  if (!merged.url || !String(merged.url).trim()) {
    const typeHint = String(merged.type || overrides.type || "")
      .trim()
      .toLowerCase();
    if (typeHint.includes("trax")) {
      merged.url = "https://sonic.pk";
    } else {
      throw new CourierError("API URL is required", {
        code: "VALIDATION_ERROR",
        httpStatus: 400,
      });
    }
  }
  const typeKey = String(merged.type || overrides.type || "tcs")
    .trim()
    .toLowerCase();
  const isTokenCourier = /postex|flagship|flaship|trax/.test(typeKey);

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
      `Credential check is not available for courier type "${merged.type || typeKey}". Supported: TCS, Leopard, PostEx, Flagship, Trax.`,
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
  createShipmentsBulk,
  getTracking,
  getTrackingByTrackingNumber,
  syncTrackingBulk,
  checkShipperAdvice,
  submitShipperAdvice,
  cancelShipment,
  printLabel,
  syncOpenShipments,
  findSyncableShipments,
  testCredentials,
  getBookingOptions,
  loadProviderConfig,
  resolveDriver,
  appendTrackingEvent,
  decryptProviderSecrets,
};

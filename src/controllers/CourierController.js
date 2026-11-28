/**
 * HTTP adapter — never selects a courier provider.
 * @module src/controllers/CourierController
 */

const CourierService = require("../services/CourierService");
const { CourierError } = require("../couriers/errors");
const { logControllerError } = require("../../utils/logControllerError");
const { createApplicationLog } = require("../../utils/applicationLogs");
const CourierFactory = require("../couriers/CourierFactory");
const courierLogger = require("../utils/courierLogger");
const { listCourierTypes } = require("../../models/courier");
const CourierStatus = require("../models/courier_status.model");
const { normalizeProviderKey } = require("../couriers/constants");
const { emailTrackingSyncSummary } = require("../utils/trackingSyncSummaryMail");

function companyIdFromReq(req) {
  return (
    req.user?.company_id?._id ||
    req.user?.company_id ||
    req.query?.company_id ||
    null
  );
}

function sendError(res, err) {
  const status = err.httpStatus || err.status || 500;
  const providerResponse = err.details?.response;
  const statusMessage =
    err.details?.statusMessage ||
    (providerResponse && typeof providerResponse === "object"
      ? providerResponse.statusMessage || providerResponse.message
      : null);

  // Never leak raw credentials; details are already masked when logged.
  const details = err.details
    ? {
        httpStatus: err.details.httpStatus,
        url: err.details.url || null,
        statusMessage: statusMessage || null,
        response: providerResponse,
        errorList: err.details.errorList,
        sentWeights: err.details.sentWeights,
        prompt: err.details.prompt || null,
        companies: err.details.companies,
        rate_cards: err.details.rate_cards,
        pickup_addresses: err.details.pickup_addresses,
      }
    : undefined;

  const errorText = String(err.message || "Courier error");
  return res.status(status).json({
    success: false,
    error: errorText,
    message: errorText,
    code: err.code || "COURIER_ERROR",
    details,
    retryable: Boolean(err.retryable),
  });
}

function bookingOptionsFromReq(req) {
  return {
    companyId: companyIdFromReq(req),
    userId: req.user?._id,
    provider: req.body?.provider || req.query?.provider,
    courierId:
      req.body?.courier_id ||
      req.body?.courierId ||
      req.query?.courier_id ||
      req.query?.courierId ||
      null,
    async: req.body?.async === true || req.query?.async === "1",
    queueOnUnavailable:
      req.body?.queueOnUnavailable === true ||
      req.query?.queueOnUnavailable === "1",
    courierCompany:
      req.body?.courier_company ||
      req.body?.courierCompany ||
      req.query?.courier_company ||
      null,
    courierOption:
      req.body?.courier_option ||
      req.body?.courierOption ||
      req.query?.courier_option ||
      null,
    pickuplocation:
      req.body?.pickuplocation ||
      req.body?.pickup_location ||
      req.query?.pickuplocation ||
      null,
    isCod:
      req.body?.isCod ??
      req.body?.is_cod ??
      req.body?.cod ??
      req.query?.isCod ??
      req.query?.is_cod ??
      req.query?.cod,
    codAmount:
      req.body?.codAmount ??
      req.body?.cod_amount ??
      req.body?.amount ??
      req.body?.total_amount ??
      req.query?.codAmount ??
      req.query?.cod_amount ??
      req.query?.amount ??
      req.query?.total_amount,
    city:
      req.body?.city ||
      req.body?.destinationCity ||
      req.body?.destination_city ||
      req.body?.cityName ||
      req.body?.city_name ||
      req.query?.city ||
      null,
  };
}

/**
 * POST /courier/create-bulk
 * Body: { order_ids: string[], courier_id, ...same booking fields as single create }
 */
async function createShipmentsBulk(req, res) {
  try {
    const orderIds = req.body?.order_ids || req.body?.orderIds || [];
    const result = await CourierService.createShipmentsBulk(orderIds, {
      ...bookingOptionsFromReq(req),
      concurrency: req.body?.concurrency,
    });
    const status = result.booked > 0 ? 201 : 422;
    return res.status(status).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER BULK CREATE SHIPMENT",
      tags: ["courier", "create", "bulk", "error"],
    });
    return sendError(res, err instanceof CourierError ? err : err);
  }
}

/**
 * POST /courier/create/:orderId
 */
async function createShipment(req, res) {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "orderId is required",
        code: "VALIDATION_ERROR",
      });
    }

    const result = await CourierService.createShipment(
      orderId,
      bookingOptionsFromReq(req),
    );

    return res.status(result.queued ? 202 : 201).json(result);
  } catch (err) {
    const description = courierLogger.formatBookingFailureDescription(err, {
      provider: req.body?.provider || req.query?.provider || "courier",
      orderId: req.params?.orderId,
    });

    await logControllerError(req, description, {
      action: "COURIER CREATE SHIPMENT",
      tags: ["courier", "create", "error", "booking_failed"],
    });

    return sendError(res, err instanceof CourierError ? err : err);
  }
}

/**
 * GET /courier/tracking/:trackingNo
 * Public — no Authorization header. Looks up the consignment across companies.
 */
async function getTrackingByNumber(req, res) {
  try {
    const { trackingNo } = req.params;
    const result = await CourierService.getTrackingByTrackingNumber(trackingNo, {
      companyId: companyIdFromReq(req),
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER TRACKING",
      tags: ["courier", "tracking", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * POST /courier/tracking/bulk
 * Body: { order_ids?: string[], tracking_numbers?: string[] }
 * Live-fetches each booked shipment and saves exact_courier_status.
 */
async function syncTrackingBulk(req, res) {
  try {
    const result = await CourierService.syncTrackingBulk({
      companyId: companyIdFromReq(req),
      orderIds: req.body?.order_ids || req.body?.orderIds || [],
      trackingNumbers:
        req.body?.tracking_numbers || req.body?.trackingNumbers || [],
      concurrency: req.body?.concurrency,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER BULK TRACKING SYNC",
      tags: ["courier", "tracking", "bulk", "error"],
    });
    return sendError(res, err instanceof CourierError ? err : err);
  }
}

/**
 * GET /courier/order/:orderId/tracking
 */
async function getTrackingByOrder(req, res) {
  try {
    const { orderId } = req.params;
    const result = await CourierService.getTracking(orderId, {
      companyId: companyIdFromReq(req),
      createdBy: req.user?._id || null,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER ORDER TRACKING",
      tags: ["courier", "tracking", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * GET /courier/advice/check?tracking_number=&order_id=
 */
async function checkShipperAdvice(req, res) {
  try {
    const result = await CourierService.checkShipperAdvice({
      companyId: companyIdFromReq(req),
      trackingNumber: req.query?.tracking_number || req.query?.trackingNumber,
      orderId: req.query?.order_id || req.query?.orderId,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER SHIPPER ADVICE CHECK",
      tags: ["courier", "advice", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * POST /courier/advice
 * Body: tracking_number or order_id, status RETURN|REATTEMPT, remarks optional.
 */
async function submitShipperAdvice(req, res) {
  try {
    const result = await CourierService.submitShipperAdvice({
      companyId: companyIdFromReq(req),
      trackingNumber: req.body?.tracking_number || req.body?.trackingNumber,
      orderId: req.body?.order_id || req.body?.orderId,
      status: req.body?.status,
      remarks: req.body?.remarks,
      reason: req.body?.reason,
      address: req.body?.address,
      phone: req.body?.phone,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER SHIPPER ADVICE",
      tags: ["courier", "advice", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * POST /courier/cancel/:orderId
 */
async function cancelShipment(req, res) {
  try {
    const result = await CourierService.cancelShipment(req.params.orderId, {
      companyId: companyIdFromReq(req),
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER CANCEL",
      tags: ["courier", "cancel", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * GET /courier/label/:orderId
 * Query: printtype, shipperDetails, accounttype (TCS CNPrint)
 * PostEx: Airway Bill PDF via GET /order/v1/get-invoice?trackingNumbers=...
 */
async function printLabel(req, res) {
  try {
    const result = await CourierService.printLabel(req.params.orderId, {
      companyId: companyIdFromReq(req),
      printtype: req.query?.printtype ?? req.query?.printType,
      shipperDetails: req.query?.shipperDetails,
      accounttype: req.query?.accounttype ?? req.query?.accountType,
      isCod: req.query?.isCod ?? req.query?.is_cod ?? req.query?.cod,
      codAmount:
        req.query?.codAmount ??
        req.query?.cod_amount ??
        req.query?.amount ??
        req.query?.totalAmount ??
        req.query?.total_amount,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER LABEL",
      tags: ["courier", "label", "error"],
    });
    return sendError(res, err);
  }
}

/**
 * GET /courier/statuses
 * Query: courier (optional) — Leopard, TCS, PostEx, …
 * Unique statuses recorded from scans.
 */
async function listStatuses(req, res) {
  const requested = String(req.query?.courier || req.query?.provider || "").trim();
  const courier = requested ? normalizeProviderKey(requested) || requested : "";
  const filter = courier ? { courier } : {};
  const rows = await CourierStatus.find(filter)
    .select("courier status")
    .sort({ courier: 1, status: 1 })
    .lean();

  const byCourier = new Map();
  for (const row of rows) {
    const name = row.courier || "";
    if (!byCourier.has(name)) byCourier.set(name, []);
    byCourier.get(name).push(row.status);
  }

  const grouped = [...byCourier.entries()].map(([name, statuses]) => ({
    courier: name,
    statuses,
  }));

  return res.status(200).json({
    success: true,
    courier: courier || null,
    statuses: courier ? grouped[0]?.statuses || [] : [...new Set(rows.map((row) => row.status))],
    by_courier: grouped,
  });
}

/**
 * GET /courier/providers
 */
async function listProviders(req, res) {
  return res.status(200).json({
    success: true,
    providers: CourierFactory.listProviders(),
  });
}

/**
 * GET /courier/types — enum values with labels + logo paths
 */
async function listTypes(req, res) {
  return res.status(200).json({
    success: true,
    types: listCourierTypes(),
  });
}

/**
 * POST /courier/sync — manual sync trigger (admin)
 */
async function syncTracking(req, res) {
  const companyId =
    req.user?.company_id?._id ||
    req.user?.company_id ||
    null;
  try {
    if (!companyId) {
      return res.status(401).json({
        success: false,
        error: "Authenticated company context is required",
      });
    }

    const started = Date.now();
    const requestedPages = Number(req.body?.pages ?? req.query?.pages);
    const summary = await CourierService.syncOpenShipments({
      companyId,
      limit: Number(req.body?.limit ?? req.query?.limit) || 25,
      pages: Number.isFinite(requestedPages) && requestedPages > 0 ? requestedPages : 1,
      courierIds: Array.isArray(req.body?.courier_ids)
        ? req.body.courier_ids.map((id) => String(id).trim()).filter(Boolean)
        : undefined,
    });
    const email = await emailTrackingSyncSummary(summary, {
      startedAt: new Date(started),
      durationMs: Date.now() - started,
    });
    await createApplicationLog(req, {
      action: "Courier tracking sync",
      tags: ["sync_courier"],
      description: {
        scope: "company",
        eligible_statuses: "all except delivered or tagged return_received",
        total: summary.total,
        updated: summary.updated,
        errors: summary.errors,
        order_status_changed: summary.order_status_changed,
        tracking_status_changed: summary.tracking_status_changed,
      },
      company_id: companyId,
      created_by: req.user?._id,
    });
    return res.status(200).json({
      success: true,
      scope: "company",
      eligible_statuses: "all except delivered or tagged return_received",
      email,
      ...summary,
    });
  } catch (err) {
    if (companyId) {
      await createApplicationLog(req, {
        action: "Courier tracking sync failed",
        tags: ["sync_courier"],
        description: {
          scope: "company",
          eligible_statuses: "all except delivered or tagged return_received",
          error: String(err?.message || "Courier tracking sync failed").slice(
            0,
            300,
          ),
        },
        company_id: companyId,
        created_by: req.user?._id,
      });
    }
    return sendError(res, err);
  }
}

/**
 * POST /courier/test/:courierId
 * Optional body overrides (url, login, password, token, account_no, type)
 * so the edit form can verify values before saving.
 * Blank password/token keep the stored secrets.
 */
async function testCredentials(req, res) {
  try {
    const courierId = req.params.courierId || req.body?.courier_id || null;
    const result = await CourierService.testCredentials({
      companyId: companyIdFromReq(req),
      courierId,
      overrides: {
        type: req.body?.type,
        url: req.body?.url,
        login: req.body?.login,
        password: req.body?.password,
        token: req.body?.token,
        account_no: req.body?.account_no ?? req.body?.accountNo,
        client_id: req.body?.client_id ?? req.body?.clientId,
        client_secret: req.body?.client_secret ?? req.body?.clientSecret,
        provider: req.body?.provider,
      },
    });

    return res.status(result.ok ? 200 : 401).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER TEST CREDENTIALS",
      tags: ["courier", "test", "credentials", "error"],
    });
    return sendError(res, err instanceof CourierError ? err : err);
  }
}

async function getBookingOptions(req, res) {
  try {
    const result = await CourierService.getBookingOptions({
      companyId: companyIdFromReq(req),
      provider: req.query?.provider || req.body?.provider,
      courierId:
        req.query?.courier_id ||
        req.query?.courierId ||
        req.body?.courier_id ||
        req.body?.courierId ||
        null,
    });
    return res.status(200).json(result);
  } catch (err) {
    await logControllerError(req, err.message, {
      action: "COURIER BOOKING OPTIONS",
      tags: ["courier", "booking_options", "error"],
    });
    return sendError(res, err);
  }
}

module.exports = {
  createShipment,
  createShipmentsBulk,
  getTrackingByNumber,
  getTrackingByOrder,
  syncTrackingBulk,
  checkShipperAdvice,
  submitShipperAdvice,
  cancelShipment,
  printLabel,
  listStatuses,
  listProviders,
  listTypes,
  syncTracking,
  testCredentials,
  getBookingOptions,
};

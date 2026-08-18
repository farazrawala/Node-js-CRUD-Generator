/**
 * HTTP adapter — never selects a courier provider.
 * @module src/controllers/CourierController
 */

const CourierService = require("../services/CourierService");
const { CourierError } = require("../couriers/errors");
const { logControllerError } = require("../../utils/logControllerError");
const CourierFactory = require("../couriers/CourierFactory");
const courierLogger = require("../utils/courierLogger");

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

    const result = await CourierService.createShipment(orderId, {
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
    });

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
 * GET /courier/order/:orderId/tracking
 */
async function getTrackingByOrder(req, res) {
  try {
    const { orderId } = req.params;
    const result = await CourierService.getTracking(orderId, {
      companyId: companyIdFromReq(req),
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
 * GET /courier/providers
 */
async function listProviders(req, res) {
  return res.status(200).json({
    success: true,
    providers: CourierFactory.listProviders(),
  });
}

/**
 * POST /courier/sync — manual sync trigger (admin)
 */
async function syncTracking(req, res) {
  try {
    const summary = await CourierService.syncOpenShipments({
      limit: Number(req.query.limit) || 100,
    });
    return res.status(200).json({ success: true, ...summary });
  } catch (err) {
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
  getTrackingByNumber,
  getTrackingByOrder,
  cancelShipment,
  printLabel,
  listProviders,
  syncTracking,
  testCredentials,
  getBookingOptions,
};

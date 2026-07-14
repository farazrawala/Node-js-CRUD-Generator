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
  // Never leak raw credentials; details are already masked when logged.
  const details = err.details
    ? {
        httpStatus: err.details.httpStatus,
        response: err.details.response,
        // omit full request from API response (still in file/DB logs)
      }
    : undefined;
  return res.status(status).json({
    success: false,
    error: err.message || "Courier error",
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

module.exports = {
  createShipment,
  getTrackingByNumber,
  getTrackingByOrder,
  cancelShipment,
  printLabel,
  listProviders,
  syncTracking,
};

/**
 * Courier REST routes.
 * Mounted at /api/courier
 * @module src/routes/courier.routes
 */

const express = require("express");
const CourierController = require("../controllers/CourierController");

const router = express.Router();

/** Create shipment — body must NOT include customer/address data; only orderId in path. */
router.post("/create/:orderId", CourierController.createShipment);

router.get("/tracking/:trackingNo", CourierController.getTrackingByNumber);
router.get("/order/:orderId/tracking", CourierController.getTrackingByOrder);

router.post("/cancel/:orderId", CourierController.cancelShipment);
router.get("/label/:orderId", CourierController.printLabel);

router.get("/providers", CourierController.listProviders);
router.post("/sync", CourierController.syncTracking);

module.exports = router;

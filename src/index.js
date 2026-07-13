/**
 * Courier Integration Module entry point.
 *
 * Usage:
 *   const { CourierService, startCourierModule } = require('./src');
 *   await CourierService.createShipment(orderId);
 *   await CourierService.getTracking(orderId);
 *
 * @module src
 */

require("./models/courier_provider.model");
require("./models/courier_shipment.model");
require("./models/courier_tracking.model");

const CourierService = require("./services/CourierService");
const CourierFactory = require("./couriers/CourierFactory");
const BaseCourier = require("./couriers/BaseCourier");
const {
  startTrackingSyncJob,
  stopTrackingSyncJob,
  getTrackingSyncStatus,
} = require("./jobs/trackingSync.job");
const courierRoutes = require("./routes/courier.routes");
const { UNIFIED_STATUSES, PROVIDERS, TERMINAL_STATUSES } = require("./couriers/constants");

/**
 * Register models + start background jobs. Call once from index.js after Mongo connects.
 */
function startCourierModule() {
  return {
    trackingSync: startTrackingSyncJob(),
  };
}

module.exports = {
  CourierService,
  CourierFactory,
  BaseCourier,
  courierRoutes,
  startCourierModule,
  stopTrackingSyncJob,
  getTrackingSyncStatus,
  UNIFIED_STATUSES,
  PROVIDERS,
  TERMINAL_STATUSES,
};

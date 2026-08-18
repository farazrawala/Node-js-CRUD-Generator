/**
 * Abstract courier provider interface.
 * Concrete drivers (TCSCourier, LeopardCourier, …) MUST implement all methods.
 * @module src/couriers/BaseCourier
 */

const { UNIFIED_STATUSES, isCourierSandbox } = require("./constants");
const { mapGenericStatus } = require("./statusMap");

class BaseCourier {
  /**
   * @param {object} config Decrypted provider config document
   * @param {object} [options]
   */
  constructor(config = {}, options = {}) {
    if (new.target === BaseCourier) {
      throw new Error("BaseCourier is abstract and cannot be instantiated");
    }
    this.config = config;
    this.options = options;
    this.providerName = "Base";
    /** @type {{ token: string|null, expiresAt: number }} */
    this._tokenCache = { token: null, expiresAt: 0 };
  }

  /**
   * Sandbox vs production — driven by `.env` `COURIER_SANDBOX` for all couriers.
   * @returns {boolean}
   */
  get isSandbox() {
    return isCourierSandbox(this.config);
  }

  /**
   * Create a shipment booking from a fully loaded order context.
   * @param {import('../utils/orderContextLoader').OrderContext} order
   * @returns {Promise<ShipmentResult>}
   */
  async createShipment(_order) {
    throw new Error(`${this.providerName}.createShipment() not implemented`);
  }

  /**
   * Cancel an existing shipment.
   * @param {object} shipment
   * @returns {Promise<{ success: boolean, raw?: * }>}
   */
  async cancelShipment(_shipment) {
    throw new Error(`${this.providerName}.cancelShipment() not implemented`);
  }

  /**
   * Track by courier tracking / CN number.
   * @param {string} trackingNo
   * @returns {Promise<TrackingResult>}
   */
  async getTracking(_trackingNo) {
    throw new Error(`${this.providerName}.getTracking() not implemented`);
  }

  /** Alias preferred by some callers. */
  async trackShipment(trackingNo) {
    return this.getTracking(trackingNo);
  }

  /**
   * Optional: providers may override for order-scoped remote lookups.
   * Default: not supported at provider level (service looks up shipment first).
   * @param {string} _orderId
   */
  async trackShipmentByOrder(_orderId) {
    throw new Error(
      `${this.providerName}.trackShipmentByOrder() not supported — use CourierService.getTracking(orderId)`,
    );
  }

  /**
   * Fetch printable label URL or binary metadata.
   * @param {object} shipment
   * @returns {Promise<{ labelUrl?: string, raw?: * }>}
   */
  async printLabel(_shipment) {
    throw new Error(`${this.providerName}.printLabel() not implemented`);
  }

  /**
   * Validate an address against provider rules / city lists.
   * @param {object} address
   * @returns {Promise<{ valid: boolean, normalized?: object, message?: string }>}
   */
  async validateAddress(_address) {
    throw new Error(`${this.providerName}.validateAddress() not implemented`);
  }

  /**
   * Return provider city list (cacheable).
   * @returns {Promise<Array<{ code?: string, name: string, id?: string|number }>>}
   */
  async getCities() {
    throw new Error(`${this.providerName}.getCities() not implemented`);
  }

  /**
   * Lightweight connectivity / auth check.
   * @returns {Promise<{ ok: boolean, message?: string }>}
   */
  async healthCheck() {
    throw new Error(`${this.providerName}.healthCheck() not implemented`);
  }

  /**
   * Aggregator extras for the booking UI (e.g. Flaship underlying companies).
   * Direct couriers return requires_company: false.
   * @returns {Promise<{ requires_company: boolean, companies?: string[], rate_cards?: object, pickup_addresses?: object[], prompt?: string }>}
   */
  async getBookingOptions() {
    return { requires_company: false, companies: [] };
  }

  /**
   * Map provider status text into unified status.
   * Override in subclasses for provider-specific maps.
   * @param {string|object} statusOrEvent
   * @returns {string}
   */
  mapStatus(statusOrEvent) {
    if (statusOrEvent && typeof statusOrEvent === "object") {
      return mapGenericStatus(
        statusOrEvent.status || statusOrEvent.description || "",
      );
    }
    return mapGenericStatus(statusOrEvent);
  }

  /**
   * @param {Partial<ShipmentResult>} partial
   * @returns {ShipmentResult}
   */
  buildShipmentResult(partial = {}) {
    return {
      success: Boolean(partial.success),
      trackingNumber: partial.trackingNumber || null,
      bookingReference: partial.bookingReference || null,
      status: partial.status || UNIFIED_STATUSES.BOOKED,
      statusCode: partial.statusCode || null,
      labelUrl: partial.labelUrl || null,
      codAmount: partial.codAmount ?? null,
      weight: partial.weight ?? null,
      pieces: partial.pieces ?? null,
      request: partial.request ?? null,
      response: partial.response ?? null,
      message: partial.message || null,
    };
  }
}

/**
 * @typedef {object} ShipmentResult
 * @property {boolean} success
 * @property {string|null} trackingNumber
 * @property {string|null} bookingReference
 * @property {string} status
 * @property {string|null} statusCode
 * @property {string|null} labelUrl
 * @property {number|null} codAmount
 * @property {number|null} weight
 * @property {number|null} pieces
 * @property {*} request
 * @property {*} response
 * @property {string|null} message
 */

/**
 * @typedef {object} TrackingEvent
 * @property {string} status unified
 * @property {string} [description]
 * @property {string} [location]
 * @property {Date|string|null} [eventTime]
 * @property {*} [raw]
 */

/**
 * @typedef {object} TrackingResult
 * @property {string} trackingNumber
 * @property {string} status unified current
 * @property {string|null} [statusCode]
 * @property {TrackingEvent[]} events
 * @property {*} [raw]
 */

module.exports = BaseCourier;

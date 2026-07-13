/**
 * Leopard Courier (LCS) merchant API driver.
 * Base: https://merchantapi.leopardscourier.com/api/ (prod)
 *       https://merchantapistaging.leopardscourier.com/api/ (sandbox)
 * @module src/couriers/LeopardCourier
 */

const BaseCourier = require("./BaseCourier");
const { UNIFIED_STATUSES, PROVIDERS } = require("./constants");
const { mapLeopardStatus } = require("./statusMap");
const {
  fromProviderMessage,
  invalidCredentials,
  invalidWeight,
  invalidCity,
} = require("./errors");
const { httpRequest } = require("../utils/httpClient");
const courierLogger = require("../utils/courierLogger");

const DEFAULT_PROD = "https://merchantapi.leopardscourier.com/api/";
const DEFAULT_SANDBOX = "https://merchantapistaging.leopardscourier.com/api/";

class LeopardCourier extends BaseCourier {
  constructor(config, options) {
    super(config, options);
    this.providerName = PROVIDERS.LEOPARD;
  }

  get baseUrl() {
    const raw =
      this.config.base_url ||
      (this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD);
    return String(raw).endsWith("/") ? String(raw) : `${raw}/`;
  }

  credentialsPayload() {
    const api_key = this.config.api_key;
    const api_password = this.config.password || this.config.secret;
    if (!api_key || !api_password) {
      throw invalidCredentials(this.providerName);
    }
    return { api_key, api_password };
  }

  endpoint(path) {
    return `${this.baseUrl}${path.replace(/^\//, "")}`;
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  buildBookPacketPayload(order) {
    const settings = this.config.settings || {};
    const shipping = order.shippingAddress || {};
    const customer = order.customer || {};
    const weightGrams = Math.max(
      100,
      Math.round((Number(order.weightKg) || 0.5) * 1000),
    );
    if (weightGrams <= 0) throw invalidWeight(order.weightKg);

    const cityName = shipping.city || order.city || customer.city;
    if (!cityName && !settings.destination_city) {
      throw invalidCity(cityName);
    }

    const codAmount = Math.max(0, Math.round(Number(order.codAmount) || 0));
    const pieces = Math.max(1, Number(order.pieces) || 1);

    return {
      ...this.credentialsPayload(),
      booked_packet_weight: String(weightGrams),
      booked_packet_no_piece: String(pieces),
      booked_packet_collect_amount: String(codAmount),
      booked_packet_order_id: String(order.order_no || order._id),
      origin_city: String(settings.origin_city || "self"),
      destination_city: String(
        settings.destination_city || shipping.city_id || "self",
      ),
      shipment_name_eng: String(settings.shipment_name_eng || "self"),
      shipment_email: String(settings.shipment_email || "self"),
      shipment_phone: String(settings.shipment_phone || "self"),
      shipment_address: String(settings.shipment_address || "self"),
      consignment_name_eng: String(
        shipping.name || customer.name || order.name || "Customer",
      ),
      consignment_email: String(
        shipping.email || order.email || customer.email || "",
      ),
      consignment_phone: String(
        shipping.phone || order.phone || customer.phone || "",
      ),
      consignment_address: String(
        shipping.address || order.address || "Address",
      ),
      special_instructions: String(
        order.description || order.remarks || "n/a",
      ),
    };
  }

  async createShipment(order) {
    // Resolve destination city id by name when needed
    let payload = this.buildBookPacketPayload(order);
    if (payload.destination_city === "self") {
      const cityName =
        order.shippingAddress?.city || order.city || order.customer?.city;
      if (cityName) {
        const cityId = await this.resolveCityId(cityName);
        if (cityId) payload.destination_city = String(cityId);
      }
    }

    const url = this.endpoint("bookPacket/format/json/");

    courierLogger.shipmentRequest({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      url,
      city: order.city || order.shippingAddress?.city || null,
      request: payload,
    });

    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      body: payload,
    });

    courierLogger.shipmentResponse({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      httpStatus: res.status,
      response: res.data,
    });

    const statusOk =
      res.data?.status === 1 ||
      res.data?.status === "1" ||
      res.data?.status === true;

    const tracking =
      res.data?.track_number ||
      res.data?.tracking_number ||
      res.data?.cn ||
      res.data?.packet_cn ||
      res.data?.order?.track_number;

    if (!statusOk || !tracking) {
      const failMsg =
        res.data?.error || res.data?.message || "Leopard booking failed";
      courierLogger.bookingFailed({
        provider: this.providerName,
        orderId: String(order._id),
        orderNo: order.order_no || null,
        httpStatus: res.status,
        message: failMsg,
        request: payload,
        response: res.data,
      });
      throw fromProviderMessage(failMsg, {
        provider: this.providerName,
        details: {
          httpStatus: res.status,
          request: payload,
          response: res.data,
        },
        city: order.city,
        weight: order.weightKg,
      });
    }

    return this.buildShipmentResult({
      success: true,
      trackingNumber: String(tracking),
      bookingReference: String(order.order_no || order._id),
      status: UNIFIED_STATUSES.BOOKED,
      statusCode: "Booked",
      codAmount: Number(payload.booked_packet_collect_amount) || 0,
      weight: Number(order.weightKg) || 0.5,
      pieces: Number(payload.booked_packet_no_piece) || 1,
      request: payload,
      response: res.data,
      message: "SUCCESS",
    });
  }

  async cancelShipment(shipment) {
    const cn = shipment.tracking_number;
    const url = this.endpoint("cancelBookedPackets/format/json/");
    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      body: {
        ...this.credentialsPayload(),
        cn_numbers: String(cn),
      },
    });

    const statusOk =
      res.data?.status === 1 ||
      res.data?.status === "1" ||
      res.data?.status === true;
    if (!statusOk) {
      throw fromProviderMessage(
        res.data?.error || res.data?.message || "Leopard cancel failed",
        { provider: this.providerName, details: res.data },
      );
    }
    return { success: true, raw: res.data };
  }

  async getTracking(trackingNo) {
    courierLogger.trackingRequest({
      provider: this.providerName,
      trackingNo,
    });

    const url = this.endpoint("trackBookedPacket/format/json/");
    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      body: {
        ...this.credentialsPayload(),
        track_numbers: String(trackingNo),
      },
    });

    courierLogger.trackingResponse({
      provider: this.providerName,
      trackingNo,
      httpStatus: res.status,
    });

    const packetList = Array.isArray(res.data?.packet_list)
      ? res.data.packet_list
      : Array.isArray(res.data?.data)
        ? res.data.data
        : [];

    const packet = packetList[0] || res.data || {};
    const details = Array.isArray(packet.TrackingDetail)
      ? packet.TrackingDetail
      : Array.isArray(packet.tracking_detail)
        ? packet.tracking_detail
        : Array.isArray(packet.booked_packet_history)
          ? packet.booked_packet_history
          : [];

    const events = details.map((ev) => {
      const mapped = mapLeopardStatus(ev);
      return {
        status: mapped,
        description:
          ev.Status ||
          ev.status ||
          ev.TrackingDetail ||
          ev.activity ||
          "",
        location: ev.Recieve_Date || ev.location || ev.city || null,
        eventTime: parseLooseDate(
          ev.Activity_Date || ev.date_time || ev.datetime || ev.Recieve_Date,
        ),
        raw: ev,
      };
    });

    if (!events.length && (packet.booked_packet_status || packet.status)) {
      events.push({
        status: mapLeopardStatus(packet),
        description: packet.booked_packet_status || packet.status,
        location: null,
        eventTime: null,
        raw: packet,
      });
    }

    const latest = events[0] || {
      status: UNIFIED_STATUSES.BOOKED,
      description: "",
    };

    return {
      trackingNumber: String(trackingNo),
      status: latest.status,
      statusCode: packet.booked_packet_status || null,
      events,
      raw: res.data,
    };
  }

  async printLabel(shipment) {
    // Leopard does not expose a universal label URL in all accounts;
    // return a portal deep-link style placeholder from settings when available.
    const settings = this.config.settings || {};
    const cn = shipment.tracking_number;
    const labelUrl =
      settings.label_url_template ?
        String(settings.label_url_template).replace("{cn}", cn)
      : null;
    return { labelUrl, raw: { tracking_number: cn } };
  }

  async validateAddress(address = {}) {
    const cities = await this.getCities();
    const cityName = String(address.city || "").toLowerCase();
    if (!cityName) return { valid: false, message: "City is required" };

    const match = cities.find(
      (c) => String(c.name || "").toLowerCase() === cityName,
    );
    if (!match) {
      return {
        valid: false,
        message: `City not served by Leopard: ${cityName}`,
      };
    }
    return {
      valid: true,
      normalized: { city: match.name, city_id: match.id },
    };
  }

  async getCities() {
    if (this._citiesCache?.expiresAt > Date.now()) {
      return this._citiesCache.data;
    }

    const url = this.endpoint("getAllCities/format/json/");
    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      body: this.credentialsPayload(),
    });

    const list = Array.isArray(res.data?.city_list)
      ? res.data.city_list
      : Array.isArray(res.data?.data)
        ? res.data.data
        : [];

    const cities = list.map((c) => ({
      id: c.id || c.city_id,
      name: c.name || c.city_name,
      code: String(c.id || c.city_id || ""),
    }));

    this._citiesCache = {
      data: cities,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    return cities;
  }

  async resolveCityId(cityName) {
    const cities = await this.getCities();
    const needle = String(cityName).trim().toLowerCase();
    const match = cities.find(
      (c) => String(c.name || "").toLowerCase() === needle,
    );
    return match?.id || null;
  }

  async healthCheck() {
    try {
      await this.getCities();
      return { ok: true, message: "Leopard API reachable" };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapStatus(statusOrEvent) {
    if (statusOrEvent && typeof statusOrEvent === "object") {
      return mapLeopardStatus(statusOrEvent);
    }
    return mapLeopardStatus({ status: statusOrEvent });
  }
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

module.exports = LeopardCourier;

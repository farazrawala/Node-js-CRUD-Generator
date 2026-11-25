/**
 * Trax / Sonic merchant API driver (SONIC v2.0).
 * Auth: header `Authorization` = API key from the Trax profile screen.
 * Live: https://sonic.pk  ·  Sandbox: https://app.sonic.pk
 * Docs: docs/Courier/Trax API Document - SONIC Version 2.0.pdf
 * @module src/couriers/TraxCourier
 */

const BaseCourier = require("./BaseCourier");
const { UNIFIED_STATUSES, PROVIDERS } = require("./constants");
const { mapGenericStatus } = require("./statusMap");
const {
  CourierError,
  fromProviderMessage,
  invalidCredentials,
  invalidCity,
} = require("./errors");
const { httpRequest } = require("../utils/httpClient");
const courierLogger = require("../utils/courierLogger");
const { courierRemarksText } = require("../utils/orderContextLoader");

const DEFAULT_PROD = "https://sonic.pk";
const DEFAULT_SANDBOX = "https://app.sonic.pk";

class TraxCourier extends BaseCourier {
  constructor(config, options) {
    super(config, options);
    this.providerName = PROVIDERS.TRAX;
    this._cities = null;
  }

  get baseUrl() {
    if (this._forceOrigin) return this._forceOrigin;
    let raw = String(this.config.base_url || this.config.url || "").trim();
    // A profile API key is issued for live sonic.pk. The global COURIER_SANDBOX
    // flag must not send that key to app.sonic.pk (Trax rejects it as invalid).
    if (!raw || /sonic\.pk/i.test(raw)) {
      raw = /app\.sonic\.pk/i.test(raw) ? DEFAULT_SANDBOX : DEFAULT_PROD;
    }
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
  }

  endpoint(path) {
    const p = String(path || "").replace(/^\//, "");
    return `${this.baseUrl}/api/${p}`;
  }

  /**
   * API key from Courier Integration → Token (or password / login).
   * @returns {string}
   */
  getApiKey() {
    const key = String(
      this.config.token ||
        this.config.settings?.token ||
        this.config.api_key ||
        this.config.settings?.api_key ||
        this.config.username ||
        this.config.password ||
        "",
    )
      .trim()
      .replace(/^bearer\s+/i, "");
    if (!key) {
      throw invalidCredentials(
        this.providerName,
        "Trax API key is required. Set Token on the courier integration.",
      );
    }
    return key;
  }

  authHeaders(extra = {}) {
    return {
      Authorization: this.getApiKey(),
      Accept: "application/json",
      ...extra,
    };
  }

  extractErrorMessage(res, fallback = "Trax request failed") {
    const data = res?.data;
    const httpStatus = Number(res?.status) || 0;
    if (data && typeof data === "object") {
      const msg = data.message || data.error || data.Message || null;
      if (msg) return String(msg);
    }
    if (typeof data === "string" && data.trim()) {
      const plain = data.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (plain) return plain.slice(0, 240);
    }
    return httpStatus >= 400 ? `HTTP ${httpStatus}: ${fallback}` : fallback;
  }

  /**
   * Keep Trax's own message. fromProviderMessage rewrites "Invalid API Token"
   * into a generic "Authentication failed", which hides the real cause.
   */
  providerError(res, fallback) {
    const message = this.extractErrorMessage(res, fallback);
    return new CourierError(message, {
      code: /invalid api token|unauthor/i.test(message)
        ? "AUTH_ERROR"
        : "PROVIDER_ERROR",
      httpStatus: /invalid api token|unauthor/i.test(message) ? 401 : 502,
      details: { response: res?.data },
    });
  }

  /** Trax uses status 0 for success. */
  isOk(data) {
    if (!data || typeof data !== "object") return false;
    const code = data.status;
    return code === 0 || code === "0";
  }

  async request(path, { method = "GET", query, body } = {}, optsRetried = false) {
    const qs = query
      ? `?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(query).filter(([, v]) => v != null && v !== ""),
          ),
        ).toString()}`
      : "";
    const url = `${this.endpoint(path)}${qs}`;
    const headers = this.authHeaders();
    let payload;
    if (body && method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(
        Object.fromEntries(
          Object.entries(body)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => [k, String(v)]),
        ),
      ).toString();
    }
    const res = await httpRequest(url, {
      method,
      provider: this.providerName,
      headers,
      body: payload,
    });
    const message = this.extractErrorMessage(res, "");
    // Live key on the sandbox host (or the reverse) comes back as a bad token.
    if (
      !optsRetried &&
      /invalid api token/i.test(message) &&
      /sonic\.pk/i.test(this.baseUrl)
    ) {
      this._forceOrigin = /app\.sonic\.pk/i.test(this.baseUrl)
        ? DEFAULT_PROD
        : DEFAULT_SANDBOX;
      return this.request(path, { method, query, body }, true);
    }
    return { ...res, url };
  }

  normalizePkMobile(raw, fallback = "03000000000") {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.startsWith("92") && digits.length >= 12) {
      digits = `0${digits.slice(2)}`;
    }
    if (digits.length === 10 && digits.startsWith("3")) digits = `0${digits}`;
    if (digits.length > 11) digits = digits.slice(-11);
    if (digits.length !== 11 || !digits.startsWith("03")) return fallback;
    return digits;
  }

  async getCities() {
    const cacheKey = `${this.baseUrl || ""}|${this.getApiKey?.() || ""}`;
    if (!TraxCourier._sharedCities) TraxCourier._sharedCities = new Map();
    const shared = TraxCourier._sharedCities.get(cacheKey);
    if (shared) {
      this._cities = shared;
      return shared;
    }
    if (this._cities) return this._cities;
    const res = await this.request("cities");
    if (res.status >= 400 || !this.isOk(res.data)) {
      throw this.providerError(res, "Trax city list failed");
    }
    const cities = Array.isArray(res.data?.cities) ? res.data.cities : [];
    this._cities = cities.map((c) => ({
      id: c.id,
      name: String(c.name || "").trim(),
      delivery: c.delivery || null,
      pickup: Boolean(c.pickup),
    }));
    if (!TraxCourier._sharedCities) TraxCourier._sharedCities = new Map();
    TraxCourier._sharedCities.set(cacheKey, this._cities);
    return this._cities;
  }

  async resolveCityId(cityName) {
    const wanted = String(cityName || "").trim().toLowerCase();
    if (!wanted) throw invalidCity(cityName);
    const cities = await this.getCities();
    const exact = cities.find((c) => c.name.toLowerCase() === wanted);
    if (exact) return exact.id;
    const loose = cities.find(
      (c) =>
        c.name.toLowerCase().includes(wanted) ||
        wanted.includes(c.name.toLowerCase()),
    );
    if (loose) return loose.id;
    throw invalidCity(cityName);
  }

  async listPickupAddresses() {
    const res = await this.request("pickup_addresses");
    if (res.status >= 400 || !this.isOk(res.data)) {
      throw this.providerError(res, "Trax pickup addresses failed");
    }
    return Array.isArray(res.data?.pickup_addresses)
      ? res.data.pickup_addresses
      : [];
  }

  async resolvePickupAddressId() {
    const settings = this.config.settings || {};
    const explicit =
      settings.pickup_address_id ||
      settings.pickupAddressId ||
      this.config.pickup_location ||
      null;
    if (explicit && /^\d+$/.test(String(explicit).trim())) {
      return Number(explicit);
    }
    const rows = await this.listPickupAddresses();
    const active = rows.filter((r) => r && r.status !== 0 && r.status !== "0");
    const chosen =
      active.find((r) => r.default === true || r.default === 1) || active[0];
    if (!chosen?.id) {
      throw fromProviderMessage(
        "No Trax pickup address on this account. Add one in the Trax portal, then book again.",
        { provider: this.providerName, httpStatus: 400 },
      );
    }
    return Number(chosen.id);
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  async buildBookBody(order) {
    const settings = this.config.settings || {};
    const shipping = order.shippingAddress || {};
    const customer = order.customer || {};
    const cityName =
      order.city || shipping.city || customer.city || settings.default_city;
    const cityId = await this.resolveCityId(cityName);
    const pickupId = await this.resolvePickupAddressId();

    const qty = Math.min(
      10,
      Math.max(1, Math.round(Number(order.pieces) || 1)),
    );
    const cod = Math.max(0, Math.round(Number(order.codAmount) || 0));
    const weight = Math.max(0.5, Number(order.weight) || 0.5);
    const description = String(
      (order.items || [])
        .map((i) => {
          const name = String(i?.name || "Item").trim() || "Item";
          const q = Number(i?.qty ?? i?.quantity ?? 1) || 1;
          return `${name} x ${q}`;
        })
        .filter(Boolean)
        .join(", ") ||
        order.contentDesc ||
        "Goods",
    ).slice(0, 190);

    const email = String(
      shipping.email || customer.email || order.email || "customer@sonic.pk",
    ).trim();

    const today = new Date();
    const pickupDate = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");

    return {
      service_type_id: Number(settings.service_type_id || 1),
      pickup_address_id: pickupId,
      information_display: Number(settings.information_display ?? 0),
      consignee_city_id: cityId,
      consignee_name: String(
        shipping.name || customer.name || order.name || "Customer",
      )
        .trim()
        .slice(0, 100),
      consignee_address: String(
        shipping.address || order.address || "Address",
      )
        .trim()
        .slice(0, 190),
      consignee_phone_number_1: this.normalizePkMobile(
        shipping.phone || order.phone || customer.phone,
      ),
      consignee_email_address: email.slice(0, 120),
      order_id: String(order.order_no || order._id || "").slice(0, 100),
      item_product_type_id: Number(settings.item_product_type_id || 24),
      item_description: description,
      item_quantity: qty,
      item_insurance: 0,
      pickup_date: pickupDate,
      special_instructions: courierRemarksText(order).slice(0, 190),
      estimated_weight: weight,
      shipping_mode_id: Number(settings.shipping_mode_id || 1),
      amount: cod,
      payment_mode_id: Number(
        settings.payment_mode_id || (cod > 0 ? 1 : 4),
      ),
      charges_mode_id: Number(settings.charges_mode_id || 4),
      delivery_type_id: Number(settings.delivery_type_id || 1),
      pieces_quantity: qty,
    };
  }

  async createShipment(order) {
    const body = await this.buildBookBody(order);
    const res = await this.request("shipment/book", { method: "POST", body });
    if (res.status >= 400 || !this.isOk(res.data)) {
      throw this.providerError(res, "Trax booking failed");
    }
    const tracking =
      res.data?.["tracking number"] ||
      res.data?.tracking_number ||
      res.data?.trackingNumber ||
      null;
    return this.buildShipmentResult({
      success: Boolean(tracking),
      trackingNumber: tracking ? String(tracking).trim() : null,
      status: UNIFIED_STATUSES.BOOKED,
      codAmount: body.amount,
      weight: body.estimated_weight,
      pieces: body.pieces_quantity,
      request: body,
      response: res.data,
      message: res.data?.message || "Shipment has been Booked",
    });
  }

  async cancelShipment(shipment) {
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing Trax tracking number for cancel", {
        provider: this.providerName,
      });
    }
    const res = await this.request("shipment/cancel", {
      method: "POST",
      body: { tracking_number: cn },
    });
    if (res.status >= 400 || !this.isOk(res.data)) {
      throw this.providerError(res, "Trax cancel failed");
    }
    return { success: true, raw: res.data };
  }

  async getTracking(trackingNo) {
    const cn = String(trackingNo || "").trim();
    const url = this.endpoint(
      `shipment/track?${new URLSearchParams({
        tracking_number: cn,
        type: "0",
      }).toString()}`,
    );
    courierLogger.trackingRequest({
      provider: this.providerName,
      trackingNo: cn,
      url,
    });
    // type 0 is shipper tracking and Trax answers "Error(s) in Input" when the
    // CN was booked on another account (Flaship books Trax on its own shipper).
    // type 1 is general/consignee tracking and still returns tracking_history.
    let res = await this.request("shipment/track", {
      query: { tracking_number: cn, type: 0 },
    });
    const firstMessage = this.extractErrorMessage(res, "");
    if (
      (res.status >= 400 || !this.isOk(res.data)) &&
      /error\(s\) in input/i.test(firstMessage)
    ) {
      res = await this.request("shipment/track", {
        query: { tracking_number: cn, type: 1 },
      });
    }
    courierLogger.trackingResponse({
      provider: this.providerName,
      trackingNo: cn,
      httpStatus: res.status,
      url,
    });
    if (res.status >= 400 || !this.isOk(res.data)) {
      throw this.providerError(res, "Trax tracking failed");
    }
    const history = Array.isArray(res.data?.details?.tracking_history)
      ? res.data.details.tracking_history
      : [];
    const events = history.map((row) => ({
      status: this.mapStatus(row.status),
      description: [row.status, row.status_reason].filter(Boolean).join(" — "),
      eventTime: row.timestamp
        ? new Date(Number(row.timestamp) * 1000)
        : row.date_time || null,
      raw: row,
    }));
    const latest = history[0] || {};
    return {
      trackingNumber: cn,
      status: this.mapStatus(latest.status || res.data?.current_status),
      events,
      raw: res.data,
    };
  }

  async printLabel(shipment) {
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing Trax tracking number for airway bill", {
        provider: this.providerName,
      });
    }
    const url = this.endpoint(
      `shipment/air_waybill?${new URLSearchParams({
        tracking_number: cn,
        type: "1",
      }).toString()}`,
    );
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
      responseType: "buffer",
    });
    if (res.status >= 400 || !Buffer.isBuffer(res.data)) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "Trax airway bill failed"),
        { provider: this.providerName },
      );
    }
    return {
      labelUrl: url,
      labelBase64: res.data.toString("base64"),
      raw: { bytes: res.data.length },
    };
  }

  async validateAddress(address = {}) {
    try {
      const id = await this.resolveCityId(address.city || address.cityName);
      return { valid: true, normalized: { ...address, city_id: id } };
    } catch (err) {
      return { valid: false, message: err.message };
    }
  }

  async healthCheck() {
    try {
      this.getApiKey();
      const cities = await this.getCities();
      return {
        ok: cities.length > 0,
        message: cities.length
          ? "Trax auth OK"
          : "Trax auth OK but city list was empty",
      };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapStatus(statusOrEvent) {
    const text =
      statusOrEvent && typeof statusOrEvent === "object"
        ? statusOrEvent.status || statusOrEvent.description || ""
        : statusOrEvent;
    return mapGenericStatus(text);
  }
}

module.exports = TraxCourier;

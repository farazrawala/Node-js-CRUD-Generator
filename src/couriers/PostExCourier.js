/**
 * PostEx COD Merchant API driver (v4.1.9).
 * Auth: header `token` (merchant API token).
 * Docs: docs/Courier/PostEx-COD_API_Integration_Guide_V4.1.9.pdf
 * @module src/couriers/PostExCourier
 */

const BaseCourier = require("./BaseCourier");
const { UNIFIED_STATUSES, PROVIDERS } = require("./constants");
const { mapPostExStatus } = require("./statusMap");
const {
  fromProviderMessage,
  invalidCredentials,
  invalidCity,
} = require("./errors");
const { httpRequest } = require("../utils/httpClient");
const courierLogger = require("../utils/courierLogger");

const DEFAULT_PROD = "https://api.postex.pk/services/integration/api";
/** Sandbox / test merchant API (same host; use sandbox token from PostEx). */
const DEFAULT_SANDBOX = "https://api.postex.pk/services/integration/api";

class PostExCourier extends BaseCourier {
  constructor(config, options) {
    super(config, options);
    this.providerName = PROVIDERS.POSTEX;
  }

  get baseUrl() {
    const raw =
      this.config.base_url ||
      this.config.url ||
      (this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD);
    return String(raw)
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/order(\/.*)?$/i, "");
  }

  get baseUrl() {
    let raw = String(
      this.config.base_url ||
        this.config.url ||
        (this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD),
    ).trim();

    // Host-only URL → full PostEx integration base
    if (/^https?:\/\/api\.postex\.pk\/?$/i.test(raw)) {
      raw = this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD;
    }

    return raw
      .replace(/\/+$/, "")
      .replace(/\/order(\/.*)?$/i, "");
  }

  /**
   * Build a user-facing error from PostEx JSON or HTML/nginx responses.
   * @param {{ status?: number, data?: * }} res
   * @param {string} fallback
   * @returns {string}
   */
  extractErrorMessage(res, fallback = "PostEx request failed") {
    const data = res?.data;
    const httpStatus = Number(res?.status) || 0;

    if (data && typeof data === "object") {
      const statusMessage =
        data.statusMessage || data.message || data.error || data.Error || null;
      const statusCode = data.statusCode != null ? String(data.statusCode) : "";
      if (statusMessage && statusCode) {
        return `PostEx ${statusCode}: ${statusMessage}`;
      }
      if (statusMessage) return String(statusMessage);
      if (statusCode) return `PostEx statusCode ${statusCode}`;
    }

    if (typeof data === "string" && data.trim()) {
      const title = data.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (title) {
        const t = title[1].replace(/\s+/g, " ").trim();
        return httpStatus ? `HTTP ${httpStatus}: ${t}` : t;
      }
      const h1 = data.match(/<h1>\s*([^<]+?)\s*<\/h1>/i);
      if (h1) {
        const t = h1[1].replace(/\s+/g, " ").trim();
        return httpStatus ? `HTTP ${httpStatus}: ${t}` : t;
      }
      const plain = data.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (plain) {
        return httpStatus
          ? `HTTP ${httpStatus}: ${plain.slice(0, 200)}`
          : plain.slice(0, 200);
      }
    }

    if (httpStatus >= 400) return `HTTP ${httpStatus}: ${fallback}`;
    return fallback;
  }

  /**
   * Merchant token from Courier Integration → Token field.
   * @returns {string}
   */
  getToken() {
    const token = String(
      this.config.token ||
        this.config.settings?.token ||
        this.config.api_key ||
        this.config.password ||
        "",
    ).trim();
    if (!token) {
      throw invalidCredentials(
        this.providerName,
        "PostEx API token is required. Set Token on the courier integration.",
      );
    }
    return token;
  }

  authHeaders(extra = {}) {
    return {
      token: this.getToken(),
      Accept: "application/json",
      ...extra,
    };
  }

  endpoint(path) {
    const p = String(path || "").replace(/^\//, "");
    return `${this.baseUrl}/${p}`;
  }

  /**
   * Normalize Pakistan mobile to 03XXXXXXXXX for PostEx.
   * @param {*} raw
   * @param {string} [fallback="03000000000"]
   */
  normalizePkMobile(raw, fallback = "03000000000") {
    const text = String(raw ?? "").trim();
    if (!text || /^n\/?a$/i.test(text) || /^null$/i.test(text) || text === "-") {
      return fallback;
    }
    let digits = text.replace(/\D/g, "");
    if (digits.startsWith("92") && digits.length >= 12) {
      digits = `0${digits.slice(2)}`;
    }
    if (digits.length === 10 && digits.startsWith("3")) {
      digits = `0${digits}`;
    }
    if (digits.length > 11) digits = digits.slice(-11);
    if (digits.length !== 11 || !digits.startsWith("0")) return fallback;
    return digits;
  }

  isSuccessStatus(data) {
    const code = String(data?.statusCode ?? data?.status ?? "").trim();
    return code === "200" || code === "201" || Number(code) === 200;
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  buildCreateOrderPayload(order) {
    const settings = this.config.settings || {};
    const shipping = order.shippingAddress || {};
    const customer = order.customer || {};
    const cityName =
      shipping.city || order.city || customer.city || settings.default_city;
    if (!cityName) throw invalidCity(cityName);

    // PostEx: items = parcel count; API requires greater than 0 and less than 100.
    const items = Math.min(
      99,
      Math.max(1, Math.round(Number(order.pieces) || 1)),
    );
    const invoiceDivision = Math.max(
      1,
      Math.round(Number(settings.invoiceDivision || settings.invoice_division || 1)),
    );
    const codAmount = Math.max(0, Math.round(Number(order.codAmount) || 0));

    const payload = {
      cityName: String(cityName).trim(),
      customerName: String(
        shipping.name || customer.name || order.name || "Customer",
      ).trim(),
      customerPhone: this.normalizePkMobile(
        shipping.phone || order.phone || customer.phone,
      ),
      deliveryAddress: String(
        shipping.address || order.address || "Address",
      ).trim(),
      invoiceDivision,
      invoicePayment: codAmount,
      items,
      orderDetail: String(
        order.contentDesc ||
          order.description ||
          (order.items || [])
            .map((i) => `${i.qty || 1}x ${i.name || "Item"}`)
            .join(", ") ||
          "Goods",
      ).slice(0, 500),
      orderRefNumber: String(order.order_no || order._id).slice(0, 50),
      orderType: String(settings.orderType || settings.order_type || "Normal"),
      transactionNotes: String(order.remarks || order.description || "").slice(
        0,
        500,
      ),
    };

    const pickupCode =
      settings.pickupAddressCode ||
      settings.pickup_address_code ||
      this.config.pickup_location ||
      this.config.account_no ||
      null;
    if (pickupCode) payload.pickupAddressCode = String(pickupCode);

    const storeCode =
      settings.storeAddressCode || settings.store_address_code || null;
    if (storeCode) payload.storeAddressCode = String(storeCode);

    const weight = Number(order.weightKg);
    if (Number.isFinite(weight) && weight > 0) {
      payload.bookingWeight = weight;
    }

    return payload;
  }

  async createShipment(order) {
    const payload = this.buildCreateOrderPayload(order);
    const url = this.endpoint("order/v3/create-order");

    courierLogger.shipmentRequest({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      url,
      city: payload.cityName,
      request: payload,
    });

    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: payload,
    });

    courierLogger.shipmentResponse({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      httpStatus: res.status,
      response: res.data,
    });

    const tracking =
      res.data?.dist?.trackingNumber ||
      res.data?.dist?.tracking_number ||
      res.data?.trackingNumber;

    if (!this.isSuccessStatus(res.data) || !tracking) {
      const failMsg = this.extractErrorMessage(res, "PostEx booking failed");
      courierLogger.bookingFailed({
        provider: this.providerName,
        orderId: String(order._id),
        orderNo: order.order_no || null,
        httpStatus: res.status,
        message: failMsg,
        url,
        request: payload,
        response: res.data,
      });
      throw fromProviderMessage(failMsg, {
        provider: this.providerName,
        details: {
          httpStatus: res.status,
          url,
          response: res.data,
          statusMessage:
            typeof res.data === "object" ? res.data?.statusMessage : null,
        },
        city: payload.cityName,
        httpStatus: res.status >= 400 ? res.status : 502,
      });
    }

    return this.buildShipmentResult({
      success: true,
      trackingNumber: String(tracking),
      bookingReference: String(payload.orderRefNumber),
      status: UNIFIED_STATUSES.BOOKED,
      statusCode: res.data?.dist?.orderStatus || "UnBooked",
      codAmount: payload.invoicePayment,
      weight: Number(order.weightKg) || null,
      pieces: payload.items,
      request: payload,
      response: res.data,
      message: String(res.data?.statusMessage || "SUCCESS"),
    });
  }

  async cancelShipment(shipment) {
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing PostEx tracking number for cancel", {
        provider: this.providerName,
      });
    }

    const url = this.endpoint("order/v1/cancel-order");
    const res = await httpRequest(url, {
      method: "PUT",
      provider: this.providerName,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: { trackingNumber: cn },
    });

    const ok =
      res.status < 400 &&
      (this.isSuccessStatus(res.data) ||
        res.data == null ||
        typeof res.data === "string");
    if (!ok) {
      throw fromProviderMessage(
        res.data?.statusMessage || res.data?.message || "PostEx cancel failed",
        { provider: this.providerName, details: res.data },
      );
    }
    return { success: true, raw: res.data };
  }

  async getTracking(trackingNo) {
    const cn = String(trackingNo || "").trim();
    const url = this.endpoint(`order/v1/track-order/${encodeURIComponent(cn)}`);

    courierLogger.trackingRequest({
      provider: this.providerName,
      trackingNo: cn,
      url,
    });

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });

    courierLogger.trackingResponse({
      provider: this.providerName,
      trackingNo: cn,
      httpStatus: res.status,
      url,
    });

    const dist =
      res.data?.dist && typeof res.data.dist === "object"
        ? res.data.dist
        : res.data && typeof res.data === "object"
          ? res.data
          : {};
    const hasPayload = Boolean(
      dist.trackingNumber ||
        dist.transactionStatus ||
        (Array.isArray(dist.trackDetail) && dist.trackDetail.length) ||
        (Array.isArray(dist.transactionHistory) && dist.transactionHistory.length),
    );
    const bodyFailed =
      res.data &&
      typeof res.data === "object" &&
      res.data.statusCode != null &&
      !this.isSuccessStatus(res.data);

    if (res.status >= 400 || bodyFailed || !hasPayload) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "PostEx tracking failed"),
        {
          provider: this.providerName,
          details: {
            httpStatus: res.status,
            url,
            response: res.data,
            statusMessage:
              typeof res.data === "object" ? res.data?.statusMessage : null,
          },
          httpStatus: res.status >= 400 ? res.status : 502,
          retryable: res.status >= 500,
        },
      );
    }
    const history = Array.isArray(dist.trackDetail)
      ? dist.trackDetail
      : Array.isArray(dist.transactionHistory)
        ? dist.transactionHistory
        : Array.isArray(dist.trackingHistory)
          ? dist.trackingHistory
          : Array.isArray(dist.history)
            ? dist.history
            : [];

    const events = history.map((ev) => {
      const mapped = mapPostExStatus(ev);
      return {
        status: mapped,
        description:
          ev.transactionStatus ||
          ev.status ||
          ev.message ||
          ev.remarks ||
          "",
        location: ev.station || ev.cityName || ev.location || null,
        eventTime: parseLooseDate(
          ev.transactionDate || ev.dateTime || ev.datetime || ev.createdAt,
        ),
        raw: ev,
      };
    });

    events.sort((a, b) => {
      const ta = a.eventTime ? new Date(a.eventTime).getTime() : 0;
      const tb = b.eventTime ? new Date(b.eventTime).getTime() : 0;
      return tb - ta;
    });

    if (!events.length) {
      events.push({
        status: mapPostExStatus(dist),
        description:
          dist.transactionStatus || dist.orderStatus || dist.statusMessage || "",
        location: dist.destination || dist.cityName || null,
        eventTime: parseLooseDate(dist.transactionDate || dist.orderDate),
        raw: dist,
      });
    }

    const latest = events[0] || {
      status: UNIFIED_STATUSES.BOOKED,
      description: "",
    };

    const lastStatus =
      dist.transactionStatus ||
      dist.orderStatus ||
      latest.description ||
      latest.status ||
      null;

    return {
      trackingNumber: String(cn),
      status: latest.status,
      statusCode: lastStatus,
      lastStatus,
      events,
      raw: res.data,
    };
  }

  /**
   * Airway Bill API — returns PDF for up to 10 tracking numbers.
   * GET /order/v1/get-invoice?trackingNumbers=CX-...
   * @param {object} shipment
   */
  async printLabel(shipment) {
    const cn = String(
      shipment.tracking_number ||
        shipment.trackingNumber ||
        shipment.consignmentno ||
        "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage(
        "Missing PostEx tracking number for airway bill",
        { provider: this.providerName },
      );
    }

    const qs = new URLSearchParams({ trackingNumbers: cn });
    const url = this.endpoint(`order/v1/get-invoice?${qs.toString()}`);

    courierLogger.log("info", "postex_airway_bill", {
      provider: this.providerName,
      trackingNo: cn,
      url,
    });

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      responseType: "buffer",
      headers: this.authHeaders({
        Accept: "application/pdf, application/json, */*",
      }),
    });

    if (res.status >= 400) {
      let msg = `PostEx airway bill failed (HTTP ${res.status})`;
      if (Buffer.isBuffer(res.data)) {
        try {
          const parsed = JSON.parse(res.data.toString("utf8"));
          msg = parsed?.statusMessage || parsed?.message || msg;
        } catch {
          /* keep default */
        }
      } else if (res.data && typeof res.data === "object") {
        msg = res.data.statusMessage || res.data.message || msg;
      }
      throw fromProviderMessage(String(msg), {
        provider: this.providerName,
        details: Buffer.isBuffer(res.data)
          ? {
              bytes: res.data.length,
              preview: res.data.toString("utf8").slice(0, 300),
            }
          : res.data,
        httpStatus: res.status,
      });
    }

    if (Buffer.isBuffer(res.data)) {
      const buf = res.data;
      const head = buf.slice(0, 8).toString("utf8");
      if (head.startsWith("%PDF")) {
        return {
          labelUrl: null,
          labelBase64: buf.toString("base64"),
          contentType: "application/pdf",
          raw: { message: "pdf_binary", bytes: buf.length },
        };
      }

      const asText = buf.toString("utf8").trim();
      let json = null;
      try {
        json = JSON.parse(asText);
      } catch {
        json = null;
      }
      if (json && typeof json === "object") {
        const fromJson = this._extractLabelPayload(json);
        if (fromJson) return fromJson;
        throw fromProviderMessage(
          json.statusMessage || json.message || "PostEx airway bill failed",
          { provider: this.providerName, details: json },
        );
      }

      if (/^https?:\/\//i.test(asText)) {
        return {
          labelUrl: asText,
          labelBase64: null,
          contentType: "application/pdf",
          raw: { labelurl: asText },
        };
      }

      throw fromProviderMessage(
        "PostEx airway bill response was not a valid PDF",
        {
          provider: this.providerName,
          details: {
            bytes: buf.length,
            contentType: res.contentType,
            preview: asText.slice(0, 300),
          },
        },
      );
    }

    if (res.data && typeof res.data === "object") {
      const fromJson = this._extractLabelPayload(res.data);
      if (fromJson) return fromJson;
    }

    throw fromProviderMessage("PostEx airway bill returned no PDF", {
      provider: this.providerName,
      details: res.data,
    });
  }

  /**
   * @private
   */
  _extractLabelPayload(json) {
    if (!json || typeof json !== "object") return null;
    const labelUrl =
      json.labelUrl ||
      json.labelurl ||
      json.pdfUrl ||
      json.pdfurl ||
      json.dist?.labelUrl ||
      json.dist?.pdfUrl ||
      null;
    let base64 =
      json.pdfBase64 ||
      json.base64 ||
      json.dist?.pdfBase64 ||
      json.dist?.base64 ||
      null;

    if (typeof base64 === "string") {
      base64 = base64
        .replace(/^data:application\/pdf;base64,/i, "")
        .replace(/\s+/g, "");
      try {
        const decoded = Buffer.from(base64, "base64");
        if (
          decoded.length < 20 ||
          !decoded.slice(0, 5).toString("utf8").startsWith("%PDF")
        ) {
          base64 = null;
        }
      } catch {
        base64 = null;
      }
    }

    if (labelUrl || base64) {
      return {
        labelUrl: labelUrl || null,
        labelBase64: base64 || null,
        contentType: "application/pdf",
        raw: json,
      };
    }
    return null;
  }

  async validateAddress(address = {}) {
    const cities = await this.getCities("Delivery");
    const cityName = String(address.city || address.cityName || "").toLowerCase();
    if (!cityName) return { valid: false, message: "City is required" };
    const match = cities.find(
      (c) => String(c.name || "").toLowerCase() === cityName,
    );
    if (!match) {
      return { valid: false, message: `City not served by PostEx: ${cityName}` };
    }
    return { valid: true, normalized: { cityName: match.name } };
  }

  async getCities(operationalCityType = "Delivery") {
    const cacheKey = `postex_cities_${operationalCityType || "all"}`;
    if (this._citiesCache?.[cacheKey]?.expiresAt > Date.now()) {
      return this._citiesCache[cacheKey].data;
    }

    let url = this.endpoint("order/v2/get-operational-city");
    if (operationalCityType) {
      url += `?operationalCityType=${encodeURIComponent(operationalCityType)}`;
    }

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });

    const list = Array.isArray(res.data?.dist) ? res.data.dist : [];
    const cities = list.map((c) => ({
      name: c.operationalCityName || c.cityName || c.name,
      code: c.operationalCityName || c.cityName || c.name,
      isPickup: String(c.isPickupCity) === "true" || c.isPickupCity === true,
      isDelivery:
        String(c.isDeliveryCity) === "true" || c.isDeliveryCity === true,
    }));

    this._citiesCache = this._citiesCache || {};
    this._citiesCache[cacheKey] = {
      data: cities,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    return cities;
  }

  async healthCheck() {
    try {
      this.getToken();
      await this.getCities("Delivery");
      return { ok: true, message: "PostEx auth OK" };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapStatus(statusOrEvent) {
    if (statusOrEvent && typeof statusOrEvent === "object") {
      return mapPostExStatus(statusOrEvent);
    }
    return mapPostExStatus({ status: statusOrEvent });
  }
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

module.exports = PostExCourier;

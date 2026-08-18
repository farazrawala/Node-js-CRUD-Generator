/**
 * Flaship / Flagship merchant API driver.
 * Auth: header `X-API-KEY`.
 * Docs: docs/Courier/Flaship_API_Documentation.pdf
 * @module src/couriers/FlagshipCourier
 */

const BaseCourier = require("./BaseCourier");
const { UNIFIED_STATUSES, PROVIDERS } = require("./constants");
const { mapFlashipStatus } = require("./statusMap");
const {
  CourierError,
  fromProviderMessage,
  invalidCredentials,
  invalidCity,
} = require("./errors");
const { httpRequest } = require("../utils/httpClient");
const courierLogger = require("../utils/courierLogger");

const DEFAULT_HOST = "https://partners.flaship.pk";

function resolveFlashipOrigin(config = {}) {
  let raw = String(config.base_url || config.url || DEFAULT_HOST).trim();
  raw = raw.replace(/\/+$/, "");
  raw = raw.replace(/\/mr(\/api)?$/i, "");
  if (!raw) return DEFAULT_HOST;

  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = String(parsed.hostname || "").toLowerCase();
    // Common mix-up: public brand domain flagship.pk does not host the API.
    if (!host || host === "flagship.pk" || host === "www.flagship.pk") {
      return DEFAULT_HOST;
    }
    if (host === "partners.flaship.pk" || host.endsWith(".flaship.pk")) {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    /* fall through */
  }

  if (/^https?:\/\/partners\.flaship\.pk/i.test(raw)) return DEFAULT_HOST;
  return DEFAULT_HOST;
}

class FlagshipCourier extends BaseCourier {
  constructor(config, options) {
    super(config, options);
    this.providerName = PROVIDERS.FLAGSHIP;
  }

  /**
   * Origin host; paths are under `/mr/...`.
   */
  get origin() {
    return resolveFlashipOrigin(this.config);
  }

  get baseUrl() {
    return `${this.origin}/mr`;
  }

  endpoint(path) {
    const p = String(path || "").replace(/^\//, "");
    return `${this.baseUrl}/${p}`;
  }

  /**
   * Merchant API key from Courier Integration → Token (or ID / API Key).
   */
  getApiKey() {
    const key = String(
      this.config.token ||
        this.config.settings?.token ||
        this.config.api_key ||
        this.config.settings?.api_key ||
        this.config.password ||
        this.config.username ||
        "",
    ).trim();
    if (!key) {
      throw invalidCredentials(
        this.providerName,
        "Flaship API key is required. Set Token on the courier integration.",
      );
    }
    return key;
  }

  authHeaders(extra = {}) {
    return {
      "X-API-KEY": this.getApiKey(),
      Accept: "application/json",
      ...extra,
    };
  }

  extractErrorMessage(res, fallback = "Flaship request failed") {
    const data = res?.data;
    const httpStatus = Number(res?.status) || 0;

    if (data && typeof data === "object") {
      const msg =
        data.error ||
        data.message ||
        data.reason ||
        data.detail ||
        data.statusMessage ||
        null;
      if (msg) return String(msg);
    }

    if (typeof data === "string" && data.trim()) {
      const title = data.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (title) {
        const t = title[1].replace(/\s+/g, " ").trim();
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

  isSuccess(data) {
    if (data == null) return false;
    if (typeof data !== "object") return false;
    if (data.success === true || data.status === true) return true;
    if (data.success === false || data.status === false) return false;
    return Boolean(data.trackingId || data.tracking_number || data.orderNo);
  }

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

  /**
   * Fetch pickup addresses + assigned courier companies (cached).
   */
  async getCompanyList() {
    if (this._companyList?.expiresAt > Date.now()) {
      return this._companyList.data;
    }
    const url = this.endpoint("company_list/");
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });
    if (res.status >= 400 || res.data?.success === false) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "Flaship company list failed"),
        {
          provider: this.providerName,
          details: { httpStatus: res.status, url, response: res.data },
          httpStatus: res.status >= 400 ? res.status : 502,
        },
      );
    }
    this._companyList = {
      data: res.data || {},
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return this._companyList.data;
  }

  bookingChoice(order = {}) {
    return order.bookingOptions && typeof order.bookingOptions === "object"
      ? order.bookingOptions
      : {};
  }

  /**
   * UI picker payload from GET /mr/company_list/.
   */
  async getBookingOptions() {
    const list = await this.getCompanyList();
    const companies = Array.isArray(list.companies)
      ? list.companies.map((c) => String(c).trim()).filter(Boolean)
      : [];
    const rateCards =
      list.rateCards && typeof list.rateCards === "object" ? list.rateCards : {};
    const pickupAddresses = (
      Array.isArray(list.pickupAddress) ? list.pickupAddress : []
    ).map((a) => ({
      id: a?.id,
      address: a?.address || "",
      is_default: Boolean(a?.is_default),
    }));

    return {
      requires_company: true,
      prompt: "Which company would you like to book?",
      companies,
      rate_cards: rateCards,
      pickup_addresses: pickupAddresses,
    };
  }

  matchCompanyName(chosen, companies) {
    const key = String(chosen || "").trim().toLowerCase();
    if (!key) return "";
    const exact = companies.find((c) => String(c).toLowerCase() === key);
    return exact || "";
  }

  async resolveCourierCompany(order) {
    const booking = this.bookingChoice(order);
    const chosen = String(
      booking.courierCompany || booking.courier_company || "",
    ).trim();

    const options = await this.getBookingOptions();
    const companies = options.companies || [];
    const matched = this.matchCompanyName(chosen, companies);

    if (matched) return matched;
    if (chosen && !companies.length) return chosen;

    throw new CourierError(
      "Select a courier company to book with (TCS, Leopard, Trax, MNP, …).",
      {
        code: "COURIER_COMPANY_REQUIRED",
        httpStatus: 400,
        details: {
          prompt: options.prompt,
          companies,
          rate_cards: options.rate_cards,
          pickup_addresses: options.pickup_addresses,
        },
      },
    );
  }

  async resolvePickupLocationId(order) {
    const booking = this.bookingChoice(order);
    const settings = this.config.settings || {};
    const configured = String(
      booking.pickuplocation ||
        booking.pickup_location ||
        settings.pickuplocation ||
        settings.pickup_location ||
        this.config.pickup_location ||
        this.config.account_no ||
        "",
    ).trim();
    if (configured) return configured;

    const list = await this.getCompanyList();
    const addresses = Array.isArray(list.pickupAddress)
      ? list.pickupAddress
      : [];
    const def = addresses.find((a) => a?.is_default) || addresses[0];
    if (def?.id != null) return String(def.id);

    const url = this.endpoint("api/pickup-locations/");
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });
    const locs = Array.isArray(res.data?.pickup_locations)
      ? res.data.pickup_locations
      : [];
    const pick = locs.find((a) => a?.is_default) || locs[0];
    if (pick?.id != null) return String(pick.id);

    throw fromProviderMessage(
      "Flaship pickuplocation is required. Set Cost Center or settings.pickuplocation to a pickup location ID.",
      { provider: this.providerName, httpStatus: 400 },
    );
  }

  resolveServiceOption(order, courierCompany) {
    const booking = this.bookingChoice(order);
    const settings = this.config.settings || {};
    const raw = String(
      booking.courierOption ||
        booking.courier_option ||
        settings.courier_option ||
        settings.courierOption ||
        this.config.service_type ||
        settings.service_type ||
        "",
    )
      .trim()
      .toLowerCase();
    if (raw.includes("overland")) return "overland";
    if (raw.includes("detain")) return "detain";
    if (raw.includes("overnight")) return "overnight";

    const cards = this._companyList?.data?.rateCards || {};
    const forCompany = cards[courierCompany];
    if (Array.isArray(forCompany) && forCompany.length) {
      return String(forCompany[0]).trim().toLowerCase();
    }
    return "overnight";
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  async buildCreateOrderPayload(order) {
    const shipping = order.shippingAddress || {};
    const customer = order.customer || {};
    const cityName =
      shipping.city || order.city || customer.city || "";
    if (!cityName) throw invalidCity(cityName);

    const pieces = Math.max(1, Math.round(Number(order.pieces) || 1));
    const weight = Number(order.weightKg);
    const productWeight = Number.isFinite(weight) && weight > 0 ? weight : 0.5;
    const codAmount = Math.max(0, Math.round(Number(order.codAmount) || 0));

    const courierCompany = await this.resolveCourierCompany(order);
    const pickuplocation = await this.resolvePickupLocationId(order);
    const courierOption = this.resolveServiceOption(order, courierCompany);

    return {
      consigneeName: String(
        shipping.name || customer.name || order.name || "Customer",
      ).trim(),
      consigneePhone1: this.normalizePkMobile(
        shipping.phone || order.phone || customer.phone,
      ),
      consigneePhone2: "",
      consigneeAddress: String(
        shipping.address || order.address || "Address",
      ).trim(),
      destinationCity: String(cityName).trim(),
      codAmount: String(codAmount),
      productName: String(
        order.contentDesc || order.description || "Goods",
      ).slice(0, 200),
      productWeight: String(productWeight),
      productPieces: String(pieces),
      courierCompany,
      courierOption,
      pickuplocation,
      specialInstructions: String(order.remarks || order.description || "").slice(
        0,
        500,
      ),
      externalref: String(order.order_no || order._id || "").slice(0, 50),
    };
  }

  async createShipment(order) {
    const payload = await this.buildCreateOrderPayload(order);
    const url = this.endpoint("api/packet_booking");

    courierLogger.shipmentRequest({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      url,
      city: payload.destinationCity,
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
      res.data?.trackingId ||
      res.data?.tracking_id ||
      res.data?.tracking_number ||
      res.data?.cn ||
      null;

    if (res.status >= 400 || !this.isSuccess(res.data) || !tracking) {
      const failMsg = this.extractErrorMessage(res, "Flaship booking failed");
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
        },
        city: payload.destinationCity,
        httpStatus: res.status >= 400 ? res.status : 502,
      });
    }

    return this.buildShipmentResult({
      success: true,
      trackingNumber: String(tracking),
      bookingReference: String(res.data?.orderNo || payload.externalref || ""),
      status: UNIFIED_STATUSES.BOOKED,
      statusCode: "Booked",
      codAmount: Number(payload.codAmount) || 0,
      weight: Number(payload.productWeight) || null,
      pieces: Number(payload.productPieces) || 1,
      request: payload,
      response: res.data,
      message: String(res.data?.message || "SUCCESS"),
    });
  }

  async cancelShipment(shipment) {
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing Flaship tracking number for cancel", {
        provider: this.providerName,
      });
    }

    const url = this.endpoint("api/cancel_order/");
    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: { cn },
    });

    const ok =
      res.status < 400 &&
      (this.isSuccess(res.data) ||
        /cancelled/i.test(String(res.data?.message || "")));
    if (!ok) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "Flaship cancel failed"),
        {
          provider: this.providerName,
          details: res.data,
          httpStatus: res.status >= 400 ? res.status : 502,
        },
      );
    }
    return { success: true, raw: res.data };
  }

  async getTracking(trackingNo) {
    const cn = String(trackingNo || "").trim();
    const url = this.endpoint(
      `api/order_tracking/${encodeURIComponent(cn)}/`,
    );

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

    const bodyFailed =
      res.status >= 400 ||
      res.data?.status === false ||
      res.data?.success === false;
    const history = Array.isArray(res.data?.tracking)
      ? res.data.tracking
      : Array.isArray(res.data?.trackDetail)
        ? res.data.trackDetail
        : [];

    if (bodyFailed && !history.length && !res.data?.order_status) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "Flaship tracking failed"),
        {
          provider: this.providerName,
          details: {
            httpStatus: res.status,
            url,
            response: res.data,
          },
          httpStatus: res.status >= 400 ? res.status : 502,
          retryable: res.status >= 500,
        },
      );
    }

    const events = history.map((ev) => ({
      status: mapFlashipStatus(ev),
      description: ev.status || ev.description || ev.message || "",
      location: ev.station || ev.location || ev.city || null,
      eventTime: parseLooseDate(ev.time || ev.dateTime || ev.datetime || ev.createdAt),
      raw: ev,
    }));

    events.sort((a, b) => {
      const ta = a.eventTime ? new Date(a.eventTime).getTime() : 0;
      const tb = b.eventTime ? new Date(b.eventTime).getTime() : 0;
      return tb - ta;
    });

    const lastStatus =
      res.data?.order_status ||
      events[0]?.description ||
      events[0]?.status ||
      "Booked";

    if (!events.length) {
      events.push({
        status: mapFlashipStatus({ status: lastStatus }),
        description: lastStatus,
        location: null,
        eventTime: null,
        raw: res.data,
      });
    }

    const latest = events[0];
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
   * POST /mr/generate_label  { cns: [trackingNumber] } → PDF
   */
  async printLabel(shipment) {
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing Flaship tracking number for label", {
        provider: this.providerName,
      });
    }

    const url = this.endpoint("generate_label");
    courierLogger.log("info", "flaship_label", {
      provider: this.providerName,
      trackingNo: cn,
      url,
    });

    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      responseType: "buffer",
      headers: this.authHeaders({
        "Content-Type": "application/json",
        Accept: "application/pdf, application/json, */*",
      }),
      body: { cns: [cn] },
    });

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
        if (json.url) {
          const labelUrl = String(json.url).startsWith("http")
            ? String(json.url)
            : `${this.origin}${json.url}`;
          return {
            labelUrl,
            labelBase64: null,
            contentType: "application/pdf",
            raw: json,
          };
        }
        throw fromProviderMessage(
          json.reason || json.message || json.error || "Flaship label failed",
          { provider: this.providerName, details: json },
        );
      }

      throw fromProviderMessage("Flaship label response was not a valid PDF", {
        provider: this.providerName,
        details: {
          bytes: buf.length,
          preview: asText.slice(0, 300),
        },
        httpStatus: res.status,
      });
    }

    if (res.data && typeof res.data === "object" && res.data.url) {
      const labelUrl = String(res.data.url).startsWith("http")
        ? String(res.data.url)
        : `${this.origin}${res.data.url}`;
      return {
        labelUrl,
        labelBase64: null,
        contentType: "application/pdf",
        raw: res.data,
      };
    }

    throw fromProviderMessage(
      this.extractErrorMessage(res, "Flaship label failed"),
      {
        provider: this.providerName,
        details: res.data,
        httpStatus: res.status >= 400 ? res.status : 502,
      },
    );
  }

  async validateAddress(address = {}) {
    const cities = await this.getCities();
    const cityName = String(address.city || address.cityName || "").trim();
    if (!cityName) return { valid: false, message: "City is required" };
    if (!cities.length) return { valid: true, normalized: { cityName } };
    const match = cities.find(
      (c) => String(c.name || "").toLowerCase() === cityName.toLowerCase(),
    );
    if (!match) {
      return { valid: false, message: `City not served by Flaship: ${cityName}` };
    }
    return { valid: true, normalized: { cityName: match.name } };
  }

  async getCities() {
    if (this._citiesCache?.expiresAt > Date.now()) {
      return this._citiesCache.data;
    }

    const list = await this.getCompanyList();
    const buckets =
      list.operatioons_cities ||
      list.operations_cities ||
      list.operational_cities ||
      {};
    const names = new Set();
    if (buckets && typeof buckets === "object") {
      for (const value of Object.values(buckets)) {
        if (Array.isArray(value)) {
          for (const name of value) {
            if (name) names.add(String(name).trim());
          }
        }
      }
    }

    const cities = [...names].filter(Boolean).map((name) => ({
      name,
      code: name,
    }));
    this._citiesCache = {
      data: cities,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    return cities;
  }

  async healthCheck() {
    try {
      this.getApiKey();
      const url = this.endpoint("api/statuses/");
      const res = await httpRequest(url, {
        method: "GET",
        provider: this.providerName,
        headers: this.authHeaders(),
      });
      if (res.status >= 400 || res.data?.success === false) {
        return {
          ok: false,
          message: this.extractErrorMessage(res, "Flaship auth failed"),
        };
      }
      return { ok: true, message: "Flaship auth OK" };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapStatus(statusOrEvent) {
    if (statusOrEvent && typeof statusOrEvent === "object") {
      return mapFlashipStatus(statusOrEvent);
    }
    return mapFlashipStatus({ status: statusOrEvent });
  }
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

module.exports = FlagshipCourier;

/**
 * Flaship / Flagship merchant Integration API driver.
 * Auth: header `X-API-KEY`.
 * Base: https://partners.flaship.pk/api/integration/
 * Docs: docs/Courier/Flaship — Logistics Management.pdf (Oct 2026)
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
const { courierRemarksText } = require("../utils/orderContextLoader");

const DEFAULT_HOST = "https://partners.flaship.pk";
const API_PREFIX = "/api/integration";

function resolveFlashipOrigin(config = {}) {
  let raw = String(config.base_url || config.url || DEFAULT_HOST).trim();
  raw = raw.replace(/\/+$/, "");
  // Strip legacy /mr or new /api/integration suffixes so origin is host only.
  raw = raw.replace(/\/mr(\/api)?$/i, "");
  raw = raw.replace(/\/api\/integration$/i, "");
  if (!raw) return DEFAULT_HOST;

  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = String(parsed.hostname || "").toLowerCase();
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

  /** Origin host only (no path). */
  get origin() {
    return resolveFlashipOrigin(this.config);
  }

  /** Integration API root: …/api/integration */
  get baseUrl() {
    return `${this.origin}${API_PREFIX}`;
  }

  endpoint(path) {
    const p = String(path || "").replace(/^\//, "");
    return `${this.baseUrl}/${p}`;
  }

  /**
   * Merchant API key from Courier Integration → Token (or password / login).
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
      const fieldErrors = data.field_errors || data.errors;
      if (fieldErrors && typeof fieldErrors === "object") {
        const parts = Object.entries(fieldErrors).map(
          ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`,
        );
        if (parts.length) return parts.join("; ");
      }
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
      if (plain && plain.length < 300) return plain;
    }

    return httpStatus ? `HTTP ${httpStatus}: ${fallback}` : fallback;
  }

  isSuccess(data) {
    if (data == null) return false;
    if (typeof data === "object" && data.success === true) return true;
    if (typeof data === "object" && data.status === true) return true;
    return false;
  }

  normalizePkMobile(raw, fallback = "03000000000") {
    let digits = String(raw || "").replace(/\D/g, "");
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
   * GET /api/integration/catalog/
   */
  async getCatalog() {
    if (this._catalog?.expiresAt > Date.now()) {
      return this._catalog.data;
    }
    const url = this.endpoint("catalog/");
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });
    if (res.status >= 400 || res.data?.success === false) {
      throw fromProviderMessage(
        this.extractErrorMessage(res, "Flaship catalog failed"),
        {
          provider: this.providerName,
          details: { httpStatus: res.status, url, response: res.data },
          httpStatus: res.status >= 400 ? res.status : 502,
        },
      );
    }
    this._catalog = {
      data: res.data || {},
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return this._catalog.data;
  }

  /** @deprecated alias — old /mr/company_list */
  async getCompanyList() {
    return this.getCatalog();
  }

  bookingChoice(order = {}) {
    return order.bookingOptions && typeof order.bookingOptions === "object"
      ? order.bookingOptions
      : {};
  }

  courierDisplayName(row) {
    return String(row?.display_name || row?.name || row?.code || "").trim();
  }

  /**
   * UI picker payload from GET /api/integration/catalog/
   * Keeps display names for the OMS dropdown; rate_cards keyed by name + code.
   */
  async getBookingOptions() {
    const catalog = await this.getCatalog();
    const courierRows = Array.isArray(catalog.couriers) ? catalog.couriers : [];
    const companies = courierRows
      .map((c) => this.courierDisplayName(c))
      .filter(Boolean);

    const rawCards =
      catalog.rate_cards && typeof catalog.rate_cards === "object"
        ? catalog.rate_cards
        : {};
    const rateCards = {};
    for (const row of courierRows) {
      const code = String(row.code || "").trim();
      const label = this.courierDisplayName(row);
      const services = Array.isArray(rawCards[code])
        ? rawCards[code].map((s) => String(s).trim().toLowerCase())
        : [];
      if (label) rateCards[label] = services;
      if (code) rateCards[code] = services;
    }

    const pickups = Array.isArray(catalog.pickups) ? catalog.pickups : [];
    const pickupAddresses = pickups.map((a) => ({
      id: a?.id,
      address: a?.address || a?.name || "",
      name: a?.name || "",
      city: a?.city || "",
      is_default: Boolean(a?.is_default),
    }));

    return {
      requires_company: true,
      prompt: "Which company would you like to book?",
      companies,
      couriers: courierRows,
      rate_cards: rateCards,
      pickup_addresses: pickupAddresses,
      service_types: Array.isArray(catalog.service_types)
        ? catalog.service_types
        : [],
    };
  }

  resolveCourierCode(chosen, courierRows) {
    const key = String(chosen || "").trim().toLowerCase();
    if (!key) return "";
    for (const row of courierRows) {
      const code = String(row.code || "").trim().toLowerCase();
      const name = String(row.name || "").trim().toLowerCase();
      const display = String(row.display_name || "").trim().toLowerCase();
      if (key === code || key === name || key === display) {
        return String(row.code).trim();
      }
      // "TCS" ≈ "tcs_cross", "M&P" ≈ "mnp"
      if (display.includes(key) || name.includes(key) || key.includes(code)) {
        return String(row.code).trim();
      }
    }
    return "";
  }

  async resolveCourierCodeForOrder(order) {
    const booking = this.bookingChoice(order);
    const chosen = String(
      booking.courier_code ||
        booking.courierCode ||
        booking.courierCompany ||
        booking.courier_company ||
        "",
    ).trim();

    const options = await this.getBookingOptions();
    const rows = options.couriers || [];
    const code = this.resolveCourierCode(chosen, rows);

    if (code) return code;
    if (chosen && !rows.length) {
      // Allow raw code when catalog empty
      return chosen.toLowerCase().replace(/\s+/g, "_");
    }

    throw new CourierError(
      "Select a courier company to book with (Leopard, Trax, M&P, …).",
      {
        code: "COURIER_COMPANY_REQUIRED",
        httpStatus: 400,
        details: {
          prompt: options.prompt,
          companies: options.companies,
          rate_cards: options.rate_cards,
          pickup_addresses: options.pickup_addresses,
        },
      },
    );
  }

  async resolvePickupId(order) {
    const booking = this.bookingChoice(order);
    const settings = this.config.settings || {};
    const configured = String(
      booking.pickup_id ||
        booking.pickupId ||
        booking.pickuplocation ||
        booking.pickup_location ||
        settings.pickup_id ||
        settings.pickuplocation ||
        settings.pickup_location ||
        this.config.pickup_location ||
        this.config.account_no ||
        "",
    ).trim();
    if (configured && /^\d+$/.test(configured)) return Number(configured);

    const catalog = await this.getCatalog();
    const pickups = Array.isArray(catalog.pickups) ? catalog.pickups : [];
    const def = pickups.find((a) => a?.is_default) || pickups[0];
    if (def?.id != null) return Number(def.id);

    const url = this.endpoint("pickups/");
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: this.authHeaders(),
    });
    const locs = Array.isArray(res.data?.pickups) ? res.data.pickups : [];
    const pick = locs.find((a) => a?.is_default) || locs[0];
    if (pick?.id != null) return Number(pick.id);

    throw fromProviderMessage(
      "Flaship pickup_id is required. Create a pickup in Flaship or set Cost Center to a pickup location ID.",
      { provider: this.providerName, httpStatus: 400 },
    );
  }

  resolveServiceType(order, courierCode) {
    const booking = this.bookingChoice(order);
    const settings = this.config.settings || {};
    const raw = String(
      booking.service_type ||
        booking.serviceType ||
        booking.courierOption ||
        booking.courier_option ||
        settings.courier_option ||
        settings.service_type ||
        this.config.service_type ||
        "",
    )
      .trim()
      .toLowerCase();
    if (raw.includes("overland")) return "overland";
    if (raw.includes("detain")) return "detain";
    if (raw.includes("overnight")) return "overnight";

    const cards = this._catalog?.data?.rate_cards || {};
    const forCode = cards[courierCode];
    if (Array.isArray(forCode) && forCode.length) {
      return String(forCode[0]).trim().toLowerCase();
    }
    return "overnight";
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  async buildCreateOrderPayload(order) {
    const shipping = order.shippingAddress || {};
    const customer = order.customer || {};
    const cityName = shipping.city || order.city || customer.city || "";
    if (!cityName) throw invalidCity(cityName);

    const pieces = Math.max(1, Math.round(Number(order.pieces) || 1));
    const weight = Number(order.weightKg);
    const netWeight = Number.isFinite(weight) && weight > 0 ? weight : 0.5;
    const codAmount = Math.max(0, Number(order.codAmount) || 0);

    const courierCode = await this.resolveCourierCodeForOrder(order);
    const pickupId = await this.resolvePickupId(order);
    const serviceType = this.resolveServiceType(order, courierCode);

    return {
      pickup_id: pickupId,
      courier_code: courierCode,
      service_type: serviceType,
      product_name: String(
        order.contentDesc || order.description || "Goods",
      ).slice(0, 200),
      net_weight: Number(netWeight).toFixed(3),
      pieces,
      cod_amount: Number(codAmount).toFixed(2),
      consignee_name: String(
        shipping.name || customer.name || order.name || "Customer",
      ).trim(),
      consignee_phone_primary: this.normalizePkMobile(
        shipping.phone || order.phone || customer.phone,
      ),
      consignee_phone_secondary: "",
      consignee_address: String(
        shipping.address || order.address || "Address",
      ).trim(),
      consignee_city: String(cityName).trim(),
      special_instruction: courierRemarksText(order),
      external_ref_no: String(order.order_no || order._id || "").slice(0, 50),
    };
  }

  async createShipment(order) {
    const payload = await this.buildCreateOrderPayload(order);
    const url = this.endpoint("bookings/");

    courierLogger.shipmentRequest({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      url,
      city: payload.consignee_city,
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
      res.data?.tracking_number ||
      res.data?.trackingId ||
      res.data?.tracking_id ||
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
        city: payload.consignee_city,
        httpStatus: res.status >= 400 ? res.status : 502,
      });
    }

    return this.buildShipmentResult({
      success: true,
      trackingNumber: String(tracking),
      bookingReference: String(
        res.data?.id || payload.external_ref_no || "",
      ),
      status: mapFlashipStatus({ status: res.data?.status || "BOOKED" }),
      statusCode: String(res.data?.status || "BOOKED"),
      codAmount: Number(payload.cod_amount) || 0,
      weight: Number(payload.net_weight) || null,
      pieces: Number(payload.pieces) || 1,
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

    const url = this.endpoint(`orders/${encodeURIComponent(cn)}/cancel/`);
    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: {},
    });

    const ok =
      res.status < 400 &&
      (this.isSuccess(res.data) ||
        /cancel/i.test(String(res.data?.message || "")));
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
    const url = this.endpoint(`orders/${encodeURIComponent(cn)}/tracking/`);

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
    const history = Array.isArray(res.data?.tracking) ? res.data.tracking : [];

    if (bodyFailed && !history.length && !res.data?.status) {
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
      eventTime: parseLooseDate(
        ev.time || ev.dateTime || ev.datetime || ev.createdAt,
      ),
      raw: ev,
    }));

    events.sort((a, b) => {
      const ta = a.eventTime ? new Date(a.eventTime).getTime() : 0;
      const tb = b.eventTime ? new Date(b.eventTime).getTime() : 0;
      return tb - ta;
    });

    const lastStatus =
      res.data?.status ||
      res.data?.live_courier_status ||
      events[0]?.description ||
      events[0]?.status ||
      "BOOKED";

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
   * Prefer GET /labels/download/?tracking_numbers=CN → PDF
   * Fallback POST /labels/ then follow url.
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

    const downloadUrl = `${this.endpoint("labels/download/")}?tracking_numbers=${encodeURIComponent(cn)}&paper=a4&per_page=2`;
    courierLogger.log("info", "flaship_label", {
      provider: this.providerName,
      trackingNo: cn,
      url: downloadUrl,
    });

    const res = await httpRequest(downloadUrl, {
      method: "GET",
      provider: this.providerName,
      responseType: "buffer",
      headers: this.authHeaders({
        Accept: "application/pdf, application/json, */*",
      }),
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

    // Fallback: POST /labels/
    const genUrl = this.endpoint("labels/");
    const genRes = await httpRequest(genUrl, {
      method: "POST",
      provider: this.providerName,
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: { tracking_numbers: [cn], paper: "a4", per_page: 2 },
    });
    if (genRes.data && typeof genRes.data === "object" && genRes.data.url) {
      const labelUrl = String(genRes.data.url).startsWith("http")
        ? String(genRes.data.url)
        : `${this.origin}${genRes.data.url}`;
      return {
        labelUrl,
        labelBase64: null,
        contentType: "application/pdf",
        raw: genRes.data,
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

    // Prefer normalized /cities/ endpoint; fall back to catalog operational_cities.
    try {
      const url = this.endpoint("cities/");
      const res = await httpRequest(url, {
        method: "GET",
        provider: this.providerName,
        headers: this.authHeaders(),
      });
      if (res.status < 400 && Array.isArray(res.data?.cities)) {
        const cities = res.data.cities
          .map((c) => ({
            name: String(c.name || "").trim(),
            code: String(c.normalized_name || c.name || "").trim(),
          }))
          .filter((c) => c.name);
        this._citiesCache = {
          data: cities,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        };
        return cities;
      }
    } catch (_) {
      /* fall through */
    }

    const catalog = await this.getCatalog();
    const buckets = catalog.operational_cities || {};
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
      const paths = ["catalog/", "statuses/"];
      let lastMessage = "Flaship auth failed";
      for (const path of paths) {
        const url = this.endpoint(path);
        const res = await httpRequest(url, {
          method: "GET",
          provider: this.providerName,
          headers: this.authHeaders(),
        });
        if (res.status < 400 && res.data?.success !== false) {
          return { ok: true, message: "Flaship auth OK" };
        }
        lastMessage = this.extractErrorMessage(res, "Flaship auth failed");
      }
      return { ok: false, message: lastMessage };
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
  // "YYYY-MM-DD HH:MM:SS" (Asia/Karachi per docs)
  const m = String(value).match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/,
  );
  if (m) {
    const parsed = new Date(`${m[1]}T${m[2]}+05:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

module.exports = FlagshipCourier;

/**
 * TCS eCom API driver.
 * Auth: Bearer (clientId/clientsecret) + ecom accesstoken (username/password).
 * Docs: docs/Tcs ECom API User Guide.pdf
 * @module src/couriers/TCSCourier
 */

const BaseCourier = require("./BaseCourier");
const { UNIFIED_STATUSES, PROVIDERS } = require("./constants");
const { mapTcsStatus } = require("./statusMap");
const {
  fromProviderMessage,
  invalidCredentials,
  invalidWeight,
  invalidCity,
} = require("./errors");
const { httpRequest } = require("../utils/httpClient");
const courierLogger = require("../utils/courierLogger");

const DEFAULT_PROD = "https://ociconnect.tcscourier.com";
const DEFAULT_SANDBOX = "https://devconnect.tcscourier.com";

class TCSCourier extends BaseCourier {
  constructor(config, options) {
    super(config, options);
    this.providerName = PROVIDERS.TCS;
  }

  get baseUrl() {
    const raw =
      this.config.base_url ||
      (this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD);
    // Accept pasted full paths like .../ecom/api/authentication/token
    return String(raw)
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/ecom(\/.*)?$/i, "")
      .replace(/\/auth(\/.*)?$/i, "")
      .replace(/\/tracking(\/.*)?$/i, "");
  }

  /**
   * Normalize a saved JWT (users often paste "Bearer eyJ...").
   * @param {string} token
   * @returns {string}
   */
  normalizeBearerToken(token) {
    return String(token || "")
      .trim()
      .replace(/^Bearer\s+/i, "");
  }

  /**
   * Step 1 — OAuth-style bearer token (clientId + clientsecret),
   * or a pre-saved Token from Courier Integration.
   * @returns {Promise<string>}
   */
  async getBearerToken() {
    const now = Date.now();
    if (this._bearerCache?.token && this._bearerCache.expiresAt > now + 60_000) {
      return this._bearerCache.token;
    }

    // Use a pre-saved bearer token from Courier Integration when present.
    const savedToken = this.normalizeBearerToken(
      this.config.token ||
        this.config.settings?.bearer_token ||
        this.config.settings?.token ||
        this.config.settings?.accessToken ||
        this.config.settings?.access_token ||
        "",
    );
    if (savedToken) {
      this._bearerCache = {
        token: savedToken,
        expiresAt: now + 24 * 3600_000,
      };
      return savedToken;
    }

    const clientId =
      this.config.settings?.clientId ||
      this.config.settings?.client_id ||
      this.config.api_key;
    const clientSecret =
      this.config.settings?.clientSecret ||
      this.config.settings?.client_secret ||
      this.config.secret;

    if (!clientId || !clientSecret) {
      throw invalidCredentials(this.providerName);
    }

    const authUrl =
      this.config.settings?.auth_url ||
      (this.isSandbox
        ? "https://devconnect.tcscourier.com/auth/api/auth"
        : "https://ociconnect.tcscourier.com/auth/api/auth");

    const authWithQuery = `${authUrl}?clientid=${encodeURIComponent(String(clientId))}&clientsecret=${encodeURIComponent(String(clientSecret))}`;

    let res = await httpRequest(authWithQuery, {
      method: "GET",
      provider: this.providerName,
      headers: {
        clientid: String(clientId),
        clientsecret: String(clientSecret),
      },
    });

    // Some TCS gateways expect JSON body even on auth (non-standard GET).
    if (!res.data?.result?.accessToken && !res.data?.result?.accesstoken && !res.data?.accessToken) {
      res = await httpRequest(authUrl, {
        method: "POST",
        provider: this.providerName,
        body: {
          clientid: String(clientId),
          clientsecret: String(clientSecret),
        },
      });
    }

    const token =
      res.data?.result?.accessToken ||
      res.data?.result?.accesstoken ||
      res.data?.accessToken;

    if (!token) {
      courierLogger.apiError({
        provider: this.providerName,
        step: "bearer",
        response: res.data,
      });
      throw invalidCredentials(this.providerName);
    }

    const expiry = Date.parse(res.data?.result?.expiry || "") || now + 3600_000;
    this._bearerCache = { token, expiresAt: expiry };
    return token;
  }

  /**
   * Step 2 — E-com API access token (username + password).
   * TCS sandbox expects username/password as query params on GET
   * (headers alone are ignored → "username/password is required").
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const now = Date.now();
    if (this._tokenCache.token && this._tokenCache.expiresAt > now + 60_000) {
      return this._tokenCache.token;
    }

    const username = String(
      this.config.username || this.config.login || "",
    ).trim();
    const password = String(this.config.password || "").trim();
    if (!username || !password) {
      throw invalidCredentials(this.providerName);
    }

    const bearer = await this.getBearerToken();
    const qs = new URLSearchParams({
      username,
      password,
    });
    const url = `${this.baseUrl}/ecom/api/authentication/token?${qs.toString()}`;

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers: {
        Authorization: `Bearer ${bearer}`,
        // Also send as headers for gateways that read them this way
        username,
        password,
      },
    });

    const token = res.data?.accesstoken || res.data?.accessToken;
    if (!token) {
      const tcsMsg = Array.isArray(res.data?.errorList)
        ? res.data.errorList
            .map((e) => e.errormessage || e.message || "")
            .filter(Boolean)
            .join("; ")
        : res.data?.message || null;
      courierLogger.apiError({
        provider: this.providerName,
        step: "ecom_token",
        hasUsername: Boolean(username),
        hasPassword: Boolean(password),
        hasBearer: Boolean(bearer),
        response: res.data,
      });
      throw invalidCredentials(this.providerName, tcsMsg);
    }

    const expiry = Date.parse(res.data?.expiry || "") || now + 3600_000;
    this._tokenCache = { token, expiresAt: expiry };
    return token;
  }

  async authHeaders() {
    const bearer = await this.getBearerToken();
    return { Authorization: `Bearer ${bearer}` };
  }

  /**
   * Normalize a Pakistan mobile to 11 digits (03XXXXXXXXX) for TCS.
   * Handles 10-digit numbers (3001234567 → 03001234567), strips non-digits,
   * and ignores placeholders like "N/A".
   * @param {*} raw
   * @param {string} [fallback="03000000000"]
   * @returns {string}
   */
  normalizePkMobile(raw, fallback = "03000000000") {
    const text = String(raw ?? "").trim();
    if (!text || /^n\/?a$/i.test(text) || /^null$/i.test(text) || text === "-") {
      return fallback;
    }
    let digits = text.replace(/\D/g, "");
    // Drop country code 92 if present (923001234567 → 03001234567)
    if (digits.startsWith("92") && digits.length >= 12) {
      digits = `0${digits.slice(2)}`;
    }
    // 10-digit local mobile without leading 0
    if (digits.length === 10 && digits.startsWith("3")) {
      digits = `0${digits}`;
    }
    if (digits.length > 11) {
      digits = digits.slice(-11);
    }
    if (digits.length !== 11 || !digits.startsWith("0")) {
      return fallback;
    }
    return digits;
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   */
  buildBookingPayload(order, accessToken) {
    const settings = this.config.settings || {};
    const shipper = order.warehouse || {};
    const company = order.company || {};
    const customer = order.customer || {};
    const shipping = order.shippingAddress || {};
    const weight = Math.max(0.5, Number(order.weightKg) || 0.5);
    const pieces = Math.max(1, Number(order.pieces) || 1);
    const codAmount = Math.max(0, Math.round(Number(order.codAmount) || 0));

    if (!(weight >= 0.5)) {
      throw invalidWeight(weight);
    }

    const cityName =
      shipping.city || order.city || customer.city || settings.default_city;
    if (!cityName) {
      throw invalidCity(cityName);
    }

    const nameParts = String(
      shipping.name || customer.name || order.name || "Customer",
    )
      .trim()
      .split(/\s+/);
    const firstname = nameParts[0] || "Customer";
    const middlename = nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : ".";
    const lastname =
      nameParts.length > 1 ? nameParts[nameParts.length - 1] : ".";

    const shipperCity = shipper.city || settings.shipper_city || "Karachi";
    const accountNo = String(
      this.config.account_no ||
        settings.tcsaccount ||
        settings.account_no ||
        "",
    ).trim();
    if (!accountNo) {
      throw fromProviderMessage(
        "TCS account number (tcsaccount) is required on the courier integration. Set Account No on the courier record.",
        {
          provider: this.providerName,
          code: "CONFIG_MISSING",
          httpStatus: 400,
        },
      );
    }

    const costCenter =
      settings.costcentercode ||
      this.config.pickup_location ||
      settings.cost_center ||
      "DEFAULT";

    const consigneeMobile = this.normalizePkMobile(
      shipping.phone || order.phone || customer.phone,
    );
    const shipperMobile = this.normalizePkMobile(
      shipper.phone || company.company_phone || settings.shipper_phone,
    );

    const payload = {
      accesstoken: accessToken,
      consignmentno: "",
      shipperinfo: {
        tcsaccount: accountNo,
        shippername: String(
          settings.shippername || company.company_name || "Shipper",
        ).slice(0, 50),
        address1: String(
          shipper.address ||
            company.company_address ||
            settings.shipper_address ||
            "Warehouse",
        ).slice(0, 120),
        address2: "",
        address3: "",
        zip: String(shipper.zip_code || settings.shipper_zip || "").slice(0, 6),
        countrycode: String(settings.countrycode || "PK").slice(0, 2),
        countryname: String(settings.countryname || "Pakistan").slice(0, 50),
        citycode: String(settings.shipper_citycode || "").slice(0, 5),
        cityname: String(shipperCity).slice(0, 50),
        mobile: shipperMobile,
      },
      consigneeinfo: {
        consigneecode: "",
        firstname: firstname.slice(0, 50),
        middlename: String(middlename || ".").slice(0, 50),
        lastname: String(lastname || ".").slice(0, 50),
        address1: String(
          shipping.address || order.address || "Address",
        ).slice(0, 120),
        address2: String(shipping.address2 || "").slice(0, 120),
        address3: "",
        zip: String(shipping.zip || shipping.postal_code || "").slice(0, 6),
        countrycode: String(
          shipping.country_code || order.countryCode || "PK",
        ).slice(0, 2),
        countryname: String(
          shipping.country || order.country || "Pakistan",
        ).slice(0, 50),
        citycode: String(shipping.city_code || "").slice(0, 5),
        cityname: String(cityName).slice(0, 50),
        email: String(shipping.email || order.email || customer.email || "").slice(
          0,
          50,
        ),
        areacode: "",
        areaname: String(shipping.area || "").slice(0, 50),
        blockcode: "",
        blockname: "",
        lat: String(shipping.lat || ""),
        lng: String(shipping.lng || ""),
        landmark: String(shipping.landmark || "").slice(0, 200),
        mobile: consigneeMobile,
      },
      vendorinfo: {
        name: String(company.company_name || "").slice(0, 50),
        address1: String(company.company_address || "").slice(0, 120),
        address2: "",
        address3: "",
        citycode: "",
        cityname: String(shipperCity).slice(0, 50),
        mobile: this.normalizePkMobile(company.company_phone || shipperMobile),
      },
      shipmentinfo: {
        costcentercode: String(costCenter).slice(0, 20),
        referenceno: String(order.order_no || order._id).slice(0, 50),
        contentdesc: String(order.contentDesc || "Goods").slice(0, 50),
        servicecode: String(
          this.config.service_type || settings.servicecode || "O",
        ).slice(0, 6),
        parametertype: "",
        shipmentdate: formatTcsDate(new Date()),
        shippingtype: "",
        currency: "PKR",
        codamount: codAmount,
        declaredvalue: Math.round(Number(order.declaredValue) || codAmount || 0),
        insuredvalue: null,
        transactiontype: "",
        dsflag: "",
        carrierslug: "",
        weightinkg: weight,
        pieces,
        fragile: Boolean(settings.fragile),
        remarks: String(order.description || order.remarks || "").slice(0, 500),
        skus: (order.items || []).map((item) => ({
          description: String(item.name || "Item").slice(0, 50),
          quantity: Math.max(1, Number(item.qty) || 1),
          weight: Math.max(0.5, Number(item.weight) || weight),
          uom: "KG",
          unitprice: Math.round(Number(item.price) || 0),
          declaredvalue: Math.round(Number(item.subtotal) || 0),
          insuredvalue: null,
        })),
      },
    };

    return payload;
  }

  async createShipment(order) {
    const accessToken = await this.getAccessToken();
    const headers = await this.authHeaders();
    const payload = this.buildBookingPayload(order, accessToken);
    const url = `${this.baseUrl}/ecom/api/booking/create`;

    courierLogger.shipmentRequest({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      url,
      city: order.city || order.shippingAddress?.city || null,
      weightKg: order.weightKg,
      pieces: order.pieces,
      codAmount: order.codAmount,
      request: payload,
    });

    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      headers,
      body: payload,
    });

    courierLogger.shipmentResponse({
      provider: this.providerName,
      orderId: String(order._id),
      orderNo: order.order_no || null,
      httpStatus: res.status,
      response: res.data,
    });

    const message =
      res.data?.message ||
      res.data?.Message ||
      res.data?.result?.message ||
      "";
    const consignmentNo =
      res.data?.consignmentno ||
      res.data?.ConsignmentNo ||
      res.data?.result?.consignmentno ||
      res.data?.result?.ConsignmentNo;

    const tcsErrors = Array.isArray(res.data?.errorList)
      ? res.data.errorList
          .map((e) => e.errormessage || e.message || e.key || "")
          .filter(Boolean)
          .join("; ")
      : null;

    const ok =
      res.status < 400 &&
      consignmentNo &&
      !/fail/i.test(String(message));

    if (!ok) {
      const failMsg =
        tcsErrors ||
        message ||
        (res.status >= 400 ? `TCS HTTP ${res.status}` : null) ||
        "TCS booking failed";

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
        httpStatus: res.status >= 400 ? res.status : 502,
      });
    }

    return this.buildShipmentResult({
      success: true,
      trackingNumber: String(consignmentNo),
      bookingReference: String(payload.shipmentinfo.referenceno),
      status: UNIFIED_STATUSES.BOOKED,
      statusCode: "SM",
      codAmount: payload.shipmentinfo.codamount,
      weight: payload.shipmentinfo.weightinkg,
      pieces: payload.shipmentinfo.pieces,
      request: payload,
      response: res.data,
      message: String(message || "SUCCESS"),
    });
  }

  async cancelShipment(shipment) {
    const accessToken = await this.getAccessToken();
    const headers = await this.authHeaders();
    const cn = shipment.tracking_number;
    const url = `${this.baseUrl}/ecom/api/booking/cancel`;

    const res = await httpRequest(url, {
      method: "POST",
      provider: this.providerName,
      headers,
      body: {
        accesstoken: accessToken,
        ConsignmentNumber: cn,
        consignmentnumber: cn,
      },
    });

    const ok = res.status < 400 && !/fail/i.test(String(res.data?.message || ""));
    if (!ok) {
      throw fromProviderMessage(res.data?.message || "TCS cancel failed", {
        provider: this.providerName,
        details: res.data,
      });
    }
    return { success: true, raw: res.data };
  }

  async getTracking(trackingNo) {
    const headers = await this.authHeaders();
    const url = `${this.baseUrl}/tracking/api/Tracking/GetDynamicTrackDetail?consignee=${encodeURIComponent(trackingNo)}`;

    courierLogger.trackingRequest({
      provider: this.providerName,
      trackingNo,
    });

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers,
    });

    courierLogger.trackingResponse({
      provider: this.providerName,
      trackingNo,
      httpStatus: res.status,
    });

    const checkpoints = Array.isArray(res.data?.checkpoints)
      ? res.data.checkpoints
      : [];
    const deliveryinfo = Array.isArray(res.data?.deliveryinfo)
      ? res.data.deliveryinfo
      : [];

    const events = [...deliveryinfo, ...checkpoints].map((ev) => {
      const status = mapTcsStatus(ev);
      return {
        status,
        description: ev.status || ev.description || "",
        location: ev.station || ev.recievedby || null,
        eventTime: parseLooseDate(ev.datetime),
        raw: ev,
      };
    });

    const latest = events[0] || {
      status: UNIFIED_STATUSES.BOOKED,
      description: res.data?.shipmentsummary || "",
    };

    return {
      trackingNumber: String(trackingNo),
      status: latest.status,
      statusCode: deliveryinfo[0]?.code || null,
      events,
      raw: res.data,
    };
  }

  async printLabel(shipment) {
    const headers = await this.authHeaders();
    const cn = shipment.tracking_number;
    const url = `${this.baseUrl}/ecom/api/print/label?consignmentno=${encodeURIComponent(cn)}`;

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers,
    });

    const labelUrl =
      res.data?.labelurl ||
      res.data?.labelUrl ||
      res.data?.result?.labelurl ||
      url;

    return { labelUrl, raw: res.data };
  }

  async validateAddress(address = {}) {
    const cities = await this.getCities(address.countrycode || "PK");
    const cityName = String(address.city || address.cityname || "").toLowerCase();
    if (!cityName) {
      return { valid: false, message: "City is required" };
    }
    const match = cities.find(
      (c) =>
        String(c.name || "").toLowerCase() === cityName ||
        String(c.code || "").toLowerCase() === cityName,
    );
    if (!match) {
      return { valid: false, message: `City not served by TCS: ${cityName}` };
    }
    return {
      valid: true,
      normalized: { cityname: match.name, citycode: match.code },
    };
  }

  async getCities(countryCode = "PK") {
    const cacheKey = `tcs_cities_${countryCode}`;
    if (this._citiesCache?.[cacheKey]?.expiresAt > Date.now()) {
      return this._citiesCache[cacheKey].data;
    }

    const headers = await this.authHeaders();
    const url = `${this.baseUrl}/ecom/api/setup/citylistbycountry?countrycode=${encodeURIComponent(countryCode)}`;
    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      headers,
    });

    const list = Array.isArray(res.data?.cities)
      ? res.data.cities
      : Array.isArray(res.data?.result)
        ? res.data.result
        : Array.isArray(res.data)
          ? res.data
          : [];

    const cities = list.map((c) => ({
      code: c.citycode || c.code || c.CityCode,
      name: c.cityname || c.name || c.CityName,
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
      await this.getAccessToken();
      return { ok: true, message: "TCS auth OK" };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  mapStatus(statusOrEvent) {
    if (statusOrEvent && typeof statusOrEvent === "object") {
      return mapTcsStatus(statusOrEvent);
    }
    return mapTcsStatus({ status: statusOrEvent });
  }
}

function formatTcsDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function parseLooseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

module.exports = TCSCourier;

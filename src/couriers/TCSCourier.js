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
/** TCS eCom booking: weightinkg min 0.5; max ~10 (larger values → "Insert valid Decimal number"). */
const TCS_MIN_WEIGHT_KG = 0.5;
const TCS_MAX_WEIGHT_KG = 10;

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
   * Tracking API host (separate from eCom).
   * Sandbox: https://devconnect.tcscourier.com/tracking
   * Prod: https://ociconnect.tcscourier.com/tracking
   * @see https://devconnect.tcscourier.com/tracking/index.html
   */
  get trackingBaseUrl() {
    const raw =
      this.config.settings?.tracking_base_url ||
      this.config.tracking_base_url ||
      (this.isSandbox ? DEFAULT_SANDBOX : DEFAULT_PROD);
    return String(raw)
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/tracking(\/.*)?$/i, "")
      .replace(/\/ecom(\/.*)?$/i, "")
      .replace(/\/auth(\/.*)?$/i, "");
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
   * Parse a decimal for TCS fields. Empty / invalid → null (field should be omitted).
   * @param {*} raw
   * @returns {number|null}
   */
  toOptionalDecimal(raw) {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * TCS weightinkg / SKU weight: double, min 0.5, max 10.
   * Returns a fixed 3-decimal *string* so JSON keeps "5.000" (plain number 5 is
   * rejected by TCS as "Insert valid Decimal number").
   * @param {*} raw
   * @returns {string}
   */
  toTcsWeightKg(raw) {
    let n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) n = 0.5;
    // Unrealistic as kg for retail parcels → treat as grams (Shopify stores g).
    if (n > 50) n = n / 1000;
    n = Math.min(TCS_MAX_WEIGHT_KG, Math.max(TCS_MIN_WEIGHT_KG, n));
    return Number(n.toFixed(3));
  }

  /**
   * JSON.stringify drops trailing .0 (5.000 → 5). TCS rejects whole numbers for
   * weight fields ("Insert valid Decimal number"). Rewrite those keys to 3dp.
   * @param {object} payload
   * @returns {string}
   */
  stringifyBookingBody(payload) {
    const json = JSON.stringify(payload);
    return json.replace(
      /"(weightinkg|weight)"\s*:\s*(-?\d+(?:\.\d+)?)/g,
      (_, key, num) => `"${key}":${Number(num).toFixed(3)}`,
    );
  }

  /**
   * Read JWT `exp` (ms) without verifying signature.
   * @param {string} token
   * @returns {number|null}
   */
  readJwtExpiryMs(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
      const exp = Number(payload?.exp);
      return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} token
   * @returns {number|null} expiry ms, or null if unknown
   */
  resolveSavedBearerExpiryMs(token) {
    const fromSettings =
      Date.parse(
        this.config.settings?.token_expiry ||
          this.config.settings?.bearer_token_expiry ||
          this.config.token_expiry ||
          "",
      ) || 0;
    if (fromSettings > 0) return fromSettings;
    return this.readJwtExpiryMs(token);
  }

  /**
   * Persist refreshed bearer token onto the courier / provider row.
   * @param {string} token
   * @param {number} expiresAtMs
   */
  async persistBearerToken(token, expiresAtMs) {
    const expiryIso = new Date(
      Number.isFinite(expiresAtMs) && expiresAtMs > 0 ?
        expiresAtMs
      : Date.now() + 3600_000,
    ).toISOString();

    this.config.token = token;
    this.config.settings = {
      ...(this.config.settings && typeof this.config.settings === "object" ?
        this.config.settings
      : {}),
      token,
      bearer_token: token,
      token_expiry: expiryIso,
      bearer_token_expiry: expiryIso,
    };

    try {
      const mongoose = require("mongoose");
      const legacyId = this.config._legacy_id;
      if (legacyId) {
        const Courier = mongoose.model("courier");
        await Courier.updateOne(
          { _id: legacyId },
          {
            $set: {
              token,
              "settings.token": token,
              "settings.bearer_token": token,
              "settings.token_expiry": expiryIso,
              "settings.bearer_token_expiry": expiryIso,
            },
          },
        );
        return;
      }

      const providerId = this.config._id;
      if (providerId) {
        const CourierProvider = require("../models/courier_provider.model");
        await CourierProvider.updateOne(
          { _id: providerId },
          {
            $set: {
              "settings.token": token,
              "settings.bearer_token": token,
              "settings.token_expiry": expiryIso,
              "settings.bearer_token_expiry": expiryIso,
            },
          },
        );
      }
    } catch (err) {
      courierLogger.apiError({
        provider: this.providerName,
        step: "persist_bearer",
        error: err?.message || String(err),
      });
    }
  }

  /**
   * Fetch a fresh OAuth bearer using clientId / clientSecret.
   * @returns {Promise<{ token: string, expiresAt: number }>}
   */
  async fetchBearerTokenFromCredentials() {
    const now = Date.now();
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
    if (
      !res.data?.result?.accessToken &&
      !res.data?.result?.accesstoken &&
      !res.data?.accessToken
    ) {
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

    const expiresAt =
      Date.parse(res.data?.result?.expiry || "") ||
      this.readJwtExpiryMs(token) ||
      now + 3600_000;

    return { token: this.normalizeBearerToken(token), expiresAt };
  }

  /**
   * Step 1 — OAuth-style bearer token (clientId + clientsecret),
   * or a pre-saved Token from Courier Integration (auto-refreshed when missing/expired).
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async getBearerToken(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const now = Date.now();
    if (
      !forceRefresh &&
      this._bearerCache?.token &&
      this._bearerCache.expiresAt > now + 60_000
    ) {
      return this._bearerCache.token;
    }

    const savedToken = this.normalizeBearerToken(
      this.config.token ||
        this.config.settings?.bearer_token ||
        this.config.settings?.token ||
        this.config.settings?.accessToken ||
        this.config.settings?.access_token ||
        "",
    );
    const savedExpiry = savedToken ?
        this.resolveSavedBearerExpiryMs(savedToken)
      : null;
    // Prefer a still-valid saved token only when we know it is not expired.
    if (
      savedToken &&
      !forceRefresh &&
      savedExpiry != null &&
      savedExpiry > now + 60_000
    ) {
      this._bearerCache = {
        token: savedToken,
        expiresAt: savedExpiry,
      };
      return savedToken;
    }

    const hasClientCreds =
      Boolean(
        this.config.settings?.clientId ||
          this.config.settings?.client_id ||
          this.config.api_key,
      ) &&
      Boolean(
        this.config.settings?.clientSecret ||
          this.config.settings?.client_secret ||
          this.config.secret,
      );

    // Missing, expired, unknown-expiry, or forced → refresh when client credentials exist.
    if (hasClientCreds && (forceRefresh || !savedToken || savedExpiry == null || savedExpiry <= now + 60_000)) {
      const fresh = await this.fetchBearerTokenFromCredentials();
      this._bearerCache = {
        token: fresh.token,
        expiresAt: fresh.expiresAt,
      };
      await this.persistBearerToken(fresh.token, fresh.expiresAt);
      return fresh.token;
    }

    if (savedToken) {
      this._bearerCache = {
        token: savedToken,
        expiresAt: savedExpiry || now + 5 * 60_000,
      };
      return savedToken;
    }

    throw invalidCredentials(
      this.providerName,
      "Bearer Token is missing. Paste Token on Courier Integration, or set Client ID + Client Secret so the token can refresh automatically.",
    );
  }

  /**
   * Step 2 — E-com API access token (username + password).
   * Auto-refreshes bearer when missing/expired or when ecom auth fails once.
   * @param {{ forceRefresh?: boolean, _retried?: boolean }} [options]
   * @returns {Promise<string>}
   */
  async getAccessToken(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    const now = Date.now();
    if (
      !forceRefresh &&
      this._tokenCache.token &&
      this._tokenCache.expiresAt > now + 60_000
    ) {
      return this._tokenCache.token;
    }

    const username = String(
      this.config.username || this.config.login || "",
    ).trim();
    const password = String(this.config.password || "").trim();
    if (!username || !password) {
      throw invalidCredentials(this.providerName);
    }

    const bearer = await this.getBearerToken({ forceRefresh });
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

      // Stale bearer is a common cause — refresh once and retry.
      if (!options._retried) {
        courierLogger.apiError({
          provider: this.providerName,
          step: "ecom_token_retry_refresh_bearer",
          hasUsername: Boolean(username),
          hasPassword: Boolean(password),
          hasBearer: Boolean(bearer),
          response: res.data,
        });
        this._bearerCache = null;
        this._tokenCache = { token: null, expiresAt: 0 };
        return this.getAccessToken({ forceRefresh: true, _retried: true });
      }

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
   * Resolve a valid TCS cost center code.
   * Uses courier config first; otherwise inquiries TCS; optionally creates one for sandbox.
   * @param {string} accessToken
   * @param {string} accountNo
   * @param {object} [order]
   * @returns {Promise<string>}
   */
  async resolveCostCenterCode(accessToken, accountNo, order = {}) {
    const settings = this.config.settings || {};
    const configured = String(
      settings.costcentercode ||
        this.config.pickup_location ||
        settings.cost_center ||
        this.config.cost_center ||
        "",
    ).trim();

    if (configured && !/^default$/i.test(configured)) {
      return configured.slice(0, 20);
    }

    const inquired = await this.inquireCostCenters(accessToken, accountNo);
    if (inquired.length > 0) {
      const code = String(
        inquired[0].costcentercode ||
          inquired[0].costCenterCode ||
          inquired[0].code ||
          "",
      ).trim();
      if (code) {
        this.config.settings = {
          ...settings,
          costcentercode: code,
        };
        return code.slice(0, 20);
      }
    }

    // Sandbox: create a cost center when the account has none yet.
    if (this.isSandbox) {
      const created = await this.createCostCenter(accessToken, accountNo, order);
      if (created) {
        this.config.settings = {
          ...(this.config.settings || {}),
          costcentercode: created,
        };
        return created.slice(0, 20);
      }
    }

    throw fromProviderMessage(
      "No TCS Cost Center found. Set Cost Center on the courier integration (or create one in TCS Envio).",
      {
        provider: this.providerName,
        code: "CONFIG_MISSING",
        httpStatus: 400,
        details: { accountNo, inquired },
      },
    );
  }

  /**
   * @param {string} accessToken
   * @param {string} accountNo
   * @returns {Promise<object[]>}
   */
  async inquireCostCenters(accessToken, accountNo) {
    const headers = await this.authHeaders();
    const qs = new URLSearchParams({
      accesstoken: String(accessToken),
      accessToken: String(accessToken),
      customerno: String(accountNo),
    });
    // Swagger: GET /ecom/api/inquiry/costcenterinquiry?accesstoken=&customerno=
    const url = `${this.baseUrl}/ecom/api/inquiry/costcenterinquiry?${qs.toString()}`;

    try {
      const res = await httpRequest(url, {
        method: "GET",
        provider: this.providerName,
        headers: {
          ...headers,
          accesstoken: String(accessToken),
        },
      });

      courierLogger.log("info", "cost_center_inquiry", {
        provider: this.providerName,
        accountNo,
        httpStatus: res.status,
        response: res.data,
      });

      if (Array.isArray(res.data?.detail)) return res.data.detail;
      if (Array.isArray(res.data?.result)) return res.data.result;
      if (Array.isArray(res.data?.costcenters)) return res.data.costcenters;
      if (Array.isArray(res.data)) return res.data;
      return [];
    } catch (err) {
      courierLogger.apiError({
        provider: this.providerName,
        step: "cost_center_inquiry",
        error: err.message,
      });
      return [];
    }
  }

  /**
   * Create a sandbox cost center for booking.
   * @param {string} accessToken
   * @param {string} accountNo
   * @param {object} [order]
   * @returns {Promise<string|null>}
   */
  async createCostCenter(accessToken, accountNo, order = {}) {
    const settings = this.config.settings || {};
    const company = order.company || {};
    const code = String(settings.create_costcentercode || "Test-01").slice(0, 20);
    const city =
      order.warehouse?.city ||
      settings.shipper_city ||
      settings.costcentercityname ||
      "Karachi";
    const address = String(
      order.warehouse?.address ||
        company.company_address ||
        settings.shipper_address ||
        "Warehouse",
    ).slice(0, 120);

    const headers = await this.authHeaders();
    // Swagger createCostCenterCodeReq (additionalProperties: false) —
    // field names must be lowercase: accountnumber, phonenumber.
    const body = {
      accesstoken: accessToken,
      costcentercityname: String(city).slice(0, 50),
      costcentercode: code,
      costcentername: String(
        settings.costcentername || company.company_name || "POS Cost Center",
      ).slice(0, 100),
      pickupaddress: address.slice(0, 360),
      returnaddress: address.slice(0, 360),
      islabelprint: "yes",
      accountnumber: String(accountNo).slice(0, 12),
      phonenumber: this.normalizePkMobile(
        order.warehouse?.phone || company.company_phone || settings.shipper_phone,
      ),
      email: String(company.company_email || settings.email || "test@abc.com").slice(
        0,
        50,
      ),
    };

    const url = `${this.baseUrl}/ecom/api/booking/createcostcentercode`;
    try {
      const res = await httpRequest(url, {
        method: "POST",
        provider: this.providerName,
        headers,
        body,
      });

      courierLogger.log("info", "cost_center_create", {
        provider: this.providerName,
        accountNo,
        httpStatus: res.status,
        response: res.data,
      });

      const msg = String(res.data?.message || res.data?.Message || "");
      if (/success/i.test(msg) || res.status < 400) {
        return (
          res.data?.costcentercode ||
          res.data?.result?.costcentercode ||
          code
        );
      }
      // Already exists — reuse requested code
      if (/exist|already/i.test(msg)) return code;
      return null;
    } catch (err) {
      courierLogger.apiError({
        provider: this.providerName,
        step: "cost_center_create",
        error: err.message,
      });
      return null;
    }
  }

  /**
   * @param {import('../utils/orderContextLoader').OrderContext} order
   * @param {string} accessToken
   * @param {string} costCenter
   */
  buildBookingPayload(order, accessToken, costCenter) {
    const settings = this.config.settings || {};
    const shipper = order.warehouse || {};
    const company = order.company || {};
    const customer = order.customer || {};
    const shipping = order.shippingAddress || {};
    const weight = this.toTcsWeightKg(order.weightKg);
    const pieces = Math.max(1, Number(order.pieces) || 1);
    const codAmount = Math.max(0, Math.round(Number(order.codAmount) || 0));

    if (!(weight >= TCS_MIN_WEIGHT_KG)) {
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

    if (!costCenter) {
      throw fromProviderMessage(
        "No TCS Cost Center found. Set Cost Center on the courier integration.",
        {
          provider: this.providerName,
          code: "CONFIG_MISSING",
          httpStatus: 400,
        },
      );
    }

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
        // Omit empty lat/lng — TCS returns "Insert valid Decimal number" for "".
        ...(this.toOptionalDecimal(shipping.lat) != null ?
          { lat: this.toOptionalDecimal(shipping.lat) }
        : {}),
        ...(this.toOptionalDecimal(shipping.lng) != null ?
          { lng: this.toOptionalDecimal(shipping.lng) }
        : {}),
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
        codamount: Number(codAmount) || 0,
        declaredvalue:
          Number(
            Math.round(Number(order.declaredValue) || codAmount || 0),
          ) || 0,
        transactiontype: "",
        dsflag: "",
        carrierslug: "",
        weightinkg: weight,
        pieces: Math.max(1, Math.round(Number(pieces) || 1)),
        fragile: Boolean(settings.fragile),
        remarks: String(order.description || order.remarks || "").slice(0, 500),
        skus: (order.items || []).map((item) => ({
          description: String(item.name || "Item").slice(0, 50),
          quantity: Math.max(1, Math.round(Number(item.qty) || 1)),
          weight: this.toTcsWeightKg(
            Number(item.weight) > 0 ? item.weight : weight,
          ),
          uom: "KG",
          unitprice: Math.round(Number(item.price) || 0),
          declaredvalue: Math.round(Number(item.subtotal) || 0),
        })),
      },
    };

    return payload;
  }

  async createShipment(order) {
    const accessToken = await this.getAccessToken();
    const headers = await this.authHeaders();
    const accountNo = String(
      this.config.account_no ||
        this.config.settings?.tcsaccount ||
        this.config.settings?.account_no ||
        "",
    ).trim();
    const costCenter = await this.resolveCostCenterCode(
      accessToken,
      accountNo,
      order,
    );
    const payload = this.buildBookingPayload(order, accessToken, costCenter);
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
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: this.stringifyBookingBody(payload),
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
    // TCS sandbox returns camelCase `consignmentNo`; some envs use lowercase.
    const consignmentNo =
      res.data?.consignmentNo ||
      res.data?.consignmentno ||
      res.data?.ConsignmentNo ||
      res.data?.result?.consignmentNo ||
      res.data?.result?.consignmentno ||
      res.data?.result?.ConsignmentNo;

    const tcsErrors = Array.isArray(res.data?.errorList)
      ? res.data.errorList
          .map((e) => {
            const key = e.key || e.field || "";
            const msg = e.errormessage || e.message || "";
            if (key && msg) return `${key}: ${msg}`;
            return msg || key;
          })
          .filter(Boolean)
          .join("; ")
      : null;

    const ok =
      res.status < 400 &&
      consignmentNo &&
      (/success/i.test(String(message)) || !/fail/i.test(String(message)));

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
          response: res.data,
          errorList: res.data?.errorList || null,
          sentWeights: {
            weightinkg: payload.shipmentinfo?.weightinkg,
            skuWeights: (payload.shipmentinfo?.skus || []).map((s) => s.weight),
          },
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
    // Dev: https://devconnect.tcscourier.com/tracking/api/Tracking/GetDynamicTrackDetail
    const url = `${this.trackingBaseUrl}/tracking/api/Tracking/GetDynamicTrackDetail?consignee=${encodeURIComponent(trackingNo)}`;

    courierLogger.trackingRequest({
      provider: this.providerName,
      trackingNo,
      url,
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
      url,
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

  async printLabel(shipment, options = {}) {
    const accessToken = await this.getAccessToken();
    const headers = await this.authHeaders();
    const cn = String(
      shipment.tracking_number || shipment.trackingNumber || shipment.consignmentno || "",
    ).trim();
    if (!cn) {
      throw fromProviderMessage("Missing TCS consignment number for label print", {
        provider: this.providerName,
      });
    }

    // TCS CNPrint — https://devconnect.tcscourier.com/ecom/index.html
    // GET /ecom/api/print/label
    const printtype = Number(options.printtype ?? options.printType ?? 6) || 6;
    const shipperDetails =
      options.shipperDetails === true || options.shipperDetails === "true";
    const accounttype = Number(options.accounttype ?? options.accountType ?? 1) || 1;

    const qs = new URLSearchParams({
      accesstoken: String(accessToken),
      consignmentno: cn,
      shipperDetails: shipperDetails ? "true" : "false",
      printtype: String(printtype),
      accounttype: String(accounttype),
    });
    const url = `${this.baseUrl}/ecom/api/print/label?${qs.toString()}`;

    const res = await httpRequest(url, {
      method: "GET",
      provider: this.providerName,
      responseType: "buffer",
      headers: {
        ...headers,
        Accept: "application/pdf, application/json, */*",
      },
    });

    if (res.status >= 400) {
      let msg = `TCS label print failed (HTTP ${res.status})`;
      if (Buffer.isBuffer(res.data)) {
        try {
          const parsed = JSON.parse(res.data.toString("utf8"));
          msg = parsed?.message || parsed?.Message || msg;
        } catch {
          /* keep default */
        }
      } else if (res.data && typeof res.data === "object") {
        msg = res.data.message || res.data.Message || msg;
      }
      throw fromProviderMessage(String(msg), {
        provider: this.providerName,
        details: Buffer.isBuffer(res.data)
          ? { bytes: res.data.length, preview: res.data.toString("utf8").slice(0, 300) }
          : res.data,
        httpStatus: res.status,
      });
    }

    // Binary PDF (correct path — do NOT read as text)
    if (Buffer.isBuffer(res.data)) {
      const buf = res.data;
      const head = buf.slice(0, 8).toString("utf8");
      if (head.startsWith("%PDF")) {
        return {
          labelUrl: null,
          labelBase64: buf.toString("base64"),
          contentType: "application/pdf",
          printtype,
          raw: { message: "pdf_binary", bytes: buf.length },
        };
      }

      // Buffer may actually be JSON (some gateways ignore Accept)
      const asText = buf.toString("utf8").trim();
      let json = null;
      try {
        json = JSON.parse(asText);
      } catch {
        json = null;
      }
      if (json && typeof json === "object") {
        const fromJson = this._extractTcsLabelPayload(json, printtype);
        if (fromJson) return fromJson;
      }

      if (/^https?:\/\//i.test(asText)) {
        return {
          labelUrl: asText,
          labelBase64: null,
          contentType: "application/pdf",
          printtype,
          raw: { labelurl: asText },
        };
      }

      throw fromProviderMessage(
        "TCS label response was not a valid PDF (blank/corrupt). Check CN and printtype.",
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
      const fromJson = this._extractTcsLabelPayload(res.data, printtype);
      if (fromJson) return fromJson;
    }

    if (typeof res.data === "string") {
      const text = res.data.trim();
      if (/^https?:\/\//i.test(text)) {
        return {
          labelUrl: text,
          labelBase64: null,
          contentType: "application/pdf",
          printtype,
          raw: { labelurl: text },
        };
      }
      try {
        const json = JSON.parse(text);
        const fromJson = this._extractTcsLabelPayload(json, printtype);
        if (fromJson) return fromJson;
      } catch {
        /* ignore */
      }
    }

    throw fromProviderMessage("TCS label print returned no PDF / label URL", {
      provider: this.providerName,
      details: res.data,
    });
  }

  /**
   * Pull label URL / base64 from TCS JSON CNPrint responses.
   * @private
   */
  _extractTcsLabelPayload(json, printtype) {
    if (!json || typeof json !== "object") return null;
    const labelUrl =
      json.labelurl ||
      json.labelUrl ||
      json.LabelUrl ||
      json.result?.labelurl ||
      json.result?.labelUrl ||
      json.pdfurl ||
      json.pdfUrl ||
      json.fileurl ||
      json.fileUrl ||
      null;
    let base64 =
      json.pdfBase64 ||
      json.pdf_base64 ||
      json.fileBase64 ||
      json.base64 ||
      json.result?.pdfBase64 ||
      json.result?.base64 ||
      null;

    if (typeof base64 === "string") {
      base64 = base64.replace(/^data:application\/pdf;base64,/i, "").replace(/\s+/g, "");
      // Reject empty / non-PDF payloads that produced blank blob pages
      try {
        const decoded = Buffer.from(base64, "base64");
        if (decoded.length < 20 || !decoded.slice(0, 5).toString("utf8").startsWith("%PDF")) {
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
        printtype,
        raw: json,
      };
    }
    return null;
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

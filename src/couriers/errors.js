/**
 * Typed courier errors with HTTP status hints.
 * @module src/couriers/errors
 */

class CourierError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]
   * @param {number} [opts.httpStatus]
   * @param {boolean} [opts.retryable]
   * @param {*} [opts.details]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "CourierError";
    this.code = opts.code || "COURIER_ERROR";
    this.httpStatus = opts.httpStatus || 500;
    this.retryable = Boolean(opts.retryable);
    this.details = opts.details ?? null;
  }
}

function orderNotFound(orderId) {
  return new CourierError(`Order not found: ${orderId}`, {
    code: "ORDER_NOT_FOUND",
    httpStatus: 404,
  });
}

function unsupportedCourier(provider) {
  return new CourierError(`Unsupported courier provider: ${provider}`, {
    code: "UNSUPPORTED_COURIER",
    httpStatus: 400,
  });
}

function alreadyShipped(orderId, trackingNumber) {
  return new CourierError(
    `Order ${orderId} already has an active shipment${trackingNumber ? ` (${trackingNumber})` : ""}`,
    {
      code: "ALREADY_SHIPPED",
      httpStatus: 409,
      details: { trackingNumber },
    },
  );
}

function invalidCredentials(provider, detailMessage) {
  const suffix = detailMessage ? `: ${detailMessage}` : "";
  return new CourierError(`Invalid API credentials for ${provider}${suffix}`, {
    code: "INVALID_CREDENTIALS",
    httpStatus: 401,
    details: detailMessage ? { message: detailMessage } : undefined,
  });
}

function authError(provider, details) {
  return new CourierError(`Authentication failed for ${provider}`, {
    code: "AUTH_ERROR",
    httpStatus: 401,
    details,
  });
}

function networkTimeout(provider) {
  return new CourierError(`Network timeout calling ${provider}`, {
    code: "NETWORK_TIMEOUT",
    httpStatus: 504,
    retryable: true,
  });
}

function rateLimited(provider, details) {
  return new CourierError(`Rate limit exceeded for ${provider}`, {
    code: "RATE_LIMITED",
    httpStatus: 429,
    retryable: true,
    details,
  });
}

function duplicateBooking(details) {
  return new CourierError("Duplicate booking detected", {
    code: "DUPLICATE_BOOKING",
    httpStatus: 409,
    details,
  });
}

function invalidCity(city, details) {
  return new CourierError(`Invalid city: ${city || "(empty)"}`, {
    code: "INVALID_CITY",
    httpStatus: 400,
    details,
  });
}

function invalidWeight(weight, details) {
  return new CourierError(`Invalid weight: ${weight}`, {
    code: "INVALID_WEIGHT",
    httpStatus: 400,
    details,
  });
}

function providerUnavailable(provider, details) {
  return new CourierError(`Courier provider unavailable: ${provider}`, {
    code: "PROVIDER_UNAVAILABLE",
    httpStatus: 503,
    retryable: true,
    details,
  });
}

function shipmentNotFound(ref) {
  return new CourierError(`Shipment not found: ${ref}`, {
    code: "SHIPMENT_NOT_FOUND",
    httpStatus: 404,
  });
}

function configMissing(provider, companyId) {
  return new CourierError(
    `Courier configuration missing for ${provider} (company ${companyId})`,
    {
      code: "CONFIG_MISSING",
      httpStatus: 400,
    },
  );
}

function fromProviderMessage(message, opts = {}) {
  const msg = String(message || "Courier API error");
  const lower = msg.toLowerCase();

  if (/unauthor|invalid.*(key|token|credential|password|login)|401/.test(lower)) {
    return authError(opts.provider || "courier", { message: msg });
  }
  if (/rate.?limit|too many|429/.test(lower)) {
    return rateLimited(opts.provider || "courier", { message: msg });
  }
  if (/duplicate|already.?book|already.?exist/.test(lower)) {
    return duplicateBooking({ message: msg });
  }
  if (/city|destination/.test(lower) && /invalid|not.?found|unknown/.test(lower)) {
    return invalidCity(opts.city, { message: msg });
  }
  if (/weight/.test(lower)) {
    return invalidWeight(opts.weight, { message: msg });
  }
  if (/timeout|etimedout|econnreset|network/.test(lower)) {
    return networkTimeout(opts.provider || "courier");
  }

  return new CourierError(msg, {
    code: opts.code || "PROVIDER_ERROR",
    httpStatus: opts.httpStatus || 502,
    details: opts.details ?? { message: msg },
    retryable: opts.retryable,
  });
}

module.exports = {
  CourierError,
  orderNotFound,
  unsupportedCourier,
  alreadyShipped,
  invalidCredentials,
  authError,
  networkTimeout,
  rateLimited,
  duplicateBooking,
  invalidCity,
  invalidWeight,
  providerUnavailable,
  shipmentNotFound,
  configMissing,
  fromProviderMessage,
};

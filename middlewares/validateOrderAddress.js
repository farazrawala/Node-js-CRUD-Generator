/**
 * Express middleware: validate customer / order address quality.
 *
 * - Severely invalid → HTTP 400 (unless `soft: true`)
 * - Otherwise continue; attach `req.addressValidation` and optional warnings in locals
 *
 * Usage:
 *   router.post("/order/order_save", validateOrderAddressMiddleware(), order_save)
 *   router.post("/x", validateOrderAddressMiddleware({ soft: true }), handler)
 */

const {
  validateAddress,
  validateOrderAddressFields,
} = require("../validators/addressValidator");
const {
  loadAddressValidationConfig,
} = require("../config/addressValidation");

function pickAddressInput(req, fieldMap = {}) {
  const body = req.body || {};
  if (body.address_validation_skip === true || body.skip_address_validation === true) {
    return null;
  }

  // Explicit payload
  if (body.address != null || body.city != null || body.full_address != null) {
    if (typeof body.full_address === "string" && body.full_address.trim()) {
      return body.full_address;
    }
    return {
      address: body[fieldMap.address || "address"],
      house: body[fieldMap.house || "house"],
      building: body[fieldMap.building || "building"],
      street: body[fieldMap.street || "street"],
      area: body[fieldMap.area || "area"],
      city: body[fieldMap.city || "city"],
      postalCode:
        body[fieldMap.postalCode || "postalCode"] ||
        body.postal_code ||
        body.zip,
      zip: body.zip,
      country: body[fieldMap.country || "country"],
    };
  }

  return null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.soft=false] - never 400; only attach validation
 * @param {boolean} [opts.required=false] - if no address fields, skip (false) or 400 (true)
 * @param {number} [opts.severeScoreThreshold] - override config
 * @param {object} [opts.fieldMap]
 * @param {object} [opts.config] - config overrides
 */
function validateOrderAddressMiddleware(opts = {}) {
  const soft = opts.soft === true;
  const required = opts.required === true;

  return function addressValidationMiddleware(req, res, next) {
    try {
      const input = pickAddressInput(req, opts.fieldMap);
      if (input == null) {
        if (required) {
          return res.status(400).json({
            success: false,
            status: 400,
            error: "Address is required",
            type: "address_validation",
          });
        }
        return next();
      }

      const cfg = loadAddressValidationConfig(opts.config || null);
      const severe =
        opts.severeScoreThreshold ??
        cfg.severeScoreThreshold ??
        cfg.minimumScore ??
        40;

      const validation =
        typeof input === "string" ?
          validateAddress(input, { config: opts.config })
        : validateAddress(input, { config: opts.config });

      req.addressValidation = validation;

      const severeInvalid =
        validation.score < severe ||
        (!validation.normalizedAddress && !validation.isValid) ||
        (validation.warnings || []).some((w) =>
          /empty|too short|too few|repeated characters|gibberish/i.test(w),
        );

      // Hard empty / repeated / too short already score 0–20
      if (!soft && severeInvalid && validation.score < severe) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Address is too incomplete for delivery",
          type: "address_validation",
          address_validation: validation,
        });
      }

      // Allow save with warnings
      if (validation.warnings?.length) {
        res.locals.addressValidationWarnings = validation.warnings;
      }
      return next();
    } catch (err) {
      console.error("[addressValidation] middleware error:", err);
      return next();
    }
  };
}

/** Alias for validating structured order fields already on body */
function validateOrderAddressFieldsMiddleware(opts = {}) {
  return function (req, res, next) {
    try {
      const validation = validateOrderAddressFields(req.body || {}, {
        config: opts.config,
      });
      req.addressValidation = validation;
      const cfg = loadAddressValidationConfig(opts.config || null);
      const severe = opts.severeScoreThreshold ?? cfg.severeScoreThreshold ?? 40;
      if (opts.soft !== true && validation.score < severe) {
        return res.status(400).json({
          success: false,
          status: 400,
          error: "Address is too incomplete for delivery",
          type: "address_validation",
          address_validation: validation,
        });
      }
      return next();
    } catch (err) {
      console.error("[addressValidation] fields middleware error:", err);
      return next();
    }
  };
}

module.exports = {
  validateOrderAddressMiddleware,
  validateOrderAddressFieldsMiddleware,
  pickAddressInput,
};

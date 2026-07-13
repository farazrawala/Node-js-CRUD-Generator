/**
 * Per-company courier provider credentials & settings.
 * One company may enable multiple providers; preferredCourier on company picks default.
 * @module src/models/courier_provider.model
 */

const mongoose = require("mongoose");
const {
  encryptProviderSecrets,
} = require("../utils/encryptCredentials");
const { PROVIDERS, normalizeProviderKey } = require("../couriers/constants");

const PROVIDER_ENUM = Object.values(PROVIDERS);

const courierProviderSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      enum: PROVIDER_ENUM,
      set: (v) => normalizeProviderKey(v) || v,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    api_key: { type: String, default: null },
    secret: { type: String, default: null },
    username: { type: String, default: null },
    password: { type: String, default: null },
    account_no: { type: String, default: null },
    pickup_location: { type: String, default: null },
    service_type: { type: String, default: null },
    base_url: { type: String, default: null },
    sandbox: { type: Boolean, default: true },
    /** Provider-specific extras (cost center, clientId, city defaults, etc.). */
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

courierProviderSchema.index(
  { company_id: 1, provider: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);

courierProviderSchema.pre("save", function (next) {
  try {
    const encrypted = encryptProviderSecrets({
      api_key: this.api_key,
      secret: this.secret,
      username: this.username,
      password: this.password,
    });
    this.api_key = encrypted.api_key;
    this.secret = encrypted.secret;
    this.username = encrypted.username;
    this.password = encrypted.password;
    next();
  } catch (err) {
    next(err);
  }
});

courierProviderSchema.pre(
  ["findOneAndUpdate", "findByIdAndUpdate", "updateOne"],
  function (next) {
    try {
      const update = this.getUpdate() || {};
      const target = update.$set ? update.$set : update;
      const encrypted = encryptProviderSecrets(target);
      for (const key of ["api_key", "secret", "username", "password"]) {
        if (Object.prototype.hasOwnProperty.call(encrypted, key)) {
          target[key] = encrypted[key];
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  },
);

const CourierProvider =
  mongoose.models.courier_provider ||
  mongoose.model("courier_provider", courierProviderSchema);

module.exports = CourierProvider;

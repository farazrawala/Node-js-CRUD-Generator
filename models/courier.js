const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        "tcs",
        "leopard",
        "blueex",
        "mnp",
        "call_courier",
        "trax",
        "postex",
      ],
      default: "tcs",
      field_name: "Courier",
      field_type: "select",
    },
    name: {
      type: String,
      required: true,
      field_name: "Name",
    },
    url: {
      type: String,
      required: true,
      field_name: "API URL",
    },
    login: {
      type: String,
      required: true,
      field_name: "ID",
    },
    password: {
      type: String,
      required: true,
      field_name: "Password",
      field_type: "password",
    },
    token: {
      type: String,
      field_name: "Token",
      field_type: "password",
    },
    /** TCS OAuth client id — used to auto-refresh bearer Token when missing/expired. */
    client_id: {
      type: String,
      field_name: "Client ID",
    },
    /** TCS OAuth client secret — used to auto-refresh bearer Token when missing/expired. */
    client_secret: {
      type: String,
      field_name: "Client Secret",
      field_type: "password",
    },
    /**
     * Optional rich fields used by the Provider module (src/).
     * Prefer `courier_provider` collection for full multi-provider config;
     * this model remains available for admin CRUD and legacy fallback.
     */
    account_no: {
      type: String,
      field_name: "Account No",
    },
    /** TCS cost center code (shipmentinfo.costcentercode). */
    cost_center: {
      type: String,
      field_name: "Cost Center",
    },
    sandbox: {
      type: Boolean,
      default: true,
      field_name: "Sandbox",
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      field_name: "Settings",
    },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

const MODEL = mongoose.model("courier", modelSchema);

module.exports = MODEL;

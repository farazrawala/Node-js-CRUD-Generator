const mongoose = require("mongoose");

/** Canonical courier type keys (used by enum + logo map). */
const COURIER_TYPE_VALUES = [
  "tcs",
  "leopard",
  "blueex",
  "mnp",
  "call_courier",
  "trax",
  "postex",
  "flagship",
  "other",
];

/**
 * Display meta per type. Logos are served from /public/couriers/.
 * logo is a path relative to the API public root (e.g. /public/couriers/tcs.svg).
 */
const COURIER_TYPE_META = {
  tcs: {
    label: "TCS",
    logo: "/public/couriers/tcs.svg",
  },
  leopard: {
    label: "Leopard",
    logo: "/public/couriers/leopard.svg",
  },
  blueex: {
    label: "BlueEx",
    logo: "/public/couriers/blueex.svg",
  },
  mnp: {
    label: "M&P",
    logo: "/public/couriers/mnp.svg",
  },
  call_courier: {
    label: "Call Courier",
    logo: "/public/couriers/call_courier.svg",
  },
  trax: {
    label: "Trax",
    logo: "/public/couriers/trax.svg",
  },
  postex: {
    label: "PostEx",
    logo: "/public/couriers/postex.svg",
  },
  flagship: {
    label: "Flagship (Flaship)",
    logo: "/public/couriers/flagship.jpg",
  },
  other: {
    label: "Other",
    logo: null,
  },
};

function getCourierTypeMeta(type) {
  return COURIER_TYPE_META[type] || null;
}

function listCourierTypes() {
  return COURIER_TYPE_VALUES.map((value) => ({
    value,
    label: COURIER_TYPE_META[value]?.label || value,
    logo: COURIER_TYPE_META[value]?.logo || null,
  }));
}

const modelSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: COURIER_TYPE_VALUES,
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
      required: false,
      default: "",
      field_name: "API URL",
    },
    login: {
      type: String,
      required: false,
      default: "",
      field_name: "ID",
    },
    password: {
      type: String,
      required: false,
      default: "",
      field_name: "Password",
      field_type: "password",
    },
    token: {
      type: String,
      field_name: "Token",
      field_type: "password",
    },
    pickup_address: {
      type: String,
      field_name: "Pickup Address",
    },
    return_address: {
      type: String,
      field_name: "Return Address",
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

modelSchema.virtual("logo").get(function () {
  return COURIER_TYPE_META[this.type]?.logo || null;
});

modelSchema.set("toJSON", { virtuals: true });
modelSchema.set("toObject", { virtuals: true });

const MODEL = mongoose.model("courier", modelSchema);

module.exports = MODEL;
module.exports.COURIER_TYPE_VALUES = COURIER_TYPE_VALUES;
module.exports.COURIER_TYPE_META = COURIER_TYPE_META;
module.exports.getCourierTypeMeta = getCourierTypeMeta;
module.exports.listCourierTypes = listCourierTypes;

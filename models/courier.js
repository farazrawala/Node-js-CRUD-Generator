const mongoose = require("mongoose");
const Schema = mongoose.Schema;

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

var courier = new Schema(
  {
    type: {
      type: String,
      enum: COURIER_TYPE_VALUES,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: false,
    },
    password: {
      type: String,
      required: false,
    },
    api_key: {
      type: String,
      required: false,
    },
    api_password: {
      type: String,
      required: false,
    },
    cost_center_code: {
      type: String,
      required: false,
    },
    origin_city: {
      type: String,
      required: false,
    },
    is_active: {
      type: Boolean,
      default: false,
    },
    company_id: {
      type: Schema.Types.ObjectId,
      ref: "company",
      required: false,
      default: null,
    },
    created_user: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: false,
      default: null,
    },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
    collection: "courier",
    autoCreate: true,
  }
);

courier.virtual("logo").get(function () {
  return COURIER_TYPE_META[this.type]?.logo || null;
});

courier.set("toJSON", { virtuals: true });
courier.set("toObject", { virtuals: true });

const Courier = mongoose.model("courier", courier);

module.exports = Courier;
module.exports.COURIER_TYPE_VALUES = COURIER_TYPE_VALUES;
module.exports.COURIER_TYPE_META = COURIER_TYPE_META;
module.exports.getCourierTypeMeta = getCourierTypeMeta;
module.exports.listCourierTypes = listCourierTypes;

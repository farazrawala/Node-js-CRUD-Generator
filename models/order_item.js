const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
    },
    qty: {
      type: String,
      required: true,
    },
    image: {
      type: String,
      field_type: "image",
    },
    order_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
      required: true,
    },
  },
  { timestamps: true }
);

const MODEL = mongoose.model("order_item", modelSchema);

module.exports = MODEL;

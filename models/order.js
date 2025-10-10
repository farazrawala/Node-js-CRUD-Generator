const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Order User",
    },


    // image: {
    //   type: [String],
    //   field_type: "image",
    // },
  },
  { timestamps: true }
);

const MODEL = mongoose.model("order", modelSchema);

module.exports = MODEL;

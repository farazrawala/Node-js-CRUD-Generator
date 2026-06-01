const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    title: {
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
      field_name: "Complain User",
    },
    image: {
      type: String,
      field_name: "Attachments",
      field_type: "image",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
    },
  },
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

const MODEL = mongoose.model("complain", modelSchema);

module.exports = MODEL;

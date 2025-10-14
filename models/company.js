const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    company_name: {
      type: String,
      required: true,
    },
    company_phone: {
      type: String,
      // required: true,
    },
    company_email: {
      type: String,
      // required: true,
    },
    company_address: {
      type: String,
      // required: true,
    },
    company_logo: {
      type: String,
      field_name: "Logo Image",
    },
    status: { 
      type: String,
      required: true,
      enum: ["active", "nonactive"], 
      default: "active"              
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true }
);

const MODEL = mongoose.model("company", modelSchema);

module.exports = MODEL;

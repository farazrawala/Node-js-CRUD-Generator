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
      field_type: "image",
    },
    // warehouse_id:{
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "warehouse",
    //   field_name: "Default Store",
    // },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
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

const MODEL = mongoose.model("company", modelSchema);

module.exports = MODEL;

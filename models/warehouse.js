const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    warehouse_name: {
      type: String,
      required: true,
    },
    warehouse_address: {
      type: String,
      required: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
    //   required: true,
      field_name: "Company",
    },
    warehouse_image: {
      type: String,
      field_name: "WareHouse Image",
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

const MODEL = mongoose.model("warehouse", modelSchema);

module.exports = MODEL;

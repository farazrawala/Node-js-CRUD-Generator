const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    warehouse_name: {
      type: String,
      // required: true,
    },
    warehouse_address: {
      type: String,
      // required: true,
    },
    
    warehouse_image: {
      type: String,
      field_name: "WareHouse Image",
    },
    // default fields
    company_id:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
      field_name: "Company",
    },
    created_by:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    updated_by:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
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

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
    code:{
      type: String,
      field_name: "Warehouse Code",
    },
    city:{
      type: String,
      field_name: "City",
    },
    state:{
      type: String,
      field_name: "State",
    },
    zip_code:{
      type: String,
      field_name: "Zip Code",
    },
    phone:{
      type: String,
      field_name: "Phone",
    },
    email:{
      type: String,
      field_name: "Email",
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

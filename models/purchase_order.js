const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    vendor_id:
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Vendor Id",
    },
    ref_no:{
        type: String,
    //   required: true,
    },

    description: {
      type: String,
    //   required: true,
    },
   
    image: {
      type: String,
      field_name: "Blog Image",
    },
    
    company_id:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
      field_name: "Company",
    },
    stock_update:{
        type: String,
        required: true,
        enum: ["yes", "no"],
        field_name: "Stock Update", 
        default: "yes"  
    },
    order_data:{
        type: String,
        required: true,
    },

    // default fields
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

const MODEL = mongoose.model("purchase_order", modelSchema);

module.exports = MODEL;

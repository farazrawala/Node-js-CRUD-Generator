const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    
    store_type: {
        type: String,
        required: true,
        enum: ["shopify", "woocommerce", "daraz"], 
        default: "shopify"        
    },
    name: {
        type: String,
        required: true,
    },
    address: {
        type: String,
        required: true,
    },
    city: {
        type: String,
        required: true,
    },
    state: {
        type: String,
        required: true,
    },
    email: {
      type: String,
      // required: true,
    },
    number: {
      type: String,
      // required: true,
    },
    url: {
      type: String,
      // required: true,
    },
    secret_key: {
      type: String,
      // required: true,
    },
    api_key: {
      type: String,
      // required: true,
    },

    description: {
      type: String,
      required: true,
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

const MODEL = mongoose.model("integration", modelSchema);

module.exports = MODEL;

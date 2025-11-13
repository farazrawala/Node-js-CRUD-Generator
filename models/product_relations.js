const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    product_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "product",
        required: true,
    },
    product_integration_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "integration",
        required: true,
    },
    ref_id : {
        type: String,
        // required: true,
    },
    store_price : {
        type: Number,
        // required: true,
    },
    product_url:{
        type: String,
        // required: true,
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
      enum: ["active", "inactive"], 
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

const MODEL = mongoose.model("product_relations", modelSchema);

module.exports = MODEL;

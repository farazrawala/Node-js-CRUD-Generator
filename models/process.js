const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    
    integration_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "integration",
        field_name: "Integration",
    },
    product_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "product",
        field_name: "Product",
    },
    action:{
        type: String,
        required: true,
        enum: ["fetch_products", "sync_product", "delete_product","fetch_category","sync_category","delete_category"],
        field_name: "Action",
    },
    count:{ 
        type: Number,
        field_name: "Count",
        default: 0,
    },
    page:{
        type: Number,
        field_name: "Price",
        default: 1,
    },
    offset:{
        type: Number,
        default: 1,
        field_name: "Offset",
    },
    limit:{
        type: Number,
        field_name: "Limit",
        default: 1,
    },
    priority:{ 
        type: Number,
        field_name: "Priority",
        default: 100,
    },
    remarks:{
        type: String,
        field_name: "Remarks",
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
      enum: ["active", "inactive","completed","failed","pending"], 
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

const MODEL = mongoose.model("process", modelSchema);

module.exports = MODEL;

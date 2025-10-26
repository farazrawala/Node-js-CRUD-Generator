const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    purchase_order_id:
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "purchase_order",
      field_name: "Purchase Order ID",
    },
    product_id:{
        type: String,
      required: true, 
    },
    qty:{
      type: Number,
      required: true, 
    },
    price:{
      type: Number,
      required: true, 
    },
    total:{
        type: Number,
        required: true, 
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

const MODEL = mongoose.model("purchase_order_item", modelSchema);

module.exports = MODEL;

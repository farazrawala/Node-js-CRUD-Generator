const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    attribute_values: {
      type: [
        {
          name: {
            type: String,
            required: true,
            field_name: "Attribute Value"
          },
          last_updated: {
            type: Date,
            default: Date.now,
            field_name: "Last Updated"
          }
        }
      ],
      default: [],
      field_name: "Warehouse Inventory"
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

const MODEL = mongoose.model("attribute", modelSchema);

module.exports = MODEL;

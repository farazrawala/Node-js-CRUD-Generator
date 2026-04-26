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

    default_cash_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Cash Account",
    },
    default_sales_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Sales Account",
    },
    default_purchase_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Purchase Account",
    },
    default_sales_discount_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Sales Discount Account",
    },
    default_purchase_discount_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Purchase Discount Account",
    },
    default_account_receivable_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Account Receivable Account",
    },
    default_account_payable_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Account Payable Account",
    },
    default_shipping_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Shipping Account",
    },

    // warehouse_id:{z
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

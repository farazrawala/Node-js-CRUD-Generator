const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    account_number: {
      type: String,
      //   required: true,
    },
    initial_balance: {
      type: Number,
      //   required: true,
    },
    description: {
      type: String,
      //   required: true,
    },

    account_type: {
      type: String,
      required: true,
      enum: [
        "current_asset",
        "fixed_asset",
        "revenue",
        "cost of goods sold",
        "operating expense",
        "other expense",
        "equity",
        "liability",
        "other",
      ],
      field_name: "Account Type",
    },
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

const MODEL = mongoose.model("account", modelSchema);

module.exports = MODEL;

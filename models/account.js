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
      default: 0,
    },
    description: {
      type: String,
      //   required: true,
    },
    transaction_number: {
      type: String,
      field_name: "Transaction Number",
    },
    account_type: {
      type: String,
      required: true,
      enum: [
        "current_asset",
        "account_receivable",
        "fixed_asset",
        "revenue",
        "cost_of_goods_sold_account",
        "operating_expense",
        "other_expense",
        "equity",
        "current_liability",
        "other",
      ],
      field_name: "Account Type",
    },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
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
    /** When false, account should not be deleted (e.g. system / default GL). */
    is_deletable: {
      type: Boolean,
      default: true,
    },
    is_editable: {
      type: Boolean,
      default: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

const activeAccountPartial = {
  status: "active",
  deletedAt: null,
  company_id: { $exists: true, $ne: null },
};

modelSchema.index(
  { company_id: 1, name: 1 },
  { unique: true, partialFilterExpression: activeAccountPartial },
);

modelSchema.index(
  { company_id: 1, account_number: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ...activeAccountPartial,
      account_number: { $exists: true, $nin: [null, ""] },
    },
  },
);

modelSchema.pre("validate", function (next) {
  if (this.initial_balance === null || this.initial_balance === undefined) {
    this.initial_balance = 0;
  }
  next();
});

const MODEL = mongoose.model("account", modelSchema);

module.exports = MODEL;

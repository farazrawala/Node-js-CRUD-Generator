const mongoose = require("mongoose");

const stockTransferSchema = new mongoose.Schema(
  {
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      required: true,
      field_name: "Product"
    },
    from_warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      field_name: "From Warehouse"
    },
    to_warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      required: true,
      field_name: "To Warehouse"
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      field_name: "Quantity"
    },
    transfer_status: {
      type: String,
      enum: ["Pending", "Completed", "Failed"],
      default: "Completed",
      field_name: "Status"
    },
    transfer_date: {
      type: Date,
      default: Date.now,
      field_name: "Transfer Date"
    },
    notes: {
      type: String,
      field_name: "Notes"
    },
    reference_code: {
      type: String,
      field_name: "Reference Code"
    },
    failure_reason: {
      type: String,
      field_name: "Failure Reason"
    },
    from_balance_before: {
      type: Number,
      field_name: "Source Balance Before"
    },
    from_balance_after: {
      type: Number,
      field_name: "Source Balance After"
    },
    to_balance_before: {
      type: Number,
      field_name: "Destination Balance Before"
    },
    to_balance_after: {
      type: Number,
      field_name: "Destination Balance After"
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company"
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By"
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By"
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At"
    }
  },
  { timestamps: true }
);

stockTransferSchema.pre("save", function(next) {
  if (!this.reference_code) {
    const suffix = Math.floor(Math.random() * 9000) + 1000;
    this.reference_code = `ST-${Date.now()}-${suffix}`;
  }
  if (!this.transfer_date) {
    this.transfer_date = new Date();
  }
  next();
});

const MODEL = mongoose.model("stock_transfer", stockTransferSchema);

module.exports = MODEL;


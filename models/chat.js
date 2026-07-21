const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    message_id: {
      type: String,
      // required: true,
    },
    from_user_id: {
      type: String,
      required: true,
    },
    to_user_id: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
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
      enum: [
        "not_started",
        "inprocess",
        "sent",
        "not_available",
        "active",
        "inactive",
      ],
      default: "not_started",
      field_name: "Status",
      index: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

const MODEL = mongoose.model("chat", modelSchema);

module.exports = MODEL;

const mongoose = require("mongoose");

const taskBoardSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    name: {
      type: String,
      required: true,
      trim: true,
      field_name: "Name",
    },
    description: {
      type: String,
      default: "",
      field_name: "Description",
    },
    color: {
      type: String,
      default: "#0d6efd",
      field_name: "Color",
    },
    icon: {
      type: String,
      default: "clipboard",
      field_name: "Icon",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Created By",
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
      },
    ],
    is_archived: {
      type: Boolean,
      default: false,
      field_name: "Archived",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

taskBoardSchema.index({ company_id: 1, is_archived: 1 });
taskBoardSchema.index({ company_id: 1, members: 1 });
taskBoardSchema.index({ company_id: 1, created_by: 1 });
taskBoardSchema.index({ updatedAt: -1 });

const TaskBoard = mongoose.model("task_board", taskBoardSchema);

module.exports = TaskBoard;

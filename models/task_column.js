const mongoose = require("mongoose");

const taskColumnSchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    board_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "task_board",
      required: true,
      field_name: "Board",
    },
    name: {
      type: String,
      required: true,
      trim: true,
      field_name: "Name",
    },
    position: {
      type: Number,
      required: true,
      default: 1000,
      field_name: "Position",
    },
    color: {
      type: String,
      default: "#6c757d",
      field_name: "Color",
    },
    wip_limit: {
      type: Number,
      default: null,
      field_name: "WIP Limit",
    },
    is_archived: {
      type: Boolean,
      default: false,
      field_name: "Archived",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

taskColumnSchema.index({ company_id: 1, board_id: 1, position: 1 });
taskColumnSchema.index({ company_id: 1, board_id: 1, is_archived: 1 });

const TaskColumn = mongoose.model("task_column", taskColumnSchema);

module.exports = TaskColumn;

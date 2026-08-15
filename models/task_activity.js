const mongoose = require("mongoose");

const taskActivitySchema = new mongoose.Schema(
  {
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
    },
    task_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "task",
      required: true,
      index: true,
    },
    board_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "task_board",
      default: null,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    action: {
      type: String,
      required: true,
    },
    old_value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    new_value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

taskActivitySchema.index({ company_id: 1, task_id: 1, createdAt: -1 });
taskActivitySchema.index({ company_id: 1, board_id: 1, createdAt: -1 });

const TaskActivity = mongoose.model("task_activity", taskActivitySchema);

module.exports = TaskActivity;

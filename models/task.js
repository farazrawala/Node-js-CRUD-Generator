const mongoose = require("mongoose");

const PRIORITY_VALUES = ["low", "medium", "high", "urgent"];

const checklistItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    is_completed: { type: Boolean, default: false },
    position: { type: Number, default: 1000 },
  },
  { _id: true },
);

const checklistSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, default: "Checklist" },
    items: { type: [checklistItemSchema], default: [] },
  },
  { _id: true },
);

const attachmentSchema = new mongoose.Schema(
  {
    name: String,
    filename: String,
    url: String,
    path: String,
    mime_type: String,
    size: Number,
    uploaded_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
    },
    uploaded_at: { type: Date, default: Date.now },
  },
  { _id: true },
);

const taskSchema = new mongoose.Schema(
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
    column_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "task_column",
      required: true,
      field_name: "Column",
    },
    title: {
      type: String,
      required: true,
      trim: true,
      field_name: "Title",
    },
    description: {
      type: String,
      default: "",
      field_name: "Description",
    },
    task_number: {
      type: Number,
      required: true,
      field_name: "Task Number",
    },
    priority: {
      type: String,
      enum: PRIORITY_VALUES,
      default: "medium",
      field_name: "Priority",
    },
    status: {
      type: String,
      default: "",
      field_name: "Status",
    },
    assignee_ids: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
      },
    ],
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Created By",
    },
    labels: {
      type: [String],
      default: [],
      field_name: "Labels",
    },
    due_date: {
      type: Date,
      default: null,
      field_name: "Due Date",
    },
    start_date: {
      type: Date,
      default: null,
      field_name: "Start Date",
    },
    attachments: {
      type: [attachmentSchema],
      default: [],
    },
    checklists: {
      type: [checklistSchema],
      default: [],
    },
    comments_count: {
      type: Number,
      default: 0,
    },
    position: {
      type: Number,
      required: true,
      default: 1000,
      field_name: "Position",
    },
    is_completed: {
      type: Boolean,
      default: false,
      field_name: "Completed",
    },
    is_archived: {
      type: Boolean,
      default: false,
      field_name: "Archived",
    },
    completed_at: {
      type: Date,
      default: null,
      field_name: "Completed At",
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

taskSchema.index({ company_id: 1, board_id: 1 });
taskSchema.index({ company_id: 1, column_id: 1, position: 1 });
taskSchema.index({ company_id: 1, board_id: 1, column_id: 1, position: 1 });
taskSchema.index({ company_id: 1, assignee_ids: 1 });
taskSchema.index({ company_id: 1, due_date: 1 });
taskSchema.index({ company_id: 1, created_by: 1 });
taskSchema.index({ company_id: 1, updatedAt: -1 });
taskSchema.index(
  { company_id: 1, task_number: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
taskSchema.index({ company_id: 1, is_completed: 1, is_archived: 1 });

const Task = mongoose.model("task", taskSchema);

module.exports = Task;
module.exports.PRIORITY_VALUES = PRIORITY_VALUES;

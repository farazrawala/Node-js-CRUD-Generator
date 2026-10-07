const mongoose = require("mongoose");

/**
 * Restaurant floors (Main Hall, Rooftop…) with their tables laid out on a drag-and-drop
 * floor plan. Positions are in canvas units: (0, 0) is the top-left of a
 * `canvas_width` × `canvas_height` plan, so the POS can scale the plan to any screen.
 *
 * Table status stores only what staff set by hand (free / reserved / cleaning);
 * "occupied" and "bill printed" come from the open order on the table.
 */

const TABLE_SHAPES = ["square", "rect", "round"];
const TABLE_STATUSES = ["free", "reserved", "cleaning"];
const FIXTURE_KINDS = ["wall", "door", "window", "bar", "counter", "kitchen", "washroom", "stairs", "plant", "label"];

const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

const tableSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true, maxlength: 30, field_name: "Table" },
  seats: { type: Number, min: 1, max: 100, default: 4, field_name: "Seats" },
  shape: { type: String, enum: TABLE_SHAPES, default: "square", field_name: "Shape" },
  x: { type: Number, min: 0, default: 0 },
  y: { type: Number, min: 0, default: 0 },
  width: { type: Number, min: 20, default: 80 },
  height: { type: Number, min: 20, default: 80 },
  rotation: { type: Number, min: -360, max: 360, default: 0 },
  status: { type: String, enum: TABLE_STATUSES, default: "free", field_name: "Table Status" },
  // Hide a table from the POS without deleting it (old orders keep pointing at it).
  is_active: { type: Boolean, default: true },
});

// Non-seating things drawn on the plan so staff recognise the room (bar, doors, walls…).
const fixtureSchema = new mongoose.Schema({
  kind: { type: String, enum: FIXTURE_KINDS, default: "label" },
  label: { type: String, trim: true, maxlength: 40, default: "" },
  x: { type: Number, min: 0, default: 0 },
  y: { type: Number, min: 0, default: 0 },
  width: { type: Number, min: 4, default: 120 },
  height: { type: Number, min: 4, default: 40 },
  rotation: { type: Number, min: -360, max: 360, default: 0 },
});

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true,
      maxlength: 60,
      field_name: "Floor",
    },
    // Tab order in the POS (lowest first).
    sort_order: { type: Number, default: 0, field_name: "Sort Order" },
    // null = the company's default branch (the only one used for now).
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
      default: null,
      field_name: "Branch",
    },
    canvas_width: { type: Number, min: 200, max: 10000, default: 1200, field_name: "Plan Width" },
    canvas_height: { type: Number, min: 200, max: 10000, default: 800, field_name: "Plan Height" },
    tables: {
      type: [tableSchema],
      default: [],
      field_name: "Tables",
      validate: {
        validator: (tables) =>
          (tables || []).every((t, i) => !tables.some((o, j) => j < i && sameName(o.name, t.name))),
        message: "Each table on a floor needs a different name.",
      },
    },
    fixtures: { type: [fixtureSchema], default: [], field_name: "Fixtures" },
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
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

modelSchema.index({ company_id: 1, branch_id: 1, deletedAt: 1, sort_order: 1 });
modelSchema.index({ "tables._id": 1 });

const MODEL = mongoose.model("restaurant_floors", modelSchema);

MODEL.TABLE_SHAPES = TABLE_SHAPES;
MODEL.TABLE_STATUSES = TABLE_STATUSES;
MODEL.FIXTURE_KINDS = FIXTURE_KINDS;

module.exports = MODEL;

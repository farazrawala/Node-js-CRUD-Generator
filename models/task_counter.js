const mongoose = require("mongoose");

const taskCounterSchema = new mongoose.Schema({
  company_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "company",
    required: true,
    unique: true,
  },
  seq: {
    type: Number,
    default: 0,
  },
});

const TaskCounter = mongoose.model("task_counter", taskCounterSchema);

module.exports = TaskCounter;

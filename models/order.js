const mongoose = require("mongoose");

// Counter schema for auto-increment
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter =
  mongoose.models.counter || mongoose.model("counter", counterSchema);

// Function to get next sequence number
async function getNextSequence(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    order_no: {
      type: String,
      field_name: "Order No",
      unique: true,
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },

    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Order User",
    },

    // image: {
    //   type: [String],
    //   field_type: "image",
    // },
  },
  { timestamps: true }
);

// Pre-save hook to auto-generate order_no if not provided
modelSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next(); // Only generate for new documents
  }

  if (!this.order_no || this.order_no.trim() === "") {
    try {
      const seq = await getNextSequence("order_no");
      this.order_no = `ORD-${String(seq).padStart(6, "0")}`;
    } catch (error) {
      return next(error);
    }
  }
  next();
});

const MODEL = mongoose.model("order", modelSchema);

module.exports = MODEL;

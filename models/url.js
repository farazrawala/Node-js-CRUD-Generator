const mongoose = require("mongoose");
// const shortid = require("shortid");

const urlSchema = new mongoose.Schema(
  {
    shortid: {
      type: String,
      required: true
    },
    redirectUrl: {
      type: String,
      required: true,
    },
    visitHistory: [
      {
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

const URL = mongoose.model("url", urlSchema);

module.exports = URL;

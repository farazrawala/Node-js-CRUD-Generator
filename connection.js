const mongoose = require("mongoose");

async function connectMonogodb(url) {
  return mongoose.connect(url);
}

module.exports = {
  connectMonogodb,
};

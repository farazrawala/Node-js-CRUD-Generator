const {
  handleGenericCreate,
  handleGenericUpdate,
} = require("../utils/modelHelper");

async function adjustmentCreate(req, res) {
  const response = await handleGenericCreate(req, "adjustment", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function adjustmentUpdate(req, res) {
  const response = await handleGenericUpdate(req, "adjustment", {});
  return res.status(response.status).json(response);
}

module.exports = {
  adjustmentCreate,
  adjustmentUpdate,
};

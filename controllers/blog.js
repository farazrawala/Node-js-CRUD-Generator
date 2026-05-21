const {
  handleGenericCreate,
  handleGenericUpdate,
} = require("../utils/modelHelper");

async function blogCreate(req, res) {
  const response = await handleGenericCreate(req, "blog", {
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });
  return res.status(response.status).json(response);
}

async function blogUpdate(req, res) {
  const response = await handleGenericUpdate(req, "blog", {});
  return res.status(response.status).json(response);
}

module.exports = {
  blogCreate,
  blogUpdate,
};

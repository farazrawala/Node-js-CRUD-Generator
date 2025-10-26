const {
    handleGenericCreate,
    handleGenericUpdate,
    handleGenericGetById,
    handleGenericGetAll,
    handleGenericFindOne,
  } = require("../utils/modelHelper");
  
  async function integrationCreate(req, res) {
  //   const response = await handleGenericCreate(req, "integration", {
  //     afterCreate: async (record, req) => {
  //       console.log("✅ Record created successfully:", record);
  //     },
  //   });
    return res.status(2).json({'message':'response'});
  }
  
  
  
  module.exports = {
    integrationCreate,
    // integrationUpdate,
    // integrationById,
    // getAllintegration,
    // getallintegrationactive,
    // integrationdelete,
    // findActiveBlogByTitle,
    // findBlogByParams,
  };
  
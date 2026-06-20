function createMockExpressResponse() {
  const state = {
    statusCode: 200,
    body: null,
    headersSent: false,
  };

  const res = {
    status(code) {
      state.statusCode = Number(code) || 200;
      return res;
    },
    json(payload) {
      state.body = payload;
      state.headersSent = true;
      return res;
    },
    getResult() {
      return {
        statusCode: state.statusCode,
        body: state.body,
        headersSent: state.headersSent,
        success: state.body?.success !== false,
      };
    },
  };

  return res;
}

module.exports = {
  createMockExpressResponse,
};

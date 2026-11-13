function normalizeDealProductsInBody(body) {
  if (typeof body.deal_products !== "string") return;

  try {
    body.deal_products = JSON.parse(body.deal_products);
  } catch {
    const error = new Error("deal_products must be a valid JSON array.");
    error.statusCode = 400;
    throw error;
  }

  if (!Array.isArray(body.deal_products)) {
    const error = new Error("deal_products must be a valid JSON array.");
    error.statusCode = 400;
    throw error;
  }
}

module.exports = { normalizeDealProductsInBody };

const { unlinkSyncProductMapping } = require("../utils/processHelpers");
const { coalesceObjectId } = require("../utils/modelHelper");
const { invalidateModuleListCachesForReq } = require("../utils/redisCache");
const { logControllerError } = require("../utils/logControllerError");

function pickFirst(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== "") return value;
  }
  return null;
}

/**
 * Unlink a POS product from a store integration (soft-deletes the sync_product
 * mapping). Does not delete the product on Shopify/WooCommerce.
 *
 * POST /api/sync_product/unlink
 * DELETE /api/sync_product/unlink/:id
 *
 * Body / query / params:
 *   _id | id              mapping id
 *   product_id            POS product
 *   integration_id        store integration
 */
async function unlinkSyncProduct(req, res) {
  try {
    const mappingId = pickFirst(
      req.params?.id,
      req.body?._id,
      req.body?.id,
      req.query?._id,
      req.query?.id,
    );
    const productId = pickFirst(req.body?.product_id, req.query?.product_id);
    const integrationId = pickFirst(
      req.body?.integration_id,
      req.query?.integration_id,
    );
    const companyId = coalesceObjectId(req.user?.company_id);

    const result = await unlinkSyncProductMapping({
      mappingId,
      productId,
      integrationId,
      companyId,
      updatedBy: req.user?._id,
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        status: result.status || 400,
        error: result.error,
        message: result.error,
      });
    }

    await invalidateModuleListCachesForReq(req, "sync_product");

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Product unlinked from store",
      data: result.mapping,
      cancelled_processes: result.cancelled_processes,
    });
  } catch (error) {
    await logControllerError(
      req,
      error?.message || "Failed to unlink product from store",
      {
        action: "sync_product/unlink",
        tags: ["api", "error", "sync_product"],
        fallbackUrl: "/api/sync_product/unlink",
      },
    );
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Failed to unlink product from store",
      message: error.message || "Failed to unlink product from store",
    });
  }
}

module.exports = {
  unlinkSyncProduct,
};

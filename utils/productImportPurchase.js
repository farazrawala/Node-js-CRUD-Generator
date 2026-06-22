const Company = require("../models/company");
const User = require("../models/user");
const { coalesceObjectId } = require("./modelHelper");
const {
  buildUserCompanyPopulate,
  normalizePopulatedCompanyForClient,
} = require("./userCompanyPopulate");
const { createMockExpressResponse } = require("./mockExpressResponse");

async function resolveCompanyDefaultWarehouseId(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid) return null;

  const company = await Company.findOne({
    _id: cid,
    status: "active",
    deletedAt: null,
  })
    .select("warehouse_id")
    .lean();

  const wid = company?.warehouse_id;
  if (wid != null && coalesceObjectId(wid)) {
    return coalesceObjectId(wid);
  }
  return null;
}

async function hydrateUserForPurchaseOrder(user) {
  if (!user?._id) return user;
  if (user.company_id?.default_purchase_account) {
    return user;
  }

  const dbUser = await User.findById(user._id)
    .populate([buildUserCompanyPopulate()])
    .lean();

  if (dbUser?.company_id && typeof dbUser.company_id === "object") {
    normalizePopulatedCompanyForClient(dbUser.company_id);
  }
  return dbUser || user;
}

/**
 * One purchase order for all imported products — stock via PO + inventory_movements (not direct warehouse writes).
 */
async function createPurchaseOrderForImportStock({
  req,
  companyId,
  lines,
  warehouseId = null,
  vendorId = null,
  description = null,
}) {
  const cid = coalesceObjectId(companyId);
  const stockLines = (lines || []).filter((line) => {
    const qty = Number(line.qty);
    return line.product_id && Number.isFinite(qty) && qty > 0;
  });

  if (!stockLines.length) {
    return {
      skipped: true,
      reason: "no_stock_lines",
      message: "No import rows with qty > 0; purchase order not created.",
    };
  }

  const wid =
    coalesceObjectId(warehouseId) ||
    (await resolveCompanyDefaultWarehouseId(cid));

  if (!wid) {
    return {
      skipped: true,
      reason: "no_warehouse",
      message:
        "No warehouse_id on request and company has no default warehouse; stock not added.",
    };
  }

  const user = await hydrateUserForPurchaseOrder(req.user);
  const vendorOid = coalesceObjectId(vendorId);

  const poReq = {
    ...req,
    bulkPoImport: true,
    params: req.params || {},
    user,
    body: {
      description:
        description ||
        `PO CSV import — ${stockLines.length} item(s)`,
      vendor_id: vendorOid ? String(vendorOid) : undefined,
      discount: 0,
      shipment: 0,
      amount_paid: 0,
      order_status: "placed",
      stock_update: "yes",
      product_ids: stockLines.map((line) => {
        const qty = Number(line.qty);
        const price = Number(line.price) || 0;
        return {
          product_id: String(line.product_id),
          qty,
          price,
          subtotal: Math.round(qty * price * 100) / 100,
          warehouse_id: String(wid),
        };
      }),
    },
  };

  const mockRes = createMockExpressResponse();
  const { purchaseOrderCreate } = require("../controllers/purchase_order");
  await purchaseOrderCreate(poReq, mockRes);
  const result = mockRes.getResult();

  if (!result.success) {
    return {
      skipped: false,
      success: false,
      status: result.statusCode,
      message: result.body?.message || result.body?.error || "Purchase order failed",
      error: result.body,
    };
  }

  const po = result.body?.data;
  return {
    skipped: false,
    success: true,
    purchase_order_id: po?._id,
    purchase_order_no: po?.purchase_order_no,
    line_count: stockLines.length,
    warehouse_id: String(wid),
    message: `Purchase order ${po?.purchase_order_no || ""} created with ${stockLines.length} line(s); stock added via inventory movements.`,
    data: po,
  };
}

module.exports = {
  resolveCompanyDefaultWarehouseId,
  createPurchaseOrderForImportStock,
};

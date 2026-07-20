const mongoose = require("mongoose");
const CompanyConnection = require("../models/company_connection");
const CompanyConnectionLog = require("../models/company_connection_log");
const Company = require("../models/company");
const Product = require("../models/product");
const Category = require("../models/category");
const Brand = require("../models/brands");
const WarehouseInventory = require("../models/warehouse_inventory");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
  parseSearchFieldsFromQuery,
} = require("../utils/modelHelper");

const ACTIVE_STATUSES = ["pending", "approved"];
const CONNECTION_POPULATE = [
  { path: "company_id", select: "company_name company_email company_phone company_logo status" },
  { path: "target_company_id", select: "company_name company_email company_phone company_logo status" },
  { path: "requested_by", select: "name email" },
  { path: "approved_by", select: "name email" },
];

const CONNECTION_STATUSES = ["pending", "approved", "rejected", "cancelled"];

function groupConnectionsByStatus(rows) {
  const grouped = {
    pending: [],
    approved: [],
    rejected: [],
    cancelled: [],
  };
  for (const row of rows) {
    if (grouped[row.status]) {
      grouped[row.status].push(row);
    }
  }
  return grouped;
}

/** Shape received rows with explicit sender company + status. */
function mapReceivedRequest(row) {
  return {
    _id: row._id,
    status: row.status,
    sender_company: row.company_id,
    target_company_id: row.target_company_id,
    requested_by: row.requested_by,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    remarks: row.remarks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseStatusFilter(queryStatus) {
  if (queryStatus == null || String(queryStatus).trim() === "") return null;
  const statuses = String(queryStatus)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => CONNECTION_STATUSES.includes(s));
  if (!statuses.length) return null;
  if (statuses.length === 1) return statuses[0];
  return { $in: statuses };
}

function jsonError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    status,
    error: message,
    message,
    ...extra,
  });
}

function jsonSuccess(res, status, data, message, meta = {}) {
  const body = { success: true, status, data, ...meta };
  if (message) body.message = message;
  return res.status(status).json(body);
}

function tenantCompanyId(req) {
  return coalesceObjectId(req.user?.company_id);
}

function userId(req) {
  return coalesceObjectId(req.user?._id);
}

function isValidObjectId(value) {
  const id = coalesceObjectId(value);
  return id != null && mongoose.Types.ObjectId.isValid(String(id));
}

async function appendConnectionLog({
  connection_id,
  action,
  performed_by,
  remarks,
  company_id,
}) {
  try {
    await CompanyConnectionLog.create({
      connection_id,
      action,
      performed_by,
      remarks: remarks || undefined,
      timestamp: new Date(),
      company_id: company_id || undefined,
    });
  } catch (err) {
    console.error("[big_commerce] failed to write connection log:", err?.message);
  }
}

function partyFilter(myCompanyId) {
  return {
    $or: [{ company_id: myCompanyId }, { target_company_id: myCompanyId }],
  };
}

async function findActiveConnectionBetween(a, b) {
  return CompanyConnection.findOne({
    status: { $in: ACTIVE_STATUSES },
    $or: [
      { company_id: a, target_company_id: b },
      { company_id: b, target_company_id: a },
    ],
  }).lean();
}

/**
 * POST /big-commerce/connection/request
 * Body: { target_company_id, remarks? }
 */
async function sendConnectionRequest(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const targetCompanyId = coalesceObjectId(req.body?.target_company_id);
    if (!targetCompanyId || !isValidObjectId(targetCompanyId)) {
      return jsonError(res, 400, "target_company_id is required", {
        type: "validation",
        details: [{ field: "target_company_id", message: "Valid target_company_id is required" }],
      });
    }

    if (String(myCompanyId) === String(targetCompanyId)) {
      return jsonError(res, 400, "Cannot connect your company to itself");
    }

    const target = await Company.findOne({
      _id: targetCompanyId,
      status: "active",
      ...activeNotDeletedCriteria(),
    })
      .select("_id company_name")
      .lean();

    if (!target) {
      return jsonError(res, 404, "Target company not found or inactive");
    }

    const existing = await findActiveConnectionBetween(myCompanyId, targetCompanyId);
    if (existing) {
      return jsonError(
        res,
        409,
        `An active connection already exists (status: ${existing.status})`,
        { data: existing },
      );
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim() : undefined;

    const connection = await CompanyConnection.create({
      company_id: myCompanyId,
      target_company_id: targetCompanyId,
      status: "pending",
      requested_by: userId(req),
      remarks: remarks || undefined,
    });

    await appendConnectionLog({
      connection_id: connection._id,
      action: "requested",
      performed_by: userId(req),
      remarks,
      company_id: myCompanyId,
    });

    const data = await CompanyConnection.findById(connection._id)
      .populate(CONNECTION_POPULATE)
      .lean();

    return jsonSuccess(res, 201, data, "Connection request sent");
  } catch (error) {
    if (error?.code === 11000) {
      return jsonError(res, 409, "An active connection already exists between these companies");
    }
    console.error("[big_commerce] sendConnectionRequest:", error);
    return jsonError(res, 500, error.message || "Failed to send connection request");
  }
}

/**
 * GET /big-commerce/requests/sent
 * Outgoing requests from my company, grouped by status with company details.
 */
async function listSentConnections(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const filter = { company_id: myCompanyId };
    const statusFilter = parseStatusFilter(req.query.status);
    if (statusFilter) filter.status = statusFilter;

    const rows = await CompanyConnection.find(filter)
      .populate(CONNECTION_POPULATE)
      .sort({ createdAt: -1 })
      .lean();

    return jsonSuccess(res, 200, groupConnectionsByStatus(rows), null, {
      total: rows.length,
    });
  } catch (error) {
    console.error("[big_commerce] listSentConnections:", error);
    return jsonError(res, 500, error.message || "Failed to list sent connections");
  }
}

/**
 * GET /big-commerce/requests/received
 * Incoming requests — sender company info + status (grouped by status).
 */
async function listReceivedConnections(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const filter = { target_company_id: myCompanyId };
    const statusFilter = parseStatusFilter(req.query.status);
    if (statusFilter) filter.status = statusFilter;

    const rows = await CompanyConnection.find(filter)
      .populate(CONNECTION_POPULATE)
      .sort({ createdAt: -1 })
      .lean();

    const mapped = rows.map(mapReceivedRequest);

    return jsonSuccess(res, 200, groupConnectionsByStatus(mapped), null, {
      total: mapped.length,
    });
  } catch (error) {
    console.error("[big_commerce] listReceivedConnections:", error);
    return jsonError(res, 500, error.message || "Failed to list received connections");
  }
}

/**
 * GET /big-commerce/connection/get-all
 * All connections where my company is sender or receiver
 */
async function listAllConnections(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const filter = { ...partyFilter(myCompanyId) };
    if (req.query.status) filter.status = String(req.query.status);

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.skip, 10) || 0;

    const [data, total] = await Promise.all([
      CompanyConnection.find(filter)
        .populate(CONNECTION_POPULATE)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CompanyConnection.countDocuments(filter),
    ]);

    return jsonSuccess(res, 200, data, null, { total, limit, skip });
  } catch (error) {
    console.error("[big_commerce] listAllConnections:", error);
    return jsonError(res, 500, error.message || "Failed to list connections");
  }
}

/**
 * GET /big-commerce/connection/connected
 * Approved partners only
 */
async function listConnectedCompanies(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const rows = await CompanyConnection.find({
      status: "approved",
      ...partyFilter(myCompanyId),
    })
      .populate(CONNECTION_POPULATE)
      .sort({ approved_at: -1 })
      .lean();

    const partners = rows.map((row) => {
      const isSender = String(row.company_id?._id || row.company_id) === String(myCompanyId);
      const partner = isSender ? row.target_company_id : row.company_id;
      return {
        connection_id: row._id,
        direction: isSender ? "outgoing" : "incoming",
        partner_company: partner,
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        connection: row,
      };
    });

    return jsonSuccess(res, 200, partners);
  } catch (error) {
    console.error("[big_commerce] listConnectedCompanies:", error);
    return jsonError(res, 500, error.message || "Failed to list connected companies");
  }
}

/**
 * GET /big-commerce/connection/get/:id
 */
async function getConnectionById(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const id = req.params.id;
    if (!isValidObjectId(id)) {
      return jsonError(res, 400, "Invalid connection id");
    }

    const connection = await CompanyConnection.findOne({
      _id: id,
      ...partyFilter(myCompanyId),
    })
      .populate(CONNECTION_POPULATE)
      .lean();

    if (!connection) {
      return jsonError(res, 404, "Connection not found");
    }

    return jsonSuccess(res, 200, connection);
  } catch (error) {
    console.error("[big_commerce] getConnectionById:", error);
    return jsonError(res, 500, error.message || "Failed to get connection");
  }
}

async function loadOwnedConnection(id, myCompanyId) {
  if (!isValidObjectId(id)) return { error: { status: 400, message: "Invalid connection id" } };
  const connection = await CompanyConnection.findOne({
    _id: id,
    ...partyFilter(myCompanyId),
  });
  if (!connection) {
    return { error: { status: 404, message: "Connection not found" } };
  }
  return { connection };
}

/**
 * POST /big-commerce/request/:id/approve
 * Only the receiving (target) company may approve a pending request.
 */
async function approveConnection(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const { connection, error } = await loadOwnedConnection(req.params.id, myCompanyId);
    if (error) return jsonError(res, error.status, error.message);

    if (String(connection.target_company_id) !== String(myCompanyId)) {
      return jsonError(res, 403, "Only the receiving company can approve this request");
    }
    if (connection.status !== "pending") {
      return jsonError(res, 400, `Cannot approve a connection with status: ${connection.status}`);
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim() : undefined;

    connection.status = "approved";
    connection.approved_by = userId(req);
    connection.approved_at = new Date();
    connection.rejected_at = null;
    if (remarks) connection.remarks = remarks;
    await connection.save();

    await appendConnectionLog({
      connection_id: connection._id,
      action: "approved",
      performed_by: userId(req),
      remarks,
      company_id: myCompanyId,
    });

    const row = await CompanyConnection.findById(connection._id)
      .populate(CONNECTION_POPULATE)
      .lean();

    return jsonSuccess(res, 200, mapReceivedRequest(row), "Connection approved");
  } catch (error) {
    console.error("[big_commerce] approveConnection:", error);
    return jsonError(res, 500, error.message || "Failed to approve connection");
  }
}

/**
 * POST /big-commerce/request/:id/reject
 * Only the receiving company may reject a pending request.
 * Sets status = rejected, rejected_at.
 */
async function rejectConnection(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const { connection, error } = await loadOwnedConnection(req.params.id, myCompanyId);
    if (error) return jsonError(res, error.status, error.message);

    if (String(connection.target_company_id) !== String(myCompanyId)) {
      return jsonError(res, 403, "Only the receiving company can reject this request");
    }
    if (connection.status !== "pending") {
      return jsonError(res, 400, `Cannot reject a connection with status: ${connection.status}`);
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim() : undefined;

    connection.status = "rejected";
    connection.rejected_at = new Date();
    connection.approved_by = null;
    connection.approved_at = null;
    if (remarks) connection.remarks = remarks;
    await connection.save();

    await appendConnectionLog({
      connection_id: connection._id,
      action: "rejected",
      performed_by: userId(req),
      remarks,
      company_id: myCompanyId,
    });

    const row = await CompanyConnection.findById(connection._id)
      .populate(CONNECTION_POPULATE)
      .lean();

    return jsonSuccess(res, 200, mapReceivedRequest(row), "Connection rejected");
  } catch (error) {
    console.error("[big_commerce] rejectConnection:", error);
    return jsonError(res, 500, error.message || "Failed to reject connection");
  }
}

/**
 * POST /big-commerce/request/:id/cancel
 * Only the sender can cancel a pending request.
 * Sets status = cancelled.
 */
async function cancelConnection(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const { connection, error } = await loadOwnedConnection(req.params.id, myCompanyId);
    if (error) return jsonError(res, error.status, error.message);

    const isSender = String(connection.company_id) === String(myCompanyId);

    if (connection.status !== "pending") {
      return jsonError(
        res,
        400,
        connection.status === "approved"
          ? "Use DELETE /big-commerce/request/:id to disconnect an approved connection"
          : `Cannot cancel a connection with status: ${connection.status}`,
      );
    }

    if (!isSender) {
      return jsonError(res, 403, "Only the sender can cancel a pending request");
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim() : undefined;

    connection.status = "cancelled";
    if (remarks) connection.remarks = remarks;
    await connection.save();

    await appendConnectionLog({
      connection_id: connection._id,
      action: "cancelled",
      performed_by: userId(req),
      remarks,
      company_id: myCompanyId,
    });

    const row = await CompanyConnection.findById(connection._id)
      .populate(CONNECTION_POPULATE)
      .lean();

    return jsonSuccess(res, 200, mapReceivedRequest(row), "Connection cancelled");
  } catch (error) {
    console.error("[big_commerce] cancelConnection:", error);
    return jsonError(res, 500, error.message || "Failed to cancel connection");
  }
}

/**
 * DELETE /big-commerce/request/:id
 * Disconnect approved companies (either party). Sets status = cancelled.
 */
async function disconnectConnection(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const { connection, error } = await loadOwnedConnection(req.params.id, myCompanyId);
    if (error) return jsonError(res, error.status, error.message);

    const isSender = String(connection.company_id) === String(myCompanyId);
    const isReceiver = String(connection.target_company_id) === String(myCompanyId);

    if (!isSender && !isReceiver) {
      return jsonError(res, 403, "Not allowed to disconnect this connection");
    }

    if (connection.status !== "approved") {
      return jsonError(
        res,
        400,
        connection.status === "pending"
          ? "Pending requests must be cancelled by the sender via POST /big-commerce/request/:id/cancel"
          : `Cannot disconnect a connection with status: ${connection.status}`,
      );
    }

    const remarks =
      req.body?.remarks != null ? String(req.body.remarks).trim()
      : req.query?.remarks != null ? String(req.query.remarks).trim()
      : undefined;

    connection.status = "cancelled";
    if (remarks) connection.remarks = remarks;
    await connection.save();

    await appendConnectionLog({
      connection_id: connection._id,
      action: "disconnected",
      performed_by: userId(req),
      remarks,
      company_id: myCompanyId,
    });

    const row = await CompanyConnection.findById(connection._id)
      .populate(CONNECTION_POPULATE)
      .lean();

    return jsonSuccess(res, 200, mapReceivedRequest(row), "Companies disconnected");
  } catch (error) {
    console.error("[big_commerce] disconnectConnection:", error);
    return jsonError(res, 500, error.message || "Failed to disconnect companies");
  }
}

/**
 * GET /big-commerce/connection/:id/logs
 */
async function listConnectionLogs(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Company context is required");
    }

    const { connection, error } = await loadOwnedConnection(req.params.id, myCompanyId);
    if (error) return jsonError(res, error.status, error.message);

    const logs = await CompanyConnectionLog.find({ connection_id: connection._id })
      .populate("performed_by", "name email")
      .sort({ timestamp: -1 })
      .lean();

    return jsonSuccess(res, 200, logs);
  } catch (error) {
    console.error("[big_commerce] listConnectionLogs:", error);
    return jsonError(res, 500, error.message || "Failed to list connection logs");
  }
}

/**
 * Find connection allowing myCompany to browse partnerCompany products.
 * Access only when status === "approved" (requester → target).
 */
async function findBrowseConnection(myCompanyId, partnerCompanyId) {
  return CompanyConnection.findOne({
    company_id: myCompanyId,
    target_company_id: partnerCompanyId,
  }).lean();
}

/**
 * Root company + active branches — products may be stored on either.
 */
async function resolveMarketplaceCatalogCompanyIds(rootCompanyId) {
  const rootId = coalesceObjectId(rootCompanyId);
  if (!rootId) return [];

  const ids = [rootId];
  const branches = await Company.find({
    company_id: rootId,
    status: "active",
    deletedAt: null,
  })
    .select("_id")
    .lean();

  for (const branch of branches) {
    const branchId = coalesceObjectId(branch?._id);
    if (branchId) ids.push(branchId);
  }

  // If the store id is itself a branch, also include its parent tenant catalog.
  const self = await Company.findOne({
    _id: rootId,
    status: "active",
    deletedAt: null,
  })
    .select("company_id")
    .lean();
  const parentId = coalesceObjectId(self?.company_id);
  if (parentId && !ids.some((id) => String(id) === String(parentId))) {
    ids.push(parentId);
  }

  return ids;
}

/** ObjectId + string forms for company_id queries (legacy string ids). */
function companyIdQueryValues(companyIds) {
  const values = [];
  for (const id of companyIds) {
    if (!id) continue;
    values.push(id);
    const asString = String(id);
    if (!values.some((v) => String(v) === asString)) {
      values.push(asString);
    }
  }
  return values;
}

/**
 * Shared access check for marketplace browse of another (or own) company.
 * @returns {Promise<{ ok: true, myCompanyId, partnerCompanyId, approved, access } | { ok: false, status, message }>}
 */
async function resolveMarketplaceBrowseAccess(req, companyIdParam) {
  const myCompanyId = tenantCompanyId(req);
  if (!myCompanyId) {
    return { ok: false, status: 403, message: "Forbidden" };
  }

  const partnerCompanyId = coalesceObjectId(companyIdParam);
  if (!partnerCompanyId || !isValidObjectId(partnerCompanyId)) {
    return { ok: false, status: 400, message: "Invalid company id" };
  }

  if (String(myCompanyId) === String(partnerCompanyId)) {
    return {
      ok: true,
      myCompanyId,
      partnerCompanyId,
      approved: true,
      access: "own",
      isOwn: true,
    };
  }

  const connection = await findBrowseConnection(myCompanyId, partnerCompanyId);
  const approved = connection && connection.status === "approved";

  let marketplaceListed = false;
  if (!approved) {
    const partnerCompany = await Company.findOne({
      _id: partnerCompanyId,
      status: "active",
      deletedAt: null,
    })
      .select("display_store_on_bigcommerce")
      .lean();
    marketplaceListed = Boolean(partnerCompany?.display_store_on_bigcommerce);
  }

  if (!approved && !marketplaceListed) {
    return { ok: false, status: 403, message: "Forbidden" };
  }

  return {
    ok: true,
    myCompanyId,
    partnerCompanyId,
    connection,
    approved: Boolean(approved),
    access: approved ? "read_only" : "marketplace",
    isOwn: false,
  };
}

/** Public catalog fields only — no cost/internal fields; read-only browse. */
const PARTNER_PRODUCT_SELECT = [
  "_id",
  "product_name",
  "product_code",
  "product_price",
  "wholesale_price",
  "product_description",
  "product_image",
  "product_image_thumbnail_url",
  "multi_images",
  "brand_id",
  "category_id",
  "status",
  "company_id",
  "parent_product_id",
  "createdAt",
].join(" ");

/** POS-style Big Commerce list fields (includes sku/barcode for search). */
const BIG_COMMERCE_POS_PRODUCT_SELECT = [
  "_id",
  "product_name",
  "product_code",
  "sku",
  "barcode",
  "product_price",
  "wholesale_price",
  "product_description",
  "product_image",
  "product_image_thumbnail_url",
  "multi_images",
  "brand_id",
  "category_id",
  "status",
  "product_type",
  "company_id",
  "parent_product_id",
  "createdAt",
].join(" ");

const DEFAULT_BC_POS_SEARCH_FIELDS = [
  "product_name",
  "product_code",
  "sku",
  "barcode",
];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseMinStockQuery(query = {}) {
  const raw = query.stock ?? query.min_stock ?? query.minStock;
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Product ids whose summed active warehouse qty is >= minStock (company-scoped).
 */
async function findProductIdsWithMinStock(companyIds, minStock) {
  const companyOids = (companyIds || [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  if (!companyOids.length || !(minStock > 0)) return [];

  const rows = await WarehouseInventory.aggregate([
    {
      $match: {
        company_id: { $in: companyOids },
        status: "active",
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
    },
    {
      $group: {
        _id: "$product_id",
        total_qty: { $sum: { $ifNull: ["$quantity", 0] } },
      },
    },
    { $match: { total_qty: { $gte: minStock } } },
    { $project: { _id: 1 } },
  ]);

  return rows.map((row) => row._id).filter(Boolean);
}

function applyBigCommercePosStatusFilter(filter, query = {}) {
  const includeInactive =
    query.include_inactive === "true" || query.include_inactive === "1";
  const rawStatus = String(query.status ?? "")
    .trim()
    .toLowerCase();

  if (includeInactive || rawStatus === "all") return filter;
  if (rawStatus === "inactive") {
    filter.status = "inactive";
    return filter;
  }
  filter.status = "active";
  return filter;
}

function applyBigCommercePosProductTypeFilter(filter, query = {}) {
  const raw = String(query.product_type ?? query.productType ?? "").trim();
  if (!raw) return filter;
  const lower = raw.toLowerCase();
  if (lower === "all") return filter;
  if (lower === "single") filter.product_type = "Single";
  else if (lower === "variable" || lower === "variant") filter.product_type = "Variable";
  else if (raw === "Single" || raw === "Variable") filter.product_type = raw;
  return filter;
}

/**
 * GET /big-commerce/get-all-active-ecommerce-products/:companyId
 * POS-style product list for a marketplace / connected company catalog.
 *
 * Query (same spirit as product/get-all-active-pos):
 * - search, searchFields (default product_name,product_code,sku,barcode)
 * - status (default active), category_id, brand_id, product_type
 * - stock | min_stock — minimum total warehouse qty (e.g. stock=5)
 * - limit, skip, parents_only
 */
async function getBigCommerceProductsActivePos(req, res) {
  try {
    const access = await resolveMarketplaceBrowseAccess(req, req.params.companyId);
    if (!access.ok) {
      return jsonError(res, access.status, access.message);
    }

    const { partnerCompanyId, connection, access: accessMode, isOwn } = access;
    const companyIds = await resolveMarketplaceCatalogCompanyIds(partnerCompanyId);
    const companyIdValues = companyIdQueryValues(companyIds);
    const companyOids = companyIds
      .map((id) => coalesceObjectId(id))
      .filter(Boolean);

    const filter = {
      company_id:
        companyIdValues.length === 1 ? companyIdValues[0] : { $in: companyIdValues },
      deletedAt: null,
    };

    applyBigCommercePosStatusFilter(filter, req.query || {});
    applyBigCommercePosProductTypeFilter(filter, req.query || {});

    if (req.query.parents_only === "true" || req.query.parents_only === "1") {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { parent_product_id: null },
            { parent_product_id: { $exists: false } },
          ],
        },
      ];
    }

    const rawCategory = req.query.category_id ?? req.query.categoryId;
    if (rawCategory != null && String(rawCategory).trim() !== "") {
      const categoryOid = coalesceObjectId(rawCategory);
      if (!categoryOid || !isValidObjectId(categoryOid)) {
        return jsonError(res, 400, "category_id must be a valid 24-character ObjectId");
      }
      filter.category_id = categoryOid;
    }

    const brandId = coalesceObjectId(req.query.brand_id ?? req.query.brandId);
    if (brandId) {
      filter.brand_id = brandId;
    }

    const search = req.query.search ? String(req.query.search).trim() : "";
    if (search) {
      const fields =
        parseSearchFieldsFromQuery(req.query.searchFields) ||
        DEFAULT_BC_POS_SEARCH_FIELDS;
      const regex = { $regex: escapeRegex(search), $options: "i" };
      filter.$and = [
        ...(filter.$and || []),
        { $or: fields.map((field) => ({ [field]: regex })) },
      ];
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const minStock = parseMinStockQuery(req.query || {});

    if (minStock != null && minStock > 0) {
      const stockProductIds = await findProductIdsWithMinStock(
        companyOids,
        minStock,
      );
      if (!Array.isArray(stockProductIds) || stockProductIds.length === 0) {
        return jsonSuccess(res, 200, [], null, {
          partner_company_id: partnerCompanyId,
          catalog_company_ids: companyIds.map((id) => String(id)),
          connection_id: connection?._id || null,
          access: accessMode,
          is_own: Boolean(isOwn),
          stock_min: minStock,
          total: 0,
          limit,
          skip,
        });
      }
      filter._id = { $in: stockProductIds };
    }

    const warehouseInventoryMatch = {
      status: "active",
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      company_id:
        companyOids.length === 1 ? companyOids[0] : { $in: companyOids },
    };

    const [data, total] = await Promise.all([
      Product.find(filter)
        .select(BIG_COMMERCE_POS_PRODUCT_SELECT)
        .populate("brand_id", "name")
        .populate("category_id", "name")
        .populate("parent_product_id", "product_name")
        .populate({
          path: "warehouse_inventory",
          match: warehouseInventoryMatch,
          select: "warehouse_id quantity status company_id",
          populate: {
            path: "warehouse_id",
            select: "name code",
          },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      Product.countDocuments(filter),
    ]);

    const enriched = (data || []).map((row) => {
      const inv = Array.isArray(row.warehouse_inventory)
        ? row.warehouse_inventory
        : [];
      const total_stock = inv.reduce(
        (sum, line) => sum + (Number(line?.quantity) || 0),
        0,
      );
      return { ...row, total_stock: Math.round(total_stock * 100) / 100 };
    });

    return jsonSuccess(res, 200, enriched, null, {
      partner_company_id: partnerCompanyId,
      catalog_company_ids: companyIds.map((id) => String(id)),
      connection_id: connection?._id || null,
      access: accessMode,
      is_own: Boolean(isOwn),
      stock_min: minStock,
      total,
      limit,
      skip,
    });
  } catch (error) {
    console.error("[big_commerce] getBigCommerceProductsActivePos:", error);
    return jsonError(
      res,
      500,
      error.message || "Failed to load Big Commerce products",
    );
  }
}

/**
 * GET /big-commerce/company/:companyId
 * Marketplace company profile (not tenant-scoped company/get).
 * Allowed when:
 * - viewing own company, OR
 * - connection.status === "approved", OR
 * - target has display_store_on_bigcommerce === true
 */
async function getPartnerCompany(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const partnerCompanyId = coalesceObjectId(req.params.companyId);
    if (!partnerCompanyId || !isValidObjectId(partnerCompanyId)) {
      return jsonError(res, 400, "Invalid company id");
    }

    const company = await Company.findOne({
      _id: partnerCompanyId,
      status: "active",
      deletedAt: null,
    }).lean();

    if (!company) {
      return jsonError(res, 404, "Company not found");
    }

    const isOwn = String(myCompanyId) === String(partnerCompanyId);
    if (!isOwn) {
      const connection = await findBrowseConnection(myCompanyId, partnerCompanyId);
      const approved = connection && connection.status === "approved";
      const marketplaceListed = Boolean(company.display_store_on_bigcommerce);
      if (!approved && !marketplaceListed) {
        return jsonError(res, 403, "Forbidden");
      }
    }

    return jsonSuccess(res, 200, company);
  } catch (error) {
    console.error("[big_commerce] getPartnerCompany:", error);
    return jsonError(res, 500, error.message || "Failed to load company");
  }
}

/**
 * GET /big-commerce/products/:companyId
 * Browse another company's active products when:
 * - connection.status === "approved", OR
 * - target company has display_store_on_bigcommerce === true (public marketplace store)
 * Own-company catalog: use product/get-all-active-pos instead.
 */
async function getPartnerProducts(req, res) {
  try {
    const access = await resolveMarketplaceBrowseAccess(req, req.params.companyId);
    if (!access.ok) {
      return jsonError(res, access.status, access.message);
    }

    if (access.isOwn) {
      return jsonError(res, 400, "Use product endpoints to list your own catalog");
    }

    const { partnerCompanyId, connection, approved, access: accessMode } = access;

    // Include branch companies so catalog isn't limited to the root row only.
    const companyIds = await resolveMarketplaceCatalogCompanyIds(partnerCompanyId);
    const companyIdValues = companyIdQueryValues(companyIds);

    // Same baseline as `product/get-all-active-pos` (no parent-only filter).
    const filter = {
      company_id:
        companyIdValues.length === 1 ? companyIdValues[0] : { $in: companyIdValues },
      status: "active",
      deletedAt: null,
    };

    // Opt-in: parents only (POS-style parent list).
    if (req.query.parents_only === "true" || req.query.parents_only === "1") {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { parent_product_id: null },
            { parent_product_id: { $exists: false } },
          ],
        },
      ];
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.skip, 10) || 0;
    const search = req.query.search ? String(req.query.search).trim() : "";

    if (search) {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { product_name: { $regex: search, $options: "i" } },
            { product_code: { $regex: search, $options: "i" } },
          ],
        },
      ];
    }

    const categoryId = coalesceObjectId(
      req.query.category_id ?? req.query.categoryId,
    );
    if (categoryId) {
      filter.category_id = categoryId;
    }

    const brandId = coalesceObjectId(req.query.brand_id ?? req.query.brandId);
    if (brandId) {
      filter.brand_id = brandId;
    }

    const [data, total] = await Promise.all([
      Product.find(filter)
        .select(PARTNER_PRODUCT_SELECT)
        .populate("brand_id", "name")
        .populate("category_id", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return jsonSuccess(res, 200, data, null, {
      partner_company_id: partnerCompanyId,
      catalog_company_ids: companyIds.map((id) => String(id)),
      connection_id: connection?._id || null,
      access: accessMode,
      total,
      limit,
      skip,
    });
  } catch (error) {
    console.error("[big_commerce] getPartnerProducts:", error);
    return jsonError(res, 500, error.message || "Failed to load partner products");
  }
}

/**
 * GET /big-commerce/categories/:companyId
 * Categories belonging to the store company (not the viewer tenant).
 */
async function getPartnerCategories(req, res) {
  try {
    const access = await resolveMarketplaceBrowseAccess(req, req.params.companyId);
    if (!access.ok) {
      return jsonError(res, access.status, access.message);
    }

    const companyIds = await resolveMarketplaceCatalogCompanyIds(access.partnerCompanyId);
    const companyIdValues = companyIdQueryValues(companyIds);
    const filter = {
      company_id:
        companyIdValues.length === 1 ? companyIdValues[0] : { $in: companyIdValues },
      status: "active",
      deletedAt: null,
    };

    const data = await Category.find(filter)
      .select("_id name slug description image icon color sort_order parent_id company_id isActive status")
      .sort({ sort_order: 1, name: 1 })
      .lean();

    return jsonSuccess(res, 200, data, null, {
      partner_company_id: access.partnerCompanyId,
      total: data.length,
      access: access.access,
    });
  } catch (error) {
    console.error("[big_commerce] getPartnerCategories:", error);
    return jsonError(res, 500, error.message || "Failed to load categories");
  }
}

/**
 * GET /big-commerce/brands/:companyId
 * Brands belonging to the store company (not the viewer tenant).
 */
async function getPartnerBrands(req, res) {
  try {
    const access = await resolveMarketplaceBrowseAccess(req, req.params.companyId);
    if (!access.ok) {
      return jsonError(res, access.status, access.message);
    }

    const companyIds = await resolveMarketplaceCatalogCompanyIds(access.partnerCompanyId);
    const companyIdValues = companyIdQueryValues(companyIds);
    const filter = {
      company_id:
        companyIdValues.length === 1 ? companyIdValues[0] : { $in: companyIdValues },
      status: "active",
      deletedAt: null,
    };

    const data = await Brand.find(filter)
      .select("_id name slug description image parent_id company_id status")
      .sort({ name: 1 })
      .lean();

    return jsonSuccess(res, 200, data, null, {
      partner_company_id: access.partnerCompanyId,
      total: data.length,
      access: access.access,
    });
  } catch (error) {
    console.error("[big_commerce] getPartnerBrands:", error);
    return jsonError(res, 500, error.message || "Failed to load brands");
  }
}

module.exports = {
  sendConnectionRequest,
  listSentConnections,
  listReceivedConnections,
  listAllConnections,
  listConnectedCompanies,
  getConnectionById,
  approveConnection,
  rejectConnection,
  cancelConnection,
  disconnectConnection,
  listConnectionLogs,
  getPartnerCompany,
  getPartnerProducts,
  getBigCommerceProductsActivePos,
  getPartnerCategories,
  getPartnerBrands,
};

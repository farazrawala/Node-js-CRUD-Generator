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
  { path: "company_id", select: "company_name company_slug company_email company_phone company_logo company_banner status" },
  { path: "target_company_id", select: "company_name company_slug company_email company_phone company_logo company_banner status" },
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
 * Resolve marketplace `:companyId` as ObjectId or `company_slug`.
 */
async function resolveMarketplaceCompanyId(companyIdParam) {
  const raw = String(companyIdParam ?? "").trim();
  if (!raw) return null;

  if (isValidObjectId(raw)) {
    const oid = coalesceObjectId(raw);
    if (oid) return oid;
  }

  const company = await Company.findOne({
    company_slug: raw,
    deletedAt: null,
  })
    .select("_id")
    .lean();
  return coalesceObjectId(company?._id) || null;
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

  const partnerCompanyId = await resolveMarketplaceCompanyId(companyIdParam);
  if (!partnerCompanyId) {
    return { ok: false, status: 404, message: "Company not found" };
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
  "show_on_bigcommerce",
  "bigcommerce_price",
  "bigcommerce_hold_qty",
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

/** Default threshold: in_stock > N, low_stock is 0 < qty < N. */
const DEFAULT_STOCK_THRESHOLD = 10;

/**
 * Parse stock filter from query.
 *
 * Preferred:
 * - stock_status=in_stock|low_stock|out_of_stock
 * - stock_threshold=10 (optional; default 10)
 *
 * Legacy:
 * - stock / min_stock = N  → total_qty >= N (same as in_stock with gte)
 *
 * @returns {{ mode: string, threshold: number, min?: number|null, max?: number|null } | null}
 */
function parseStockFilterQuery(query = {}) {
  const thresholdRaw =
    query.stock_threshold ?? query.stockThreshold ?? query.threshold;
  let threshold = DEFAULT_STOCK_THRESHOLD;
  if (thresholdRaw != null && String(thresholdRaw).trim() !== "") {
    const n = Number(String(thresholdRaw).trim());
    if (Number.isFinite(n) && n >= 0) threshold = n;
  }

  const statusRaw = String(
    query.stock_status ?? query.stockStatus ?? query.stock_filter ?? "",
  )
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (
    statusRaw === "in_stock" ||
    statusRaw === "instock" ||
    statusRaw === "in"
  ) {
    // in stock: qty > threshold (e.g. > 10)
    return { mode: "in_stock", threshold, min: threshold, exclusiveMin: true };
  }
  if (
    statusRaw === "low_stock" ||
    statusRaw === "lowstock" ||
    statusRaw === "low"
  ) {
    // low stock: 0 < qty < threshold (e.g. < 10 and > 0)
    return {
      mode: "low_stock",
      threshold,
      min: 0,
      exclusiveMin: true,
      max: threshold,
      exclusiveMax: true,
    };
  }
  if (
    statusRaw === "out_of_stock" ||
    statusRaw === "outofstock" ||
    statusRaw === "out" ||
    statusRaw === "oos"
  ) {
    // out of stock: qty == 0 (or missing inventory)
    return { mode: "out_of_stock", threshold, max: 0 };
  }

  // Legacy: stock=5 / min_stock=5 → qty >= 5
  const legacy = query.stock ?? query.min_stock ?? query.minStock;
  if (legacy != null && String(legacy).trim() !== "") {
    const legacyStatus = String(legacy).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (
      ["in_stock", "instock", "in", "low_stock", "lowstock", "low", "out_of_stock", "outofstock", "out", "oos"].includes(
        legacyStatus,
      )
    ) {
      return parseStockFilterQuery({
        ...query,
        stock_status: legacyStatus,
        stock: undefined,
        min_stock: undefined,
        minStock: undefined,
      });
    }
    const n = Number(String(legacy).trim());
    if (Number.isFinite(n) && n >= 0) {
      return { mode: "min_stock", threshold: n, min: n };
    }
  }

  return null;
}

/**
 * Aggregate active warehouse qty by product for a company set.
 * @returns {Promise<Array<{ _id: import("mongoose").Types.ObjectId, total_qty: number }>>}
 */
async function aggregateProductStockTotals(companyIds) {
  const companyOids = (companyIds || [])
    .map((id) => coalesceObjectId(id))
    .filter(Boolean);
  if (!companyOids.length) return [];

  return WarehouseInventory.aggregate([
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
  ]);
}

/**
 * Resolve product id constraint for a stock filter.
 * @returns {Promise<null | { ids: any[], match?: object }>}
 * - `{ ids }` → apply `_id: { $in: ids }`
 * - `{ match }` → apply custom `$and` clause (out_of_stock with missing inventory)
 */
async function resolveStockFilterConstraint(companyIds, stockFilter) {
  if (!stockFilter) return null;

  const totals = await aggregateProductStockTotals(companyIds);
  const inventoryIds = [];
  const matched = [];

  for (const row of totals) {
    if (!row?._id) continue;
    inventoryIds.push(row._id);
    const qty = Number(row.total_qty) || 0;

    if (stockFilter.mode === "in_stock") {
      if (qty > stockFilter.threshold) matched.push(row._id);
    } else if (stockFilter.mode === "low_stock") {
      if (qty > 0 && qty < stockFilter.threshold) matched.push(row._id);
    } else if (stockFilter.mode === "out_of_stock") {
      if (qty <= 0) matched.push(row._id);
    } else if (stockFilter.mode === "min_stock") {
      if (qty >= stockFilter.min) matched.push(row._id);
    }
  }

  if (stockFilter.mode === "out_of_stock") {
    // qty == 0 rows OR products with no warehouse_inventory at all
    if (!inventoryIds.length) {
      // No inventory rows in company → every product is out of stock (no id constraint)
      return { ids: null, match: null, empty: false };
    }
    return {
      ids: null,
      match: {
        $or: [
          ...(matched.length ? [{ _id: { $in: matched } }] : []),
          { _id: { $nin: inventoryIds } },
        ],
      },
      empty: false,
    };
  }

  return { ids: matched, match: null, empty: matched.length === 0 };
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
 * - stock_status=in_stock|low_stock|out_of_stock
 * - stock_threshold=10 (default 10; in_stock = qty > N, low_stock = 0 < qty < N)
 * - stock | min_stock = N (legacy: qty >= N)
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
      show_on_bigcommerce: true,
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
    const stockFilter = parseStockFilterQuery(req.query || {});

    if (stockFilter) {
      const stockConstraint = await resolveStockFilterConstraint(
        companyOids,
        stockFilter,
      );
      if (stockConstraint?.empty) {
        return jsonSuccess(res, 200, [], null, {
          partner_company_id: partnerCompanyId,
          catalog_company_ids: companyIds.map((id) => String(id)),
          connection_id: connection?._id || null,
          access: accessMode,
          is_own: Boolean(isOwn),
          stock_status: stockFilter.mode,
          stock_threshold: stockFilter.threshold,
          total: 0,
          limit,
          skip,
        });
      }
      if (stockConstraint?.match) {
        filter.$and = [...(filter.$and || []), stockConstraint.match];
      } else if (Array.isArray(stockConstraint?.ids)) {
        filter._id = { $in: stockConstraint.ids };
      }
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
      stock_status: stockFilter?.mode ?? null,
      stock_threshold: stockFilter?.threshold ?? null,
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

    const partnerCompanyId = await resolveMarketplaceCompanyId(req.params.companyId);
    if (!partnerCompanyId) {
      return jsonError(res, 404, "Company not found");
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

/** Fields copied when fetching a partner product into the caller's catalog. */
const FETCH_PRODUCT_COPY_FIELDS = [
  "product_name",
  "product_code",
  "alert_qty",
  "unit",
  "weight",
  "length",
  "width",
  "height",
  "dimension",
  "price_before_tax",
  "tax_rate",
  "sku",
  "barcode",
  "product_type",
  "product_slug",
  "wholesale_price",
  "product_price",
  "product_description",
  "product_image",
  "product_image_thumbnail_url",
  "multi_images",
  "multi_image_thumbnails",
  "status",
];

/**
 * Build a new product document payload for company `targetCompanyId`
 * sourced from a partner product.
 */
function buildFetchedProductPayload(source, {
  targetCompanyId,
  createdBy,
  parentProductId = null,
}) {
  const payload = {
    company_id: targetCompanyId,
    fetch_from_product_id: source._id,
    fetch_from_company_id: source.company_id,
    parent_product_id: parentProductId,
    brand_id: null,
    category_id: [],
    product_relations: [],
    created_by: createdBy || null,
    updated_by: createdBy || null,
    deletedAt: null,
  };

  for (const field of FETCH_PRODUCT_COPY_FIELDS) {
    if (source[field] !== undefined) {
      payload[field] = source[field];
    }
  }

  // Fetching a variant alone becomes a standalone product under the new company.
  if (!parentProductId && source.parent_product_id) {
    payload.parent_product_id = null;
    if (!payload.product_type) payload.product_type = "Single";
  }

  return payload;
}

/**
 * POST /big-commerce/products/:productId/duplicate
 * POST /big-commerce/products/fetch/:productId
 *
 * Company B duplicates Company A's product into B's catalog:
 * - new row with company_id = B
 * - fetch_from_product_id = A's product _id
 * - fetch_from_company_id = A's company_id
 *
 * Variable parents also copy active variants.
 * Access: same as marketplace browse (approved connection OR marketplace store).
 * Idempotent: if already fetched, returns the existing copy.
 */
async function duplicatePartnerProduct(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const productId = coalesceObjectId(
      req.params.productId ?? req.body?.product_id ?? req.body?.productId,
    );
    if (!productId || !isValidObjectId(productId)) {
      return jsonError(res, 400, "Invalid product id");
    }

    const source = await Product.findOne({
      _id: productId,
      status: "active",
      deletedAt: null,
    }).lean();

    if (!source) {
      return jsonError(res, 404, "Product not found");
    }

    const sourceCompanyId = coalesceObjectId(source.company_id);
    if (!sourceCompanyId) {
      return jsonError(res, 400, "Source product has no company");
    }

    if (String(sourceCompanyId) === String(myCompanyId)) {
      return jsonError(res, 400, "Cannot fetch your own product");
    }

    const access = await resolveMarketplaceBrowseAccess(req, sourceCompanyId);
    if (!access.ok) {
      return jsonError(res, access.status, access.message);
    }
    if (access.isOwn) {
      return jsonError(res, 400, "Cannot fetch your own product");
    }

    // Ensure the product sits in the partner's catalog tree (root + branches).
    const catalogCompanyIds = await resolveMarketplaceCatalogCompanyIds(
      access.partnerCompanyId,
    );
    const inCatalog = catalogCompanyIds.some(
      (id) => String(id) === String(sourceCompanyId),
    );
    if (!inCatalog) {
      return jsonError(res, 403, "Product is not in the partner catalog");
    }

    const existing = await Product.findOne({
      company_id: myCompanyId,
      fetch_from_product_id: source._id,
      deletedAt: null,
    }).lean();

    if (existing) {
      return jsonSuccess(
        res,
        200,
        existing,
        "Product already fetched into your catalog",
        {
          already_fetched: true,
          fetch_from_product_id: source._id,
          fetch_from_company_id: sourceCompanyId,
        },
      );
    }

    const createdBy = userId(req);
    const parentPayload = buildFetchedProductPayload(source, {
      targetCompanyId: myCompanyId,
      createdBy,
      parentProductId: null,
    });

    const createdParent = await Product.create(parentPayload);

    const variants = await Product.find({
      parent_product_id: source._id,
      status: "active",
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean();

    const createdVariants = [];
    for (const variant of variants) {
      const alreadyVariant = await Product.findOne({
        company_id: myCompanyId,
        fetch_from_product_id: variant._id,
        deletedAt: null,
      }).lean();

      if (alreadyVariant) {
        createdVariants.push(alreadyVariant);
        continue;
      }

      const variantPayload = buildFetchedProductPayload(variant, {
        targetCompanyId: myCompanyId,
        createdBy,
        parentProductId: createdParent._id,
      });
      const createdVariant = await Product.create(variantPayload);
      createdVariants.push(createdVariant.toObject());
    }

    return jsonSuccess(
      res,
      201,
      {
        ...createdParent.toObject(),
        variants: createdVariants,
      },
      "Product fetched into your catalog",
      {
        already_fetched: false,
        fetch_from_product_id: source._id,
        fetch_from_company_id: sourceCompanyId,
        variants_count: createdVariants.length,
      },
    );
  } catch (error) {
    console.error("[big_commerce] duplicatePartnerProduct:", error);
    if (error?.code === 11000) {
      return jsonError(
        res,
        409,
        "A product with the same SKU or barcode already exists in your catalog",
      );
    }
    return jsonError(
      res,
      500,
      error.message || "Failed to duplicate partner product",
    );
  }
}

/**
 * GET /big-commerce/fetched-product-ids/:companyId
 *
 * Lightweight me-too map while browsing a partner store.
 * Returns only your copy id + the partner product id you fetched from:
 *   [{ product_id, fetch_from_product_id }, ...]
 *
 * product_id            → your catalog product _id
 * fetch_from_product_id → partner store product _id
 */
async function getFetchedProductIds(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const sourceCompanyId = await resolveMarketplaceCompanyId(req.params.companyId);
    if (!sourceCompanyId) {
      return jsonError(res, 404, "Company not found");
    }
    if (String(sourceCompanyId) === String(myCompanyId)) {
      return jsonError(
        res,
        400,
        "Use product endpoints to list your own catalog",
      );
    }

    const catalogCompanyIds = await resolveMarketplaceCatalogCompanyIds(
      sourceCompanyId,
    );
    const sourceValues = companyIdQueryValues(catalogCompanyIds);

    // Partner product ids in this store catalog (covers rows missing fetch_from_company_id).
    const partnerProductIds = await Product.find({
      company_id:
        sourceValues.length === 1 ? sourceValues[0] : { $in: sourceValues },
      deletedAt: null,
    }).distinct("_id");

    const rows = await Product.find({
      company_id: myCompanyId,
      deletedAt: null,
      fetch_from_product_id: { $exists: true, $ne: null },
      $or: [
        {
          fetch_from_company_id:
            sourceValues.length === 1 ? sourceValues[0] : { $in: sourceValues },
        },
        ...(partnerProductIds.length
          ? [{ fetch_from_product_id: { $in: partnerProductIds } }]
          : []),
      ],
    })
      .select("_id fetch_from_product_id")
      .lean();

    const data = rows.map((row) => ({
      product_id: String(row._id),
      fetch_from_product_id: row.fetch_from_product_id
        ? String(row.fetch_from_product_id)
        : null,
    }));

    return jsonSuccess(res, 200, data, null, {
      total: data.length,
      fetch_from_company_id: sourceCompanyId,
      catalog_company_ids: catalogCompanyIds.map((id) => String(id)),
    });
  } catch (error) {
    console.error("[big_commerce] getFetchedProductIds:", error);
    return jsonError(
      res,
      500,
      error.message || "Failed to load fetched product ids",
    );
  }
}

/**
 * GET /big-commerce/fetched-products
 * GET /big-commerce/fetched-products/:companyId
 *
 * Company 2 browsing Company 1's store → list of products Company 2 already
 * added from Company 1 (own catalog rows where fetch_from_company_id matches).
 *
 * Query:
 * - fetch_from_company_id (optional; ignored if :companyId is in path)
 * - search, status (default active), product_type, parents_only
 * - limit, skip
 */
async function getFetchedProducts(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const filter = {
      company_id: myCompanyId,
      fetch_from_company_id: { $exists: true, $ne: null },
      deletedAt: null,
    };

    // Prefer path param when browsing a specific partner store.
    const pathCompanyId = await resolveMarketplaceCompanyId(req.params.companyId);
    const queryCompanyId = await resolveMarketplaceCompanyId(
      req.query.fetch_from_company_id ?? req.query.fetchFromCompanyId,
    );
    const sourceCompanyId = pathCompanyId || queryCompanyId;

    let sourceCompanyIds = null;
    if (sourceCompanyId) {
      if (String(sourceCompanyId) === String(myCompanyId)) {
        return jsonError(
          res,
          400,
          "Use product endpoints to list your own catalog",
        );
      }

      // Include partner root + branches (same catalog tree used when browsing).
      sourceCompanyIds = await resolveMarketplaceCatalogCompanyIds(
        sourceCompanyId,
      );
      const sourceValues = companyIdQueryValues(sourceCompanyIds);
      filter.fetch_from_company_id =
        sourceValues.length === 1 ? sourceValues[0] : { $in: sourceValues };
    }

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

    const selectFields = [
      BIG_COMMERCE_POS_PRODUCT_SELECT,
      "fetch_from_product_id",
      "fetch_from_company_id",
    ].join(" ");

    const [data, total] = await Promise.all([
      Product.find(filter)
        .select(selectFields)
        .populate("brand_id", "name")
        .populate("category_id", "name")
        .populate("parent_product_id", "product_name")
        .populate(
          "fetch_from_product_id",
          "product_name product_code sku product_image company_id",
        )
        .populate(
          "fetch_from_company_id",
          "company_name company_email company_logo company_banner",
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(filter),
    ]);

    return jsonSuccess(res, 200, data, null, {
      total,
      limit,
      skip,
      fetch_from_company_id: sourceCompanyId || null,
      catalog_company_ids: sourceCompanyIds
        ? sourceCompanyIds.map((id) => String(id))
        : null,
    });
  } catch (error) {
    console.error("[big_commerce] getFetchedProducts:", error);
    return jsonError(
      res,
      500,
      error.message || "Failed to load fetched products",
    );
  }
}

/**
 * DELETE /big-commerce/fetched-products/:productId
 * Soft-delete a product you previously fetched from a partner store.
 * Matches the same fetched rows as GET fetched-product-ids (copy must have
 * fetch_from_company_id and/or fetch_from_product_id).
 * Variable parents also soft-delete their active child variants.
 */
async function softDeleteFetchedProduct(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const productId = coalesceObjectId(req.params.productId);
    if (!productId || !isValidObjectId(productId)) {
      return jsonError(res, 400, "Invalid product id");
    }

    // Same “fetched copy” rules as getFetchedProductIds — some older rows only
    // have fetch_from_product_id (no fetch_from_company_id).
    const product = await Product.findOne({
      _id: productId,
      company_id: myCompanyId,
      deletedAt: null,
      $or: [
        { fetch_from_company_id: { $exists: true, $ne: null } },
        { fetch_from_product_id: { $exists: true, $ne: null } },
      ],
    });

    if (!product) {
      return jsonError(
        res,
        404,
        "Fetched product not found in your catalog",
      );
    }

    const now = new Date();
    const softDeleteSet = {
      deletedAt: now,
      status: "inactive",
      updated_by: userId(req) || null,
    };

    await Product.updateOne({ _id: product._id }, { $set: softDeleteSet });

    const variantResult = await Product.updateMany(
      {
        parent_product_id: product._id,
        company_id: myCompanyId,
        deletedAt: null,
      },
      { $set: softDeleteSet },
    );

    return jsonSuccess(
      res,
      200,
      {
        _id: product._id,
        deletedAt: now,
        status: "inactive",
        variants_deleted: variantResult.modifiedCount || 0,
      },
      "Fetched product soft deleted",
    );
  } catch (error) {
    console.error("[big_commerce] softDeleteFetchedProduct:", error);
    return jsonError(
      res,
      500,
      error.message || "Failed to soft delete fetched product",
    );
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
  duplicatePartnerProduct,
  getFetchedProductIds,
  getFetchedProducts,
  softDeleteFetchedProduct,
};

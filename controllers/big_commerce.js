const mongoose = require("mongoose");
const CompanyConnection = require("../models/company_connection");
const CompanyConnectionLog = require("../models/company_connection_log");
const Company = require("../models/company");
const Product = require("../models/product");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
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

/**
 * GET /big-commerce/products/:companyId
 * Browse another company's active products when:
 * - connection.status === "approved", OR
 * - target company has display_store_on_bigcommerce === true (public marketplace store)
 * Own-company catalog: use product/get-all-active-pos instead.
 */
async function getPartnerProducts(req, res) {
  try {
    const myCompanyId = tenantCompanyId(req);
    if (!myCompanyId) {
      return jsonError(res, 403, "Forbidden");
    }

    const partnerCompanyId = coalesceObjectId(req.params.companyId);
    if (!partnerCompanyId || !isValidObjectId(partnerCompanyId)) {
      return jsonError(res, 400, "Invalid partner company id");
    }

    if (String(myCompanyId) === String(partnerCompanyId)) {
      return jsonError(res, 400, "Use product endpoints to list your own catalog");
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
      return jsonError(res, 403, "Forbidden");
    }

    const filter = {
      company_id: partnerCompanyId,
      status: "active",
      ...activeNotDeletedCriteria(),
    };

    if (req.query.include_variations !== "true") {
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
      connection_id: connection?._id || null,
      access: approved ? "read_only" : "marketplace",
      total,
      limit,
      skip,
    });
  } catch (error) {
    console.error("[big_commerce] getPartnerProducts:", error);
    return jsonError(res, 500, error.message || "Failed to load partner products");
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
  getPartnerProducts,
};

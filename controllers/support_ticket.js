const mongoose = require("mongoose");
const SupportTicket = require("../models/support_ticket");
const SupportMessage = require("../models/support_message");
const SupportAttachment = require("../models/support_attachment");
const SupportTicketRead = require("../models/support_ticket_read");
const SupportTicketCounter = require("../models/support_ticket_counter");
const {
  CATEGORY_VALUES,
  PRIORITY_VALUES,
  STATUS_VALUES,
} = require("../models/support_ticket");
const {
  runWithOptionalMongoTransaction,
} = require("../utils/mongoTransactionSupport");
const {
  saveTicketFiles,
  safeUnlinkAttachment,
} = require("../utils/supportTicketUploads");
const { coalesceObjectId } = require("../utils/modelHelper");

// ─── Helpers ──────────────────────────────────────────────────────────

function resolveTenantCompanyId(req) {
  const raw = req.user?.company_id;
  if (!raw) return null;
  return coalesceObjectId(raw?._id || raw);
}

function isAdmin(req) {
  const roles = req.user?.role;
  return Array.isArray(roles) && roles.includes("ADMIN");
}

function userId(req) {
  return coalesceObjectId(req.user?._id);
}

const USER_SELECT = "name email";

function oid(val) {
  if (!val) return null;
  const id = coalesceObjectId(val);
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

function errRes(res, status, message) {
  return res.status(status).json({ success: false, status, message });
}

// ─── 1) GET /support-ticket/get-all ───────────────────────────────────

async function getAll(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const admin = isAdmin(req);
    const scope = req.query.scope || "user";
    if (scope === "admin" && !admin) {
      return errRes(res, 403, "Admin scope requires ADMIN role");
    }

    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 10),
    );

    const filter = { company_id: companyId, deletedAt: null };

    if (scope === "user") {
      filter.created_by = userId(req);
    }

    if (req.query.status) filter.status = req.query.status;
    if (req.query.priority) filter.priority = req.query.priority;
    if (req.query.category) filter.category = req.query.category;

    if (req.query.assigned_to) {
      if (req.query.assigned_to === "unassigned") {
        filter.assigned_to = null;
      } else {
        const aId = oid(req.query.assigned_to);
        if (aId) filter.assigned_to = aId;
      }
    }

    if (req.query.date_from || req.query.date_to) {
      filter.createdAt = {};
      if (req.query.date_from)
        filter.createdAt.$gte = new Date(req.query.date_from);
      if (req.query.date_to)
        filter.createdAt.$lte = new Date(req.query.date_to);
    }

    // Search by subject, ticket_number, or user name/email
    let userIdsBySearch = null;
    if (req.query.search) {
      const s = req.query.search.trim();
      const regex = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      const User = require("../models/user");
      const matchedUsers = await User.find(
        {
          company_id: companyId,
          $or: [{ name: regex }, { email: regex }],
        },
        "_id",
      ).lean();
      userIdsBySearch = matchedUsers.map((u) => u._id);

      filter.$or = [
        { subject: regex },
        { ticket_number: regex },
        ...(userIdsBySearch.length > 0
          ? [{ created_by: { $in: userIdsBySearch } }]
          : []),
      ];
    }

    const sortBy = req.query.sortBy || "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    const sort = { [sortBy]: sortOrder };

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("user", USER_SELECT)
        .populate("created_by", USER_SELECT)
        .populate("assigned_to", USER_SELECT)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);

    // Compute unread_count per ticket for the current viewer
    const viewerId = userId(req);
    const ticketIds = tickets.map((t) => t._id);

    const readStates = await SupportTicketRead.find({
      ticket_id: { $in: ticketIds },
      user_id: viewerId,
    }).lean();

    const readMap = {};
    for (const r of readStates) {
      readMap[String(r.ticket_id)] = r.last_read_at;
    }

    // Count unread messages per ticket
    const unreadPipeline = [
      {
        $match: {
          ticket_id: { $in: ticketIds },
          deletedAt: null,
          ...(admin ? {} : { is_internal: { $ne: true } }),
        },
      },
      { $group: { _id: "$ticket_id", msgs: { $push: "$createdAt" } } },
    ];
    const unreadAgg = await SupportMessage.aggregate(unreadPipeline);
    const unreadMap = {};
    for (const row of unreadAgg) {
      const lastRead = readMap[String(row._id)];
      if (!lastRead) {
        unreadMap[String(row._id)] = row.msgs.length;
      } else {
        unreadMap[String(row._id)] = row.msgs.filter(
          (d) => d > lastRead,
        ).length;
      }
    }

    const data = tickets.map((t) => ({
      ...t,
      unread_count: unreadMap[String(t._id)] || 0,
    }));

    return res.status(200).json({
      success: true,
      status: 200,
      data,
      pagination: { skip, limit, total },
    });
  } catch (error) {
    console.error("❌ support_ticket getAll:", error);
    return errRes(res, 500, error.message || "Failed to list support tickets");
  }
}

// ─── 2) GET /support-ticket/get/:id ──────────────────────────────────

async function getById(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const ticketId = oid(req.params.id);
    if (!ticketId) return errRes(res, 400, "Valid ticket id is required");

    const admin = isAdmin(req);
    const scope = req.query.scope || "user";
    if (scope === "admin" && !admin) {
      return errRes(res, 403, "Admin scope requires ADMIN role");
    }

    const ticketFilter = {
      _id: ticketId,
      company_id: companyId,
      deletedAt: null,
    };
    if (!admin) {
      ticketFilter.created_by = userId(req);
    }

    const ticket = await SupportTicket.findOne(ticketFilter)
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    if (!ticket) return errRes(res, 404, "Ticket not found");

    // Message pagination
    const msgLimit = Math.min(
      200,
      Math.max(1, parseInt(req.query.limit, 10) || 50),
    );
    const msgFilter = {
      ticket_id: ticketId,
      deletedAt: null,
    };
    if (!admin) {
      msgFilter.is_internal = { $ne: true };
    }

    if (req.query.before) {
      const beforeOid = oid(req.query.before);
      if (beforeOid) {
        msgFilter._id = { $lt: beforeOid };
      } else {
        const d = new Date(req.query.before);
        if (!isNaN(d.getTime())) {
          msgFilter.createdAt = { $lt: d };
        }
      }
    }

    // Fetch limit+1 to detect has_more_messages
    const rawMessages = await SupportMessage.find(msgFilter)
      .sort({ createdAt: -1 })
      .limit(msgLimit + 1)
      .populate("user", USER_SELECT)
      .lean();

    const has_more_messages = rawMessages.length > msgLimit;
    const messages = rawMessages.slice(0, msgLimit).reverse();

    // Mark as read
    const viewerId = userId(req);
    await SupportTicketRead.findOneAndUpdate(
      { ticket_id: ticketId, user_id: viewerId },
      { $set: { last_read_at: new Date() } },
      { upsert: true },
    );

    return res.status(200).json({
      success: true,
      status: 200,
      data: {
        ...ticket,
        has_more_messages,
        messages,
      },
    });
  } catch (error) {
    console.error("❌ support_ticket getById:", error);
    return errRes(res, 500, error.message || "Failed to get support ticket");
  }
}

// ─── 3) POST /support-ticket/create ──────────────────────────────────

async function generateTicketNumber(companyId, session) {
  const opts = session ? { session } : {};
  const counter = await SupportTicketCounter.findOneAndUpdate(
    { company_id: companyId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, ...opts },
  );
  return `TCK-${String(counter.seq).padStart(6, "0")}`;
}

async function create(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const { subject, category, priority } = req.body;
    const description = req.body.description || req.body.message;

    if (!subject) return errRes(res, 400, "subject is required");
    if (!category || !CATEGORY_VALUES.includes(category)) {
      return errRes(
        res,
        400,
        `category is required and must be one of: ${CATEGORY_VALUES.join(", ")}`,
      );
    }
    if (priority && !PRIORITY_VALUES.includes(priority)) {
      return errRes(
        res,
        400,
        `priority must be one of: ${PRIORITY_VALUES.join(", ")}`,
      );
    }
    if (!description) {
      return errRes(res, 400, "description or message is required");
    }

    let ticket = null;
    let firstMessage = null;
    let attachmentMeta = [];

    await runWithOptionalMongoTransaction(
      async (session) => {
        const ticketNumber = await generateTicketNumber(companyId, session);

        const ticketDocs = await SupportTicket.create(
          [
            {
              ticket_number: ticketNumber,
              subject,
              description,
              category,
              priority: priority || "medium",
              status: "open",
              user: userId(req),
              created_by: userId(req),
              company_id: companyId,
              last_reply_at: new Date(),
              last_reply_by: userId(req),
            },
          ],
          { session },
        );
        ticket = ticketDocs[0];

        // Save attachments if present
        if (req.files?.attachments) {
          attachmentMeta = await saveTicketFiles(req.files.attachments, {
            companyId: String(companyId),
            ticketId: String(ticket._id),
            uploadedBy: String(userId(req)),
            req,
          });
        }

        const msgDocs = await SupportMessage.create(
          [
            {
              ticket_id: ticket._id,
              user: userId(req),
              // Creating a ticket is always a customer/requester action, even
              // when that user also holds an ADMIN permission.
              role: "user",
              message: description,
              is_internal: false,
              attachments: attachmentMeta,
              company_id: companyId,
            },
          ],
          { session },
        );
        firstMessage = msgDocs[0];

        // Save attachment records
        if (attachmentMeta.length > 0) {
          const attachDocs = attachmentMeta.map((a) => ({
            ...a,
            ticket_id: ticket._id,
            message_id: firstMessage._id,
            uploaded_by: userId(req),
            company_id: companyId,
          }));
          await SupportAttachment.create(attachDocs, { session });
        }
      },
      { logLabel: "support_ticket_create" },
    );

    const populated = await SupportTicket.findById(ticket._id)
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    return res.status(201).json({
      success: true,
      status: 201,
      data: populated,
    });
  } catch (error) {
    console.error("❌ support_ticket create:", error);
    return errRes(
      res,
      500,
      error.message || "Failed to create support ticket",
    );
  }
}

// ─── 4) POST /support-ticket/reply/:id ───────────────────────────────

async function reply(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const ticketId = oid(req.params.id);
    if (!ticketId) return errRes(res, 400, "Valid ticket id is required");

    const message = req.body.message;
    const hasAttachments = !!req.files?.attachments;
    if (!message && !hasAttachments) {
      return errRes(res, 400, "message or attachments are required");
    }

    const admin = isAdmin(req);
    const isInternal = admin && req.body.is_internal === true;

    const ticketFilter = {
      _id: ticketId,
      company_id: companyId,
      deletedAt: null,
    };
    if (!admin) {
      ticketFilter.created_by = userId(req);
    }

    const ticket = await SupportTicket.findOne(ticketFilter);
    if (!ticket) return errRes(res, 404, "Ticket not found");

    if (ticket.status === "closed") {
      return errRes(res, 400, "Cannot reply to a closed ticket");
    }

    // Save attachments
    let attachmentMeta = [];
    if (hasAttachments) {
      attachmentMeta = await saveTicketFiles(req.files.attachments, {
        companyId: String(companyId),
        ticketId: String(ticketId),
        uploadedBy: String(userId(req)),
        req,
      });
    }

    const requesterId = ticket.created_by || ticket.user;
    const replyingAsRequester =
      String(requesterId || "") === String(userId(req) || "") &&
      req.body.role !== "admin" &&
      req.query.scope !== "admin" &&
      !isInternal;
    const replyRole = replyingAsRequester ? "user" : admin ? "admin" : "user";

    const newMessage = await SupportMessage.create({
      ticket_id: ticketId,
      user: userId(req),
      role: replyRole,
      message: message || "",
      is_internal: isInternal,
      attachments: attachmentMeta,
      company_id: companyId,
    });

    // Save attachment records
    if (attachmentMeta.length > 0) {
      const attachDocs = attachmentMeta.map((a) => ({
        ...a,
        ticket_id: ticketId,
        message_id: newMessage._id,
        uploaded_by: userId(req),
        company_id: companyId,
      }));
      await SupportAttachment.create(attachDocs);
    }

    // Status flow (skip for internal notes and already-closed)
    const updates = {
      last_reply_at: new Date(),
      last_reply_by: userId(req),
    };

    if (!isInternal && ticket.status !== "closed") {
      if (replyRole === "user") {
        updates.status = "waiting_for_admin";
      } else {
        updates.status = "waiting_for_user";
      }
    }

    await SupportTicket.findByIdAndUpdate(ticketId, { $set: updates });

    const populated = await SupportTicket.findById(ticketId)
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    // Include messages
    const msgFilter = { ticket_id: ticketId, deletedAt: null };
    if (!admin) msgFilter.is_internal = { $ne: true };
    const messages = await SupportMessage.find(msgFilter)
      .sort({ createdAt: 1 })
      .populate("user", USER_SELECT)
      .lean();

    return res.status(200).json({
      success: true,
      status: 200,
      data: { ...populated, messages },
    });
  } catch (error) {
    console.error("❌ support_ticket reply:", error);
    return errRes(
      res,
      500,
      error.message || "Failed to reply to support ticket",
    );
  }
}

// ─── 5) PUT /support-ticket/change-status/:id ────────────────────────

async function changeStatus(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const ticketId = oid(req.params.id);
    if (!ticketId) return errRes(res, 400, "Valid ticket id is required");

    const { status } = req.body;
    if (!status || !STATUS_VALUES.includes(status)) {
      return errRes(
        res,
        400,
        `status must be one of: ${STATUS_VALUES.join(", ")}`,
      );
    }

    const admin = isAdmin(req);

    const ticketFilter = {
      _id: ticketId,
      company_id: companyId,
      deletedAt: null,
    };
    if (!admin) {
      ticketFilter.created_by = userId(req);
    }

    const ticket = await SupportTicket.findOne(ticketFilter);
    if (!ticket) return errRes(res, 404, "Ticket not found");

    if (ticket.status === "closed") {
      return errRes(res, 400, "Cannot change status of a closed ticket");
    }

    if (!admin) {
      if (status !== "closed") {
        return errRes(
          res,
          403,
          "Non-admin users can only set status to closed",
        );
      }
      if (ticket.status !== "resolved") {
        return errRes(
          res,
          400,
          "You can only close a ticket that is currently resolved",
        );
      }
    }

    const updates = { status };
    if (status === "closed") updates.closed_at = new Date();

    const updated = await SupportTicket.findByIdAndUpdate(
      ticketId,
      { $set: updates },
      { new: true },
    )
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    return res.status(200).json({
      success: true,
      status: 200,
      data: updated,
    });
  } catch (error) {
    console.error("❌ support_ticket changeStatus:", error);
    return errRes(res, 500, error.message || "Failed to change ticket status");
  }
}

// ─── 6) PUT /support-ticket/change-priority/:id ──────────────────────

async function changePriority(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    if (!isAdmin(req)) {
      return errRes(res, 403, "Only admins can change ticket priority");
    }

    const ticketId = oid(req.params.id);
    if (!ticketId) return errRes(res, 400, "Valid ticket id is required");

    const { priority } = req.body;
    if (!priority || !PRIORITY_VALUES.includes(priority)) {
      return errRes(
        res,
        400,
        `priority must be one of: ${PRIORITY_VALUES.join(", ")}`,
      );
    }

    const updated = await SupportTicket.findOneAndUpdate(
      { _id: ticketId, company_id: companyId, deletedAt: null },
      { $set: { priority } },
      { new: true },
    )
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    if (!updated) return errRes(res, 404, "Ticket not found");

    return res.status(200).json({
      success: true,
      status: 200,
      data: updated,
    });
  } catch (error) {
    console.error("❌ support_ticket changePriority:", error);
    return errRes(
      res,
      500,
      error.message || "Failed to change ticket priority",
    );
  }
}

// ─── 7) PUT /support-ticket/assign/:id ───────────────────────────────

async function assign(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    if (!isAdmin(req)) {
      return errRes(res, 403, "Only admins can assign tickets");
    }

    const ticketId = oid(req.params.id);
    if (!ticketId) return errRes(res, 400, "Valid ticket id is required");

    const assignedTo = req.body.assigned_to
      ? oid(req.body.assigned_to)
      : null;

    const updated = await SupportTicket.findOneAndUpdate(
      { _id: ticketId, company_id: companyId, deletedAt: null },
      { $set: { assigned_to: assignedTo } },
      { new: true },
    )
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    if (!updated) return errRes(res, 404, "Ticket not found");

    return res.status(200).json({
      success: true,
      status: 200,
      data: updated,
    });
  } catch (error) {
    console.error("❌ support_ticket assign:", error);
    return errRes(res, 500, error.message || "Failed to assign ticket");
  }
}

// ─── 8) POST /support-ticket/upload-attachment ───────────────────────

async function uploadAttachment(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    if (!req.files?.file) {
      return errRes(res, 400, "file is required");
    }

    const ticketId = oid(req.body.ticket_id);
    const messageId = oid(req.body.message_id);

    // If ticket_id given, verify access
    if (ticketId) {
      const ticketFilter = {
        _id: ticketId,
        company_id: companyId,
        deletedAt: null,
      };
      if (!isAdmin(req)) ticketFilter.created_by = userId(req);
      const ticket = await SupportTicket.findOne(ticketFilter).lean();
      if (!ticket) return errRes(res, 404, "Ticket not found");
    }

    const files = await saveTicketFiles(req.files.file, {
      companyId: String(companyId),
      ticketId: String(ticketId || "unlinked"),
      uploadedBy: String(userId(req)),
      req,
    });

    const saved = await SupportAttachment.create(
      files.map((f) => ({
        ...f,
        ticket_id: ticketId || undefined,
        message_id: messageId || undefined,
        uploaded_by: userId(req),
        company_id: companyId,
      })),
    );

    const result = saved.length === 1 ? saved[0].toObject() : saved.map((s) => s.toObject());

    return res.status(201).json({
      success: true,
      status: 201,
      data: result,
    });
  } catch (error) {
    console.error("❌ support_ticket uploadAttachment:", error);
    return errRes(
      res,
      500,
      error.message || "Failed to upload attachment",
    );
  }
}

// ─── 9) DELETE /support-ticket/delete-attachment/:id ─────────────────

async function deleteAttachment(req, res) {
  try {
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const attachId = oid(req.params.id);
    if (!attachId) return errRes(res, 400, "Valid attachment id is required");

    const attachment = await SupportAttachment.findOne({
      _id: attachId,
      company_id: companyId,
      deletedAt: null,
    }).lean();

    if (!attachment) return errRes(res, 404, "Attachment not found");

    const admin = isAdmin(req);

    if (!admin) {
      if (String(attachment.uploaded_by) !== String(userId(req))) {
        return errRes(res, 403, "You can only delete your own attachments");
      }
      // Non-admin can only delete if ticket is still open
      if (attachment.ticket_id) {
        const ticket = await SupportTicket.findById(
          attachment.ticket_id,
        ).lean();
        if (ticket && ticket.status !== "open") {
          return errRes(
            res,
            400,
            "You can only delete attachments on open tickets",
          );
        }
      }
    }

    // Remove from disk
    safeUnlinkAttachment(attachment.path);

    // Soft-delete the record
    await SupportAttachment.findByIdAndUpdate(attachId, {
      $set: { deletedAt: new Date() },
    });

    // Also remove from the message's embedded attachments array
    if (attachment.message_id) {
      await SupportMessage.updateOne(
        { _id: attachment.message_id },
        { $pull: { attachments: { _id: attachId } } },
      );
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "Attachment deleted",
    });
  } catch (error) {
    console.error("❌ support_ticket deleteAttachment:", error);
    return errRes(
      res,
      500,
      error.message || "Failed to delete attachment",
    );
  }
}

module.exports = {
  getAll,
  getById,
  create,
  reply,
  changeStatus,
  changePriority,
  assign,
  uploadAttachment,
  deleteAttachment,
};

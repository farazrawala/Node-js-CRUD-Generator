const mongoose = require("mongoose");
const SupportTicket = require("../models/support_ticket");
const SupportMessage = require("../models/support_message");
const SupportAttachment = require("../models/support_attachment");
const SupportTicketRead = require("../models/support_ticket_read");
const User = require("../models/user");
const {
  CATEGORY_VALUES,
  PRIORITY_VALUES,
  STATUS_VALUES,
} = require("../models/support_ticket");
const { saveTicketFiles } = require("../utils/supportTicketUploads");
const { coalesceObjectId } = require("../utils/modelHelper");

const USER_SELECT = "name email";
const MODEL_NAME = "support-tickets";

/** Custom admin handlers for ticket list + conversation views. */
function resolveCompanyId(req) {
  const raw = req.user?.company_id;
  if (!raw) return null;
  return coalesceObjectId(raw?._id || raw);
}

/**
 * Platform super-admins (role ["ADMIN"] without company_id) see every tenant's
 * tickets; company-scoped admins are restricted to their own company.
 */
function companyScope(req) {
  const companyId = resolveCompanyId(req);
  return companyId ? { company_id: companyId } : {};
}

function currentUserId(req) {
  return coalesceObjectId(req.user?._id);
}

function oid(val) {
  if (!val) return null;
  const id = coalesceObjectId(val);
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

function truthy(val) {
  return val === true || val === "true" || val === "on" || val === "1";
}

function formatLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusBadgeClass(status) {
  switch (status) {
    case "open":
      return "bg-blue-100 text-blue-800";
    case "pending":
      return "bg-yellow-100 text-yellow-800";
    case "waiting_for_user":
      return "bg-purple-100 text-purple-800";
    case "waiting_for_admin":
      return "bg-orange-100 text-orange-800";
    case "resolved":
      return "bg-green-100 text-green-800";
    case "closed":
      return "bg-gray-100 text-gray-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function priorityBadgeClass(priority) {
  switch (priority) {
    case "urgent":
      return "bg-red-100 text-red-800";
    case "high":
      return "bg-orange-100 text-orange-800";
    case "medium":
      return "bg-yellow-100 text-yellow-800";
    case "low":
      return "bg-green-100 text-green-800";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

async function listAssignableAdmins(req) {
  return User.find({
    ...companyScope(req),
    role: "ADMIN",
    deletedAt: null,
  })
    .select("name email")
    .sort({ name: 1 })
    .lean();
}

function buildListUrl(query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  });
  const qs = params.toString();
  return qs ? `/admin/support-tickets?${qs}` : "/admin/support-tickets";
}

async function listTickets(req, res) {
  try {
    const scope = companyScope(req);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filters = {
      search: (req.query.search || "").trim(),
      status: req.query.status || "",
      priority: req.query.priority || "",
      category: req.query.category || "",
      assigned_to: req.query.assigned_to || "",
    };

    const filter = { ...scope, deletedAt: null };

    if (filters.status) filter.status = filters.status;
    if (filters.priority) filter.priority = filters.priority;
    if (filters.category) filter.category = filters.category;

    if (filters.assigned_to === "unassigned") {
      filter.assigned_to = null;
    } else if (filters.assigned_to) {
      const assigneeId = oid(filters.assigned_to);
      if (assigneeId) filter.assigned_to = assigneeId;
    }

    if (filters.search) {
      const regex = new RegExp(
        filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      const matchedUsers = await User.find(
        {
          ...scope,
          $or: [{ name: regex }, { email: regex }],
        },
        "_id",
      ).lean();

      filter.$or = [
        { subject: regex },
        { ticket_number: regex },
        ...(matchedUsers.length > 0
          ? [{ created_by: { $in: matchedUsers.map((u) => u._id) } }]
          : []),
      ];
    }

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ last_reply_at: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", USER_SELECT)
        .populate("created_by", USER_SELECT)
        .populate("assigned_to", USER_SELECT)
        .lean(),
      SupportTicket.countDocuments(filter),
    ]);

    const viewerId = currentUserId(req);
    const ticketIds = tickets.map((t) => t._id);
    const readStates = await SupportTicketRead.find({
      ticket_id: { $in: ticketIds },
      user_id: viewerId,
    }).lean();

    const readMap = {};
    for (const r of readStates) {
      readMap[String(r.ticket_id)] = r.last_read_at;
    }

    const unreadAgg = await SupportMessage.aggregate([
      {
        $match: {
          ticket_id: { $in: ticketIds },
          deletedAt: null,
        },
      },
      { $group: { _id: "$ticket_id", msgs: { $push: "$createdAt" } } },
    ]);

    const unreadMap = {};
    for (const row of unreadAgg) {
      const lastRead = readMap[String(row._id)];
      unreadMap[String(row._id)] = lastRead
        ? row.msgs.filter((d) => d > lastRead).length
        : row.msgs.length;
    }

    const records = tickets.map((t) => ({
      ...t,
      unread_count: unreadMap[String(t._id)] || 0,
    }));

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const adminUsers = await listAssignableAdmins(req);

    res.render("admin/support-tickets-list", {
      title: "Support Tickets",
      modelName: MODEL_NAME,
      routes: req.routes || [],
      baseUrl: req.baseUrl,
      records,
      filters,
      categories: CATEGORY_VALUES,
      priorities: PRIORITY_VALUES,
      statuses: STATUS_VALUES,
      adminUsers,
      formatLabel,
      statusBadgeClass,
      priorityBadgeClass,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      buildListUrl,
    });
  } catch (error) {
    console.error("❌ Admin support tickets list:", error);
    req.flash("error", "Unable to load support tickets.");
    res.redirect("/admin/dashboard");
  }
}

async function viewTicket(req, res) {
  try {
    const ticketId = oid(req.params.id);
    if (!ticketId) {
      req.flash("error", "Invalid ticket id.");
      return res.redirect("/admin/support-tickets");
    }

    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      ...companyScope(req),
      deletedAt: null,
    })
      .populate("user", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("assigned_to", USER_SELECT)
      .lean();

    if (!ticket) {
      req.flash("error", "Ticket not found.");
      return res.redirect("/admin/support-tickets");
    }

    const messages = await SupportMessage.find({
      ticket_id: ticketId,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .populate("user", USER_SELECT)
      .lean();

    await SupportTicketRead.findOneAndUpdate(
      { ticket_id: ticketId, user_id: currentUserId(req) },
      { $set: { last_read_at: new Date() } },
      { upsert: true },
    );

    const adminUsers = await listAssignableAdmins(req);

    res.render("admin/support-ticket-detail", {
      title: `Ticket ${ticket.ticket_number}`,
      modelName: MODEL_NAME,
      routes: req.routes || [],
      baseUrl: req.baseUrl,
      ticket,
      messages,
      adminUsers,
      categories: CATEGORY_VALUES,
      priorities: PRIORITY_VALUES,
      statuses: STATUS_VALUES,
      formatLabel,
      statusBadgeClass,
      priorityBadgeClass,
    });
  } catch (error) {
    console.error("❌ Admin support ticket detail:", error);
    req.flash("error", "Unable to load ticket details.");
    res.redirect("/admin/support-tickets");
  }
}

async function replyTicket(req, res) {
  const ticketId = oid(req.params.id);
  const redirectTo = ticketId
    ? `/admin/support-tickets/${ticketId}`
    : "/admin/support-tickets";

  try {
    if (!ticketId) {
      req.flash("error", "Invalid ticket id.");
      return res.redirect("/admin/support-tickets");
    }

    const message = (req.body.message || "").trim();
    const hasAttachments = !!req.files?.attachments;
    if (!message && !hasAttachments) {
      req.flash("error", "Please enter a message or attach a file.");
      return res.redirect(redirectTo);
    }

    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      ...companyScope(req),
      deletedAt: null,
    });
    if (!ticket) {
      req.flash("error", "Ticket not found.");
      return res.redirect("/admin/support-tickets");
    }
    if (ticket.status === "closed") {
      req.flash("error", "Cannot reply to a closed ticket.");
      return res.redirect(redirectTo);
    }

    // Messages inherit the ticket's tenant so super-admin replies stay scoped.
    const companyId = ticket.company_id;
    const isInternal = truthy(req.body.is_internal);
    let attachmentMeta = [];
    if (hasAttachments) {
      attachmentMeta = await saveTicketFiles(req.files.attachments, {
        companyId: String(companyId),
        ticketId: String(ticketId),
        uploadedBy: String(currentUserId(req)),
        req,
      });
    }

    const newMessage = await SupportMessage.create({
      ticket_id: ticketId,
      user: currentUserId(req),
      role: "admin",
      message: message || "",
      is_internal: isInternal,
      attachments: attachmentMeta,
      company_id: companyId,
    });

    if (attachmentMeta.length > 0) {
      await SupportAttachment.create(
        attachmentMeta.map((a) => ({
          ...a,
          ticket_id: ticketId,
          message_id: newMessage._id,
          uploaded_by: currentUserId(req),
          company_id: companyId,
        })),
      );
    }

    const updates = {
      last_reply_at: new Date(),
      last_reply_by: currentUserId(req),
    };
    if (!isInternal && ticket.status !== "closed") {
      updates.status = "waiting_for_user";
    }
    await SupportTicket.findByIdAndUpdate(ticketId, { $set: updates });

    req.flash(
      "success",
      isInternal ? "Internal note added." : "Reply sent successfully.",
    );
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("❌ Admin support ticket reply:", error);
    req.flash("error", error.message || "Failed to send reply.");
    return res.redirect(redirectTo);
  }
}

async function updateStatus(req, res) {
  const ticketId = oid(req.params.id);
  const redirectTo = ticketId
    ? `/admin/support-tickets/${ticketId}`
    : "/admin/support-tickets";

  try {
    if (!ticketId) {
      req.flash("error", "Invalid request.");
      return res.redirect("/admin/support-tickets");
    }

    const { status } = req.body;
    if (!status || !STATUS_VALUES.includes(status)) {
      req.flash("error", "Invalid status.");
      return res.redirect(redirectTo);
    }

    const ticket = await SupportTicket.findOne({
      _id: ticketId,
      ...companyScope(req),
      deletedAt: null,
    });
    if (!ticket) {
      req.flash("error", "Ticket not found.");
      return res.redirect("/admin/support-tickets");
    }
    if (ticket.status === "closed") {
      req.flash("error", "Cannot change status of a closed ticket.");
      return res.redirect(redirectTo);
    }

    const updates = { status };
    if (status === "closed") updates.closed_at = new Date();

    await SupportTicket.findByIdAndUpdate(ticketId, { $set: updates });
    req.flash("success", `Status updated to ${formatLabel(status)}.`);
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("❌ Admin support ticket status:", error);
    req.flash("error", "Failed to update status.");
    return res.redirect(redirectTo);
  }
}

async function updatePriority(req, res) {
  const ticketId = oid(req.params.id);
  const redirectTo = ticketId
    ? `/admin/support-tickets/${ticketId}`
    : "/admin/support-tickets";

  try {
    if (!ticketId) {
      req.flash("error", "Invalid request.");
      return res.redirect("/admin/support-tickets");
    }

    const { priority } = req.body;
    if (!priority || !PRIORITY_VALUES.includes(priority)) {
      req.flash("error", "Invalid priority.");
      return res.redirect(redirectTo);
    }

    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: ticketId, ...companyScope(req), deletedAt: null },
      { $set: { priority } },
      { new: true },
    );
    if (!ticket) {
      req.flash("error", "Ticket not found.");
      return res.redirect("/admin/support-tickets");
    }

    req.flash("success", `Priority updated to ${formatLabel(priority)}.`);
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("❌ Admin support ticket priority:", error);
    req.flash("error", "Failed to update priority.");
    return res.redirect(redirectTo);
  }
}

async function assignTicket(req, res) {
  const ticketId = oid(req.params.id);
  const redirectTo = ticketId
    ? `/admin/support-tickets/${ticketId}`
    : "/admin/support-tickets";

  try {
    if (!ticketId) {
      req.flash("error", "Invalid request.");
      return res.redirect("/admin/support-tickets");
    }

    let assignedTo = null;
    if (req.body.assigned_to) {
      assignedTo = oid(req.body.assigned_to);
      if (!assignedTo) {
        req.flash("error", "Invalid assignee.");
        return res.redirect(redirectTo);
      }
    }

    const ticket = await SupportTicket.findOneAndUpdate(
      { _id: ticketId, ...companyScope(req), deletedAt: null },
      { $set: { assigned_to: assignedTo } },
      { new: true },
    );
    if (!ticket) {
      req.flash("error", "Ticket not found.");
      return res.redirect("/admin/support-tickets");
    }

    req.flash(
      "success",
      assignedTo ? "Ticket assigned successfully." : "Ticket unassigned.",
    );
    return res.redirect(redirectTo);
  } catch (error) {
    console.error("❌ Admin support ticket assign:", error);
    req.flash("error", "Failed to assign ticket.");
    return res.redirect(redirectTo);
  }
}

module.exports = {
  listTickets,
  viewTicket,
  replyTicket,
  updateStatus,
  updatePriority,
  assignTicket,
};

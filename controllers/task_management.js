const mongoose = require("mongoose");
const TaskBoard = require("../models/task_board");
const TaskColumn = require("../models/task_column");
const Task = require("../models/task");
const TaskComment = require("../models/task_comment");
const TaskActivity = require("../models/task_activity");
const TaskCounter = require("../models/task_counter");
const User = require("../models/user");
const { PRIORITY_VALUES } = require("../models/task");
const { coalesceObjectId } = require("../utils/modelHelper");
const {
  nextTailPosition,
  midPosition,
  needsRebalance,
  rebalancePositions,
  POSITION_GAP,
} = require("../utils/taskPosition");
const {
  saveTaskFiles,
  safeUnlinkAttachment,
} = require("../utils/taskUploads");

const USER_SELECT = "name email";
const DEFAULT_COLUMNS = [
  { name: "Backlog", color: "#6c757d" },
  { name: "To Do", color: "#0d6efd" },
  { name: "In Progress", color: "#fd7e14" },
  { name: "Review", color: "#6f42c1" },
  { name: "Done", color: "#198754" },
];

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

function oid(val) {
  if (!val) return null;
  const id = coalesceObjectId(val);
  return id instanceof mongoose.Types.ObjectId ? id : null;
}

function errRes(res, status, message) {
  return res.status(status).json({ success: false, status, message });
}

function modulePerms(req) {
  const perms = req.user?.permissions?.tasks;
  if (isAdmin(req)) {
    return { view: true, add: true, edit: true, delete: true };
  }
  return {
    view: !!perms?.view,
    add: !!perms?.add,
    edit: !!perms?.edit,
    delete: !!perms?.delete,
  };
}

function requirePerm(req, res, action) {
  const p = modulePerms(req);
  if (!p[action] && !p.view && action === "view") {
    errRes(res, 403, "Missing tasks.view permission");
    return false;
  }
  if (action !== "view" && !p[action]) {
    errRes(res, 403, `Missing tasks.${action} permission`);
    return false;
  }
  if (action === "view" && !p.view) {
    errRes(res, 403, "Missing tasks.view permission");
    return false;
  }
  return true;
}

function memberIds(board) {
  return (board.members || []).map((m) => String(m._id || m));
}

function canAccessBoard(req, board) {
  if (!board) return false;
  if (isAdmin(req)) return true;
  const uid = String(userId(req));
  if (String(board.created_by?._id || board.created_by) === uid) return true;
  return memberIds(board).includes(uid);
}

function canManageBoard(req, board) {
  if (!board) return false;
  if (isAdmin(req)) return true;
  const uid = String(userId(req));
  if (String(board.created_by?._id || board.created_by) === uid) return true;
  return modulePerms(req).edit && memberIds(board).includes(uid);
}

async function loadBoard(companyId, boardId) {
  return TaskBoard.findOne({
    _id: boardId,
    company_id: companyId,
    deletedAt: null,
  });
}

async function logActivity({
  companyId,
  taskId,
  boardId,
  userId: uid,
  action,
  old_value = null,
  new_value = null,
  metadata = {},
}) {
  try {
    await TaskActivity.create({
      company_id: companyId,
      task_id: taskId,
      board_id: boardId || null,
      user_id: uid,
      action,
      old_value,
      new_value,
      metadata,
    });
  } catch (e) {
    console.error("❌ task activity log:", e.message);
  }
}

async function nextTaskNumber(companyId) {
  const doc = await TaskCounter.findOneAndUpdate(
    { company_id: companyId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return doc.seq;
}

async function validateAssignees(companyId, assigneeIds) {
  if (!assigneeIds || !assigneeIds.length) return [];
  const ids = assigneeIds.map(oid).filter(Boolean);
  if (!ids.length) return [];
  const users = await User.find({
    _id: { $in: ids },
    company_id: companyId,
    deletedAt: null,
  }).select("_id");
  return users.map((u) => u._id);
}

function extractMentions(body) {
  const matches = String(body || "").match(/@([a-zA-Z0-9._-]+)/g) || [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
}

async function resolveMentionIds(companyId, usernames) {
  if (!usernames.length) return [];
  const users = await User.find({
    company_id: companyId,
    deletedAt: null,
    $or: usernames.map((u) => ({
      name: new RegExp(`^${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })),
  }).select("_id");
  return users.map((u) => u._id);
}

function checklistProgress(checklists) {
  let total = 0;
  let done = 0;
  for (const c of checklists || []) {
    for (const item of c.items || []) {
      total += 1;
      if (item.is_completed) done += 1;
    }
  }
  return { completed: done, total };
}

function serializeTaskCard(task) {
  const progress = checklistProgress(task.checklists);
  return {
    ...task,
    checklist_progress: progress,
    attachments_count: (task.attachments || []).length,
  };
}

// ─── Boards ───────────────────────────────────────────────────────────

async function listBoards(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const includeArchived = req.query.include_archived === "true";
    const uid = userId(req);

    const filter = { company_id: companyId, deletedAt: null };
    if (!includeArchived) filter.is_archived = false;
    if (!isAdmin(req)) {
      filter.$or = [{ created_by: uid }, { members: uid }];
    }
    if (req.query.search) {
      const regex = new RegExp(
        String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      filter.name = regex;
    }

    const [data, total] = await Promise.all([
      TaskBoard.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("created_by", USER_SELECT)
        .populate("members", USER_SELECT)
        .lean(),
      TaskBoard.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      status: 200,
      data,
      pagination: { skip, limit, total },
    });
  } catch (error) {
    console.error("❌ task listBoards:", error);
    return errRes(res, 500, error.message || "Failed to list boards");
  }
}

async function getBoard(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    if (!boardId) return errRes(res, 400, "Valid board id is required");

    const board = await TaskBoard.findOne({
      _id: boardId,
      company_id: companyId,
      deletedAt: null,
    })
      .populate("created_by", USER_SELECT)
      .populate("members", USER_SELECT)
      .lean();

    if (!board) return errRes(res, 404, "Board not found");
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const columns = await TaskColumn.find({
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
      is_archived: false,
    })
      .sort({ position: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      status: 200,
      data: { ...board, columns },
    });
  } catch (error) {
    console.error("❌ task getBoard:", error);
    return errRes(res, 500, error.message || "Failed to get board");
  }
}

async function createBoard(req, res) {
  try {
    if (!requirePerm(req, res, "add")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const uid = userId(req);
    const name = String(req.body.name || "").trim();
    if (!name) return errRes(res, 400, "Board name is required");

    let members = await validateAssignees(companyId, req.body.members || []);
    if (!members.some((m) => String(m) === String(uid))) {
      members = [uid, ...members];
    }

    const board = await TaskBoard.create({
      company_id: companyId,
      name,
      description: req.body.description || "",
      color: req.body.color || "#0d6efd",
      icon: req.body.icon || "clipboard",
      created_by: uid,
      members,
      updated_by: uid,
    });

    const cols = DEFAULT_COLUMNS.map((c, i) => ({
      company_id: companyId,
      board_id: board._id,
      name: c.name,
      color: c.color,
      position: (i + 1) * POSITION_GAP,
    }));
    await TaskColumn.insertMany(cols);

    const populated = await TaskBoard.findById(board._id)
      .populate("created_by", USER_SELECT)
      .populate("members", USER_SELECT)
      .lean();

    return res.status(201).json({ success: true, status: 201, data: populated });
  } catch (error) {
    console.error("❌ task createBoard:", error);
    return errRes(res, 500, error.message || "Failed to create board");
  }
}

async function updateBoard(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    if (!boardId) return errRes(res, 400, "Valid board id is required");

    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    if (req.body.name != null) board.name = String(req.body.name).trim();
    if (req.body.description != null) board.description = req.body.description;
    if (req.body.color != null) board.color = req.body.color;
    if (req.body.icon != null) board.icon = req.body.icon;
    if (req.body.is_archived != null) board.is_archived = !!req.body.is_archived;
    board.updated_by = userId(req);
    await board.save();

    const data = await TaskBoard.findById(board._id)
      .populate("created_by", USER_SELECT)
      .populate("members", USER_SELECT)
      .lean();

    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task updateBoard:", error);
    return errRes(res, 500, error.message || "Failed to update board");
  }
}

async function archiveBoard(req, res) {
  try {
    if (!requirePerm(req, res, "delete")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    board.is_archived = true;
    board.updated_by = userId(req);
    await board.save();
    return res.status(200).json({ success: true, status: 200, data: board });
  } catch (error) {
    console.error("❌ task archiveBoard:", error);
    return errRes(res, 500, error.message || "Failed to archive board");
  }
}

async function deleteBoard(req, res) {
  try {
    if (!requirePerm(req, res, "delete")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    const now = new Date();
    board.deletedAt = now;
    board.is_archived = true;
    board.updated_by = userId(req);
    await board.save();
    await TaskColumn.updateMany(
      { board_id: boardId, company_id: companyId },
      { deletedAt: now, is_archived: true },
    );
    await Task.updateMany(
      { board_id: boardId, company_id: companyId },
      { deletedAt: now, is_archived: true },
    );
    return res.status(200).json({ success: true, status: 200, message: "Board deleted" });
  } catch (error) {
    console.error("❌ task deleteBoard:", error);
    return errRes(res, 500, error.message || "Failed to delete board");
  }
}

async function duplicateBoard(req, res) {
  try {
    if (!requirePerm(req, res, "add")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    const src = await loadBoard(companyId, boardId);
    if (!src) return errRes(res, 404, "Board not found");
    if (!canAccessBoard(req, src)) return errRes(res, 403, "Not a board member");

    const uid = userId(req);
    const board = await TaskBoard.create({
      company_id: companyId,
      name: `${src.name} (Copy)`,
      description: src.description,
      color: src.color,
      icon: src.icon,
      created_by: uid,
      members: src.members?.length ? src.members : [uid],
      updated_by: uid,
    });

    const columns = await TaskColumn.find({
      board_id: boardId,
      company_id: companyId,
      deletedAt: null,
    }).sort({ position: 1 });

    const colMap = {};
    for (const c of columns) {
      const nc = await TaskColumn.create({
        company_id: companyId,
        board_id: board._id,
        name: c.name,
        position: c.position,
        color: c.color,
        wip_limit: c.wip_limit,
      });
      colMap[String(c._id)] = nc._id;
    }

    const copyTasks = req.body.copy_tasks === true;
    if (copyTasks) {
      const tasks = await Task.find({
        board_id: boardId,
        company_id: companyId,
        deletedAt: null,
        is_archived: false,
      });
      for (const t of tasks) {
        const num = await nextTaskNumber(companyId);
        await Task.create({
          company_id: companyId,
          board_id: board._id,
          column_id: colMap[String(t.column_id)] || Object.values(colMap)[0],
          title: t.title,
          description: t.description,
          task_number: num,
          priority: t.priority,
          status: t.status,
          assignee_ids: t.assignee_ids,
          created_by: uid,
          labels: t.labels,
          due_date: t.due_date,
          start_date: t.start_date,
          checklists: t.checklists,
          position: t.position,
          updated_by: uid,
        });
      }
    }

    const data = await TaskBoard.findById(board._id)
      .populate("created_by", USER_SELECT)
      .populate("members", USER_SELECT)
      .lean();
    return res.status(201).json({ success: true, status: 201, data });
  } catch (error) {
    console.error("❌ task duplicateBoard:", error);
    return errRes(res, 500, error.message || "Failed to duplicate board");
  }
}

async function addBoardMember(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    const memberId = oid(req.body.user_id);
    if (!memberId) return errRes(res, 400, "user_id is required");
    const valid = await validateAssignees(companyId, [memberId]);
    if (!valid.length) return errRes(res, 400, "User not found in company");

    if (!board.members.some((m) => String(m) === String(memberId))) {
      board.members.push(memberId);
      board.updated_by = userId(req);
      await board.save();
    }

    const data = await TaskBoard.findById(board._id)
      .populate("members", USER_SELECT)
      .lean();
    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task addBoardMember:", error);
    return errRes(res, 500, error.message || "Failed to add member");
  }
}

async function removeBoardMember(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id);
    const memberId = oid(req.params.userId);
    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    board.members = board.members.filter((m) => String(m) !== String(memberId));
    board.updated_by = userId(req);
    await board.save();

    const data = await TaskBoard.findById(board._id)
      .populate("members", USER_SELECT)
      .lean();
    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task removeBoardMember:", error);
    return errRes(res, 500, error.message || "Failed to remove member");
  }
}

// ─── Columns ──────────────────────────────────────────────────────────

async function listColumns(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.query.board_id || req.params.boardId);
    if (!boardId) return errRes(res, 400, "board_id is required");

    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const data = await TaskColumn.find({
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
      is_archived: false,
    })
      .sort({ position: 1 })
      .lean();

    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task listColumns:", error);
    return errRes(res, 500, error.message || "Failed to list columns");
  }
}

async function createColumn(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.body.board_id || req.params.boardId);
    if (!boardId) return errRes(res, 400, "board_id is required");
    const name = String(req.body.name || "").trim();
    if (!name) return errRes(res, 400, "Column name is required");

    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    const last = await TaskColumn.findOne({
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
    })
      .sort({ position: -1 })
      .select("position")
      .lean();

    const col = await TaskColumn.create({
      company_id: companyId,
      board_id: boardId,
      name,
      color: req.body.color || "#6c757d",
      wip_limit: req.body.wip_limit != null ? Number(req.body.wip_limit) : null,
      position: nextTailPosition(last?.position),
    });

    return res.status(201).json({ success: true, status: 201, data: col });
  } catch (error) {
    console.error("❌ task createColumn:", error);
    return errRes(res, 500, error.message || "Failed to create column");
  }
}

async function updateColumn(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const colId = oid(req.params.id);
    const col = await TaskColumn.findOne({
      _id: colId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!col) return errRes(res, 404, "Column not found");

    const board = await loadBoard(companyId, col.board_id);
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    if (req.body.name != null) col.name = String(req.body.name).trim();
    if (req.body.color != null) col.color = req.body.color;
    if (req.body.wip_limit !== undefined) {
      col.wip_limit =
        req.body.wip_limit === null || req.body.wip_limit === ""
          ? null
          : Number(req.body.wip_limit);
    }
    if (req.body.is_archived != null) col.is_archived = !!req.body.is_archived;
    await col.save();
    return res.status(200).json({ success: true, status: 200, data: col });
  } catch (error) {
    console.error("❌ task updateColumn:", error);
    return errRes(res, 500, error.message || "Failed to update column");
  }
}

async function archiveColumn(req, res) {
  try {
    if (!requirePerm(req, res, "delete")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const colId = oid(req.params.id);
    const col = await TaskColumn.findOne({
      _id: colId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!col) return errRes(res, 404, "Column not found");
    const board = await loadBoard(companyId, col.board_id);
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    col.is_archived = true;
    col.deletedAt = new Date();
    await col.save();
    return res.status(200).json({ success: true, status: 200, data: col });
  } catch (error) {
    console.error("❌ task archiveColumn:", error);
    return errRes(res, 500, error.message || "Failed to archive column");
  }
}

async function reorderColumns(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.body.board_id);
    const orderedIds = (req.body.column_ids || []).map(oid).filter(Boolean);
    if (!boardId || !orderedIds.length) {
      return errRes(res, 400, "board_id and column_ids are required");
    }

    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canManageBoard(req, board)) return errRes(res, 403, "Cannot manage board");

    const updates = rebalancePositions(orderedIds.map((id) => ({ _id: id })));
    await Promise.all(
      updates.map((u) =>
        TaskColumn.updateOne(
          { _id: u._id, company_id: companyId, board_id: boardId },
          { $set: { position: u.position } },
        ),
      ),
    );

    const data = await TaskColumn.find({
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
      is_archived: false,
    })
      .sort({ position: 1 })
      .lean();

    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task reorderColumns:", error);
    return errRes(res, 500, error.message || "Failed to reorder columns");
  }
}

// ─── Tasks ────────────────────────────────────────────────────────────

function buildTaskFilter(req, companyId) {
  const filter = { company_id: companyId, deletedAt: null };
  if (req.query.include_archived !== "true") filter.is_archived = false;

  const boardId = oid(req.query.board_id);
  if (boardId) filter.board_id = boardId;
  const columnId = oid(req.query.column_id);
  if (columnId) filter.column_id = columnId;

  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.is_completed === "true") filter.is_completed = true;
  if (req.query.is_completed === "false") filter.is_completed = false;

  const assignee = oid(req.query.assignee_id || req.query.assignee);
  if (assignee) filter.assignee_ids = assignee;

  const createdBy = oid(req.query.created_by);
  if (createdBy) filter.created_by = createdBy;

  if (req.query.label) filter.labels = req.query.label;

  if (req.query.due === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    filter.due_date = { $gte: start, $lte: end };
  } else if (req.query.due === "overdue") {
    filter.due_date = { $lt: new Date() };
    filter.is_completed = false;
  } else if (req.query.due === "upcoming") {
    const start = new Date();
    start.setHours(23, 59, 59, 999);
    filter.due_date = { $gt: start };
    filter.is_completed = false;
  }

  if (req.query.scope === "assigned_to_me") {
    filter.assignee_ids = userId(req);
  } else if (req.query.scope === "created_by_me") {
    filter.created_by = userId(req);
  } else if (req.query.scope === "my_tasks") {
    filter.$or = [
      { assignee_ids: userId(req) },
      { created_by: userId(req) },
    ];
  } else if (req.query.scope === "completed") {
    filter.is_completed = true;
  }

  if (req.query.search) {
    const s = String(req.query.search).trim();
    const regex = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const asNum = Number(s);
    filter.$and = filter.$and || [];
    filter.$and.push({
      $or: [
        { title: regex },
        ...(Number.isFinite(asNum) ? [{ task_number: asNum }] : []),
      ],
    });
  }

  return filter;
}

async function listTasks(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");

    const skip = Math.max(0, parseInt(req.query.skip, 10) || 0);
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit, 10) || 200),
    );

    const filter = buildTaskFilter(req, companyId);

    // Restrict to boards the user can access
    if (!isAdmin(req)) {
      const uid = userId(req);
      const boards = await TaskBoard.find({
        company_id: companyId,
        deletedAt: null,
        $or: [{ created_by: uid }, { members: uid }],
      }).select("_id");
      const boardIds = boards.map((b) => b._id);
      if (filter.board_id) {
        if (!boardIds.some((id) => String(id) === String(filter.board_id))) {
          return res.status(200).json({
            success: true,
            status: 200,
            data: [],
            pagination: { skip, limit, total: 0 },
          });
        }
      } else {
        filter.board_id = { $in: boardIds };
      }
    }

    let sort = { position: 1 };
    const sortBy = req.query.sortBy || "position";
    const sortOrder = req.query.sortOrder === "desc" ? -1 : 1;
    if (sortBy === "priority") {
      // handled after fetch for custom order if needed; use field sort
      sort = { priority: sortOrder, position: 1 };
    } else if (["due_date", "createdAt", "updatedAt", "title", "task_number"].includes(sortBy)) {
      sort = { [sortBy]: sortOrder };
    }

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate("assignee_ids", USER_SELECT)
        .populate("created_by", USER_SELECT)
        .populate("board_id", "name color")
        .populate("column_id", "name color")
        .lean(),
      Task.countDocuments(filter),
    ]);

    const data = tasks.map(serializeTaskCard);
    return res.status(200).json({
      success: true,
      status: 200,
      data,
      pagination: { skip, limit, total },
    });
  } catch (error) {
    console.error("❌ task listTasks:", error);
    return errRes(res, 500, error.message || "Failed to list tasks");
  }
}

async function getBoardKanban(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const boardId = oid(req.params.id || req.params.boardId);
    if (!boardId) return errRes(res, 400, "board id is required");

    const board = await TaskBoard.findOne({
      _id: boardId,
      company_id: companyId,
      deletedAt: null,
    })
      .populate("created_by", USER_SELECT)
      .populate("members", USER_SELECT)
      .lean();
    if (!board) return errRes(res, 404, "Board not found");
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const columns = await TaskColumn.find({
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
      is_archived: false,
    })
      .sort({ position: 1 })
      .lean();

    const taskFilter = {
      company_id: companyId,
      board_id: boardId,
      deletedAt: null,
      is_archived: false,
    };
    // Apply lightweight filters from query
    if (req.query.priority) taskFilter.priority = req.query.priority;
    if (req.query.assignee_id) {
      const a = oid(req.query.assignee_id);
      if (a) taskFilter.assignee_ids = a;
    }
    if (req.query.is_completed === "true") taskFilter.is_completed = true;
    if (req.query.is_completed === "false") taskFilter.is_completed = false;
    if (req.query.search) {
      const s = String(req.query.search).trim();
      const regex = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const asNum = Number(s);
      taskFilter.$or = [
        { title: regex },
        ...(Number.isFinite(asNum) ? [{ task_number: asNum }] : []),
      ];
    }

    const tasks = await Task.find(taskFilter)
      .sort({ position: 1 })
      .populate("assignee_ids", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .lean();

    const byCol = {};
    for (const c of columns) byCol[String(c._id)] = [];
    for (const t of tasks) {
      const key = String(t.column_id);
      if (!byCol[key]) byCol[key] = [];
      byCol[key].push(serializeTaskCard(t));
    }

    const columnsWithTasks = columns.map((c) => ({
      ...c,
      tasks: byCol[String(c._id)] || [],
    }));

    return res.status(200).json({
      success: true,
      status: 200,
      data: { board, columns: columnsWithTasks },
    });
  } catch (error) {
    console.error("❌ task getBoardKanban:", error);
    return errRes(res, 500, error.message || "Failed to load kanban");
  }
}

async function getTask(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.params.id);
    if (!taskId) return errRes(res, 400, "Valid task id is required");

    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    })
      .populate("assignee_ids", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("board_id", "name color members created_by")
      .populate("column_id", "name color")
      .populate("attachments.uploaded_by", USER_SELECT)
      .lean();

    if (!task) return errRes(res, 404, "Task not found");

    const board = await loadBoard(companyId, task.board_id?._id || task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const [comments, activity] = await Promise.all([
      TaskComment.find({
        task_id: taskId,
        company_id: companyId,
        deletedAt: null,
      })
        .sort({ createdAt: 1 })
        .populate("user_id", USER_SELECT)
        .lean(),
      TaskActivity.find({ task_id: taskId, company_id: companyId })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate("user_id", USER_SELECT)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      status: 200,
      data: {
        ...serializeTaskCard(task),
        comments,
        activity,
      },
    });
  } catch (error) {
    console.error("❌ task getTask:", error);
    return errRes(res, 500, error.message || "Failed to get task");
  }
}

async function createTask(req, res) {
  try {
    if (!requirePerm(req, res, "add")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const uid = userId(req);

    const boardId = oid(req.body.board_id);
    const columnId = oid(req.body.column_id);
    const title = String(req.body.title || "").trim();
    if (!boardId || !columnId || !title) {
      return errRes(res, 400, "board_id, column_id and title are required");
    }

    const board = await loadBoard(companyId, boardId);
    if (!board) return errRes(res, 404, "Board not found");
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const column = await TaskColumn.findOne({
      _id: columnId,
      board_id: boardId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!column) return errRes(res, 400, "Column not found on board");

    const last = await Task.findOne({
      company_id: companyId,
      column_id: columnId,
      deletedAt: null,
    })
      .sort({ position: -1 })
      .select("position")
      .lean();

    const assignees = await validateAssignees(
      companyId,
      req.body.assignee_ids || (req.body.assignee_id ? [req.body.assignee_id] : []),
    );

    const priority = PRIORITY_VALUES.includes(req.body.priority)
      ? req.body.priority
      : "medium";

    const task_number = await nextTaskNumber(companyId);
    const task = await Task.create({
      company_id: companyId,
      board_id: boardId,
      column_id: columnId,
      title,
      description: req.body.description || "",
      task_number,
      priority,
      status: column.name,
      assignee_ids: assignees,
      created_by: uid,
      labels: Array.isArray(req.body.labels) ? req.body.labels : [],
      due_date: req.body.due_date ? new Date(req.body.due_date) : null,
      start_date: req.body.start_date ? new Date(req.body.start_date) : null,
      checklists: Array.isArray(req.body.checklists) ? req.body.checklists : [],
      position: nextTailPosition(last?.position),
      updated_by: uid,
    });

    await logActivity({
      companyId,
      taskId: task._id,
      boardId,
      userId: uid,
      action: "task_created",
      new_value: { title, column_id: columnId },
    });

    if (assignees.length) {
      await logActivity({
        companyId,
        taskId: task._id,
        boardId,
        userId: uid,
        action: "task_assigned",
        new_value: assignees,
      });
    }

    const data = await Task.findById(task._id)
      .populate("assignee_ids", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .lean();

    return res.status(201).json({
      success: true,
      status: 201,
      data: serializeTaskCard(data),
    });
  } catch (error) {
    console.error("❌ task createTask:", error);
    return errRes(res, 500, error.message || "Failed to create task");
  }
}

async function updateTask(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.params.id);
    const uid = userId(req);

    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");

    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const changes = [];

    if (req.body.title != null) {
      const title = String(req.body.title).trim();
      if (title && title !== task.title) {
        changes.push(["title", task.title, title]);
        task.title = title;
      }
    }
    if (req.body.description != null && req.body.description !== task.description) {
      changes.push(["description", null, "updated"]);
      task.description = req.body.description;
    }
    if (req.body.priority && PRIORITY_VALUES.includes(req.body.priority)) {
      if (req.body.priority !== task.priority) {
        changes.push(["priority", task.priority, req.body.priority]);
        task.priority = req.body.priority;
      }
    }
    if (req.body.labels != null) {
      task.labels = Array.isArray(req.body.labels) ? req.body.labels : [];
      changes.push(["labels", null, task.labels]);
    }
    if (req.body.due_date !== undefined) {
      const next = req.body.due_date ? new Date(req.body.due_date) : null;
      changes.push(["due_date", task.due_date, next]);
      task.due_date = next;
    }
    if (req.body.start_date !== undefined) {
      task.start_date = req.body.start_date ? new Date(req.body.start_date) : null;
    }
    if (req.body.assignee_ids != null) {
      const assignees = await validateAssignees(companyId, req.body.assignee_ids);
      changes.push(["assignees", task.assignee_ids, assignees]);
      task.assignee_ids = assignees;
    }
    if (req.body.is_completed != null) {
      const done = !!req.body.is_completed;
      if (done !== task.is_completed) {
        changes.push(["completed", task.is_completed, done]);
        task.is_completed = done;
        task.completed_at = done ? new Date() : null;
      }
    }
    if (req.body.column_id) {
      const columnId = oid(req.body.column_id);
      if (columnId && String(columnId) !== String(task.column_id)) {
        const column = await TaskColumn.findOne({
          _id: columnId,
          board_id: task.board_id,
          company_id: companyId,
          deletedAt: null,
        });
        if (column) {
          changes.push(["column", task.column_id, columnId]);
          task.column_id = columnId;
          task.status = column.name;
          if (/^done$/i.test(column.name)) {
            task.is_completed = true;
            task.completed_at = task.completed_at || new Date();
          }
        }
      }
    }

    task.updated_by = uid;
    await task.save();

    for (const [field, oldV, newV] of changes) {
      await logActivity({
        companyId,
        taskId: task._id,
        boardId: task.board_id,
        userId: uid,
        action: `task_${field}_changed`,
        old_value: oldV,
        new_value: newV,
      });
    }

    const data = await Task.findById(task._id)
      .populate("assignee_ids", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .populate("column_id", "name color")
      .lean();

    return res.status(200).json({
      success: true,
      status: 200,
      data: serializeTaskCard(data),
    });
  } catch (error) {
    console.error("❌ task updateTask:", error);
    return errRes(res, 500, error.message || "Failed to update task");
  }
}

async function moveTask(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.params.id);
    const uid = userId(req);

    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");

    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const newColumnId = oid(req.body.column_id) || task.column_id;
    const column = await TaskColumn.findOne({
      _id: newColumnId,
      board_id: task.board_id,
      company_id: companyId,
      deletedAt: null,
    });
    if (!column) return errRes(res, 400, "Target column not found");

    const beforeId = oid(req.body.before_task_id);
    const afterId = oid(req.body.after_task_id);
    let beforePos = null;
    let afterPos = null;

    if (beforeId) {
      const before = await Task.findOne({
        _id: beforeId,
        company_id: companyId,
        column_id: newColumnId,
        deletedAt: null,
      }).select("position");
      beforePos = before?.position ?? null;
    }
    if (afterId) {
      const after = await Task.findOne({
        _id: afterId,
        company_id: companyId,
        column_id: newColumnId,
        deletedAt: null,
      }).select("position");
      afterPos = after?.position ?? null;
    }

    if (beforePos == null && afterPos == null && req.body.position != null) {
      task.position = Number(req.body.position);
    } else if (beforePos == null && afterPos == null) {
      const last = await Task.findOne({
        company_id: companyId,
        column_id: newColumnId,
        deletedAt: null,
        _id: { $ne: task._id },
      })
        .sort({ position: -1 })
        .select("position");
      task.position = nextTailPosition(last?.position);
    } else {
      const next = midPosition(beforePos, afterPos);
      if (needsRebalance(beforePos, afterPos)) {
        const siblings = await Task.find({
          company_id: companyId,
          column_id: newColumnId,
          deletedAt: null,
          _id: { $ne: task._id },
        })
          .sort({ position: 1 })
          .select("_id position");
        // insert conceptually between before/after by id order
        const ordered = [];
        let inserted = false;
        for (const s of siblings) {
          if (afterId && String(s._id) === String(afterId) && !inserted) {
            ordered.push({ _id: task._id });
            inserted = true;
          }
          ordered.push(s);
          if (beforeId && String(s._id) === String(beforeId) && !inserted) {
            ordered.push({ _id: task._id });
            inserted = true;
          }
        }
        if (!inserted) ordered.push({ _id: task._id });
        const updates = rebalancePositions(ordered);
        await Promise.all(
          updates.map((u) =>
            Task.updateOne(
              { _id: u._id, company_id: companyId },
              { $set: { position: u.position, column_id: newColumnId } },
            ),
          ),
        );
        const refreshed = await Task.findById(task._id)
          .populate("assignee_ids", USER_SELECT)
          .populate("created_by", USER_SELECT)
          .lean();
        return res.status(200).json({
          success: true,
          status: 200,
          data: serializeTaskCard(refreshed),
        });
      }
      task.position = next;
    }

    const oldColumn = task.column_id;
    task.column_id = newColumnId;
    task.status = column.name;
    if (/^done$/i.test(column.name)) {
      task.is_completed = true;
      task.completed_at = task.completed_at || new Date();
    }
    task.updated_by = uid;
    await task.save();

    if (String(oldColumn) !== String(newColumnId)) {
      await logActivity({
        companyId,
        taskId: task._id,
        boardId: task.board_id,
        userId: uid,
        action: "task_moved",
        old_value: oldColumn,
        new_value: newColumnId,
        metadata: { column_name: column.name },
      });
    }

    const data = await Task.findById(task._id)
      .populate("assignee_ids", USER_SELECT)
      .populate("created_by", USER_SELECT)
      .lean();

    return res.status(200).json({
      success: true,
      status: 200,
      data: serializeTaskCard(data),
    });
  } catch (error) {
    console.error("❌ task moveTask:", error);
    return errRes(res, 500, error.message || "Failed to move task");
  }
}

async function reorderTasks(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const columnId = oid(req.body.column_id);
    const orderedIds = (req.body.task_ids || []).map(oid).filter(Boolean);
    if (!columnId || !orderedIds.length) {
      return errRes(res, 400, "column_id and task_ids are required");
    }

    const column = await TaskColumn.findOne({
      _id: columnId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!column) return errRes(res, 404, "Column not found");
    const board = await loadBoard(companyId, column.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const updates = rebalancePositions(orderedIds.map((id) => ({ _id: id })));
    await Promise.all(
      updates.map((u) =>
        Task.updateOne(
          { _id: u._id, company_id: companyId },
          {
            $set: {
              position: u.position,
              column_id: columnId,
              status: column.name,
            },
          },
        ),
      ),
    );

    return res.status(200).json({ success: true, status: 200, message: "Reordered" });
  } catch (error) {
    console.error("❌ task reorderTasks:", error);
    return errRes(res, 500, error.message || "Failed to reorder tasks");
  }
}

async function bulkTasks(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const ids = (req.body.task_ids || []).map(oid).filter(Boolean);
    const action = req.body.action;
    if (!ids.length || !action) return errRes(res, 400, "task_ids and action required");

    const tasks = await Task.find({
      _id: { $in: ids },
      company_id: companyId,
      deletedAt: null,
    });
    if (!tasks.length) return errRes(res, 404, "No tasks found");

    // Verify board access for first task's board (assume same board bulk)
    const board = await loadBoard(companyId, tasks[0].board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const uid = userId(req);
    const $set = { updated_by: uid };

    if (action === "assign") {
      const assignees = await validateAssignees(companyId, req.body.assignee_ids || []);
      $set.assignee_ids = assignees;
    } else if (action === "priority") {
      if (!PRIORITY_VALUES.includes(req.body.priority)) {
        return errRes(res, 400, "Invalid priority");
      }
      $set.priority = req.body.priority;
    } else if (action === "move") {
      const columnId = oid(req.body.column_id);
      const column = await TaskColumn.findOne({
        _id: columnId,
        company_id: companyId,
        deletedAt: null,
      });
      if (!column) return errRes(res, 400, "Column not found");
      $set.column_id = columnId;
      $set.status = column.name;
    } else if (action === "add_label") {
      await Task.updateMany(
        { _id: { $in: ids }, company_id: companyId },
        { $addToSet: { labels: req.body.label }, $set: { updated_by: uid } },
      );
      return res.status(200).json({ success: true, status: 200, message: "Updated" });
    } else if (action === "remove_label") {
      await Task.updateMany(
        { _id: { $in: ids }, company_id: companyId },
        { $pull: { labels: req.body.label }, $set: { updated_by: uid } },
      );
      return res.status(200).json({ success: true, status: 200, message: "Updated" });
    } else if (action === "complete") {
      $set.is_completed = true;
      $set.completed_at = new Date();
    } else if (action === "archive") {
      if (!requirePerm(req, res, "delete")) return;
      $set.is_archived = true;
    } else if (action === "delete") {
      if (!modulePerms(req).delete) return errRes(res, 403, "Missing tasks.delete");
      $set.deletedAt = new Date();
      $set.is_archived = true;
    } else {
      return errRes(res, 400, "Unknown bulk action");
    }

    await Task.updateMany(
      { _id: { $in: ids }, company_id: companyId },
      { $set },
    );

    return res.status(200).json({ success: true, status: 200, message: "Updated" });
  } catch (error) {
    console.error("❌ task bulkTasks:", error);
    return errRes(res, 500, error.message || "Failed bulk update");
  }
}

async function archiveTask(req, res) {
  try {
    if (!requirePerm(req, res, "delete")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    task.is_archived = true;
    task.updated_by = userId(req);
    await task.save();
    await logActivity({
      companyId,
      taskId: task._id,
      boardId: task.board_id,
      userId: userId(req),
      action: "task_archived",
    });
    return res.status(200).json({ success: true, status: 200, data: task });
  } catch (error) {
    console.error("❌ task archiveTask:", error);
    return errRes(res, 500, error.message || "Failed to archive task");
  }
}

async function deleteTask(req, res) {
  try {
    if (!requirePerm(req, res, "delete")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    task.deletedAt = new Date();
    task.is_archived = true;
    task.updated_by = userId(req);
    await task.save();
    await logActivity({
      companyId,
      taskId: task._id,
      boardId: task.board_id,
      userId: userId(req),
      action: "task_deleted",
    });
    return res.status(200).json({ success: true, status: 200, message: "Deleted" });
  } catch (error) {
    console.error("❌ task deleteTask:", error);
    return errRes(res, 500, error.message || "Failed to delete task");
  }
}

// ─── Comments ─────────────────────────────────────────────────────────

async function addComment(req, res) {
  try {
    if (!requirePerm(req, res, "add")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.params.id);
    const body = String(req.body.body || req.body.message || "").trim();
    if (!body) return errRes(res, 400, "Comment body is required");

    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const mentionNames = extractMentions(body);
    const mentions = await resolveMentionIds(companyId, mentionNames);
    const uid = userId(req);

    const comment = await TaskComment.create({
      company_id: companyId,
      task_id: taskId,
      user_id: uid,
      body,
      mentions,
    });

    task.comments_count = (task.comments_count || 0) + 1;
    await task.save();

    await logActivity({
      companyId,
      taskId,
      boardId: task.board_id,
      userId: uid,
      action: "comment_added",
      new_value: body.slice(0, 200),
      metadata: { mentions },
    });

    const data = await TaskComment.findById(comment._id)
      .populate("user_id", USER_SELECT)
      .lean();
    return res.status(201).json({ success: true, status: 201, data });
  } catch (error) {
    console.error("❌ task addComment:", error);
    return errRes(res, 500, error.message || "Failed to add comment");
  }
}

async function updateComment(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const comment = await TaskComment.findOne({
      _id: oid(req.params.commentId),
      task_id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!comment) return errRes(res, 404, "Comment not found");
    if (String(comment.user_id) !== String(userId(req)) && !isAdmin(req)) {
      return errRes(res, 403, "Can only edit own comments");
    }

    const body = String(req.body.body || "").trim();
    if (!body) return errRes(res, 400, "Comment body is required");
    comment.body = body;
    comment.is_edited = true;
    comment.mentions = await resolveMentionIds(companyId, extractMentions(body));
    await comment.save();

    const data = await TaskComment.findById(comment._id)
      .populate("user_id", USER_SELECT)
      .lean();
    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task updateComment:", error);
    return errRes(res, 500, error.message || "Failed to update comment");
  }
}

async function deleteComment(req, res) {
  try {
    const perms = modulePerms(req);
    if (!perms.delete && !perms.edit) {
      return errRes(res, 403, "Missing tasks.edit or tasks.delete permission");
    }
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const comment = await TaskComment.findOne({
      _id: oid(req.params.commentId),
      task_id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!comment) return errRes(res, 404, "Comment not found");
    if (String(comment.user_id) !== String(userId(req)) && !isAdmin(req)) {
      return errRes(res, 403, "Can only delete own comments");
    }

    comment.deletedAt = new Date();
    await comment.save();
    await Task.updateOne(
      { _id: comment.task_id, company_id: companyId },
      { $inc: { comments_count: -1 } },
    );
    return res.status(200).json({ success: true, status: 200, message: "Deleted" });
  } catch (error) {
    console.error("❌ task deleteComment:", error);
    return errRes(res, 500, error.message || "Failed to delete comment");
  }
}

// ─── Checklists ───────────────────────────────────────────────────────

async function addChecklist(req, res) {
  try {
    if (!requirePerm(req, res, "add")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    task.checklists.push({
      title: String(req.body.title || "Checklist").trim(),
      items: Array.isArray(req.body.items) ? req.body.items : [],
    });
    task.updated_by = userId(req);
    await task.save();

    await logActivity({
      companyId,
      taskId: task._id,
      boardId: task.board_id,
      userId: userId(req),
      action: "checklist_added",
      new_value: req.body.title || "Checklist",
    });

    return res.status(201).json({ success: true, status: 201, data: task.checklists });
  } catch (error) {
    console.error("❌ task addChecklist:", error);
    return errRes(res, 500, error.message || "Failed to add checklist");
  }
}

async function updateChecklist(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const checklist = task.checklists.id(req.params.checklistId);
    if (!checklist) return errRes(res, 404, "Checklist not found");

    if (req.body.title != null) checklist.title = String(req.body.title).trim();
    if (Array.isArray(req.body.items)) checklist.items = req.body.items;

    // item-level ops
    if (req.body.add_item) {
      checklist.items.push({
        title: String(req.body.add_item.title || req.body.add_item).trim(),
        is_completed: false,
        position: (checklist.items.length + 1) * POSITION_GAP,
      });
    }
    if (req.body.toggle_item_id) {
      const item = checklist.items.id(req.body.toggle_item_id);
      if (item) item.is_completed = !item.is_completed;
    }
    if (req.body.update_item_id && req.body.item_title != null) {
      const item = checklist.items.id(req.body.update_item_id);
      if (item) item.title = String(req.body.item_title).trim();
    }
    if (req.body.delete_item_id) {
      checklist.items.id(req.body.delete_item_id)?.deleteOne();
    }

    task.updated_by = userId(req);
    await task.save();

    await logActivity({
      companyId,
      taskId: task._id,
      boardId: task.board_id,
      userId: userId(req),
      action: "checklist_updated",
    });

    return res.status(200).json({ success: true, status: 200, data: task.checklists });
  } catch (error) {
    console.error("❌ task updateChecklist:", error);
    return errRes(res, 500, error.message || "Failed to update checklist");
  }
}

async function deleteChecklist(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    task.checklists.id(req.params.checklistId)?.deleteOne();
    task.updated_by = userId(req);
    await task.save();
    return res.status(200).json({ success: true, status: 200, data: task.checklists });
  } catch (error) {
    console.error("❌ task deleteChecklist:", error);
    return errRes(res, 500, error.message || "Failed to delete checklist");
  }
}

// ─── Attachments / Activity / Seed ────────────────────────────────────

async function uploadAttachment(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.body.task_id || req.params.id);
    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const files = req.files?.file || req.files?.files || req.files?.attachment;
    if (!files) return errRes(res, 400, "No file uploaded");

    const saved = await saveTaskFiles(files, {
      companyId,
      taskId,
      uploadedBy: userId(req),
      req,
    });
    task.attachments.push(...saved);
    task.updated_by = userId(req);
    await task.save();

    await logActivity({
      companyId,
      taskId,
      boardId: task.board_id,
      userId: userId(req),
      action: "attachment_added",
      new_value: saved.map((f) => f.name),
    });

    return res.status(201).json({
      success: true,
      status: 201,
      data: task.attachments,
    });
  } catch (error) {
    console.error("❌ task uploadAttachment:", error);
    return errRes(res, 500, error.message || "Failed to upload attachment");
  }
}

async function deleteAttachment(req, res) {
  try {
    if (!requirePerm(req, res, "edit")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const task = await Task.findOne({
      _id: oid(req.params.id),
      company_id: companyId,
      deletedAt: null,
    });
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const att = task.attachments.id(req.params.attachmentId);
    if (!att) return errRes(res, 404, "Attachment not found");
    safeUnlinkAttachment(att.path);
    att.deleteOne();
    task.updated_by = userId(req);
    await task.save();
    return res.status(200).json({ success: true, status: 200, data: task.attachments });
  } catch (error) {
    console.error("❌ task deleteAttachment:", error);
    return errRes(res, 500, error.message || "Failed to delete attachment");
  }
}

async function getActivity(req, res) {
  try {
    if (!requirePerm(req, res, "view")) return;
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const taskId = oid(req.params.id);
    const task = await Task.findOne({
      _id: taskId,
      company_id: companyId,
      deletedAt: null,
    }).select("board_id");
    if (!task) return errRes(res, 404, "Task not found");
    const board = await loadBoard(companyId, task.board_id);
    if (!canAccessBoard(req, board)) return errRes(res, 403, "Not a board member");

    const data = await TaskActivity.find({
      task_id: taskId,
      company_id: companyId,
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate("user_id", USER_SELECT)
      .lean();

    return res.status(200).json({ success: true, status: 200, data });
  } catch (error) {
    console.error("❌ task getActivity:", error);
    return errRes(res, 500, error.message || "Failed to load activity");
  }
}

async function seedDemo(req, res) {
  try {
    if (!isAdmin(req) && !modulePerms(req).add) {
      return errRes(res, 403, "Not allowed");
    }
    const companyId = resolveTenantCompanyId(req);
    if (!companyId) return errRes(res, 400, "company_id is required");
    const uid = userId(req);

    const existing = await TaskBoard.findOne({
      company_id: companyId,
      name: "POS Development",
      deletedAt: null,
    });
    if (existing && req.query.force !== "true") {
      return res.status(200).json({
        success: true,
        status: 200,
        data: existing,
        message: "POS Development board already exists",
      });
    }

    const users = await User.find({
      company_id: companyId,
      deletedAt: null,
    })
      .select("_id")
      .limit(10)
      .lean();
    const memberIds = users.map((u) => u._id);
    if (!memberIds.some((m) => String(m) === String(uid))) memberIds.unshift(uid);

    const board = await TaskBoard.create({
      company_id: companyId,
      name: "POS Development",
      description: "Demo Kanban board for POS development tasks",
      color: "#0d6efd",
      icon: "code",
      created_by: uid,
      members: memberIds,
      updated_by: uid,
    });

    const cols = [];
    for (let i = 0; i < DEFAULT_COLUMNS.length; i++) {
      const c = DEFAULT_COLUMNS[i];
      cols.push(
        await TaskColumn.create({
          company_id: companyId,
          board_id: board._id,
          name: c.name,
          color: c.color,
          position: (i + 1) * POSITION_GAP,
        }),
      );
    }

    const sample = [
      { title: "Implement product search", priority: "high", col: 1 },
      { title: "Fix inventory calculation", priority: "urgent", col: 2 },
      { title: "Create customer module", priority: "medium", col: 0 },
      { title: "Implement purchase order", priority: "high", col: 2 },
      { title: "Add payment methods", priority: "medium", col: 3 },
      { title: "Create sales reports", priority: "low", col: 1 },
      { title: "Fix POS checkout bug", priority: "urgent", col: 2 },
    ];

    for (let i = 0; i < sample.length; i++) {
      const s = sample[i];
      const assignee = memberIds[i % memberIds.length];
      const num = await nextTaskNumber(companyId);
      await Task.create({
        company_id: companyId,
        board_id: board._id,
        column_id: cols[s.col]._id,
        title: s.title,
        description: `Demo task: ${s.title}`,
        task_number: num,
        priority: s.priority,
        status: cols[s.col].name,
        assignee_ids: assignee ? [assignee] : [],
        created_by: uid,
        labels: ["POS", "Demo"],
        due_date: new Date(Date.now() + (i + 1) * 86400000),
        position: (i + 1) * POSITION_GAP,
        checklists: [
          {
            title: "Checklist",
            items: [
              { title: "Spec", is_completed: true, position: 1000 },
              { title: "Implement", is_completed: false, position: 2000 },
              { title: "Test", is_completed: false, position: 3000 },
            ],
          },
        ],
        updated_by: uid,
      });
    }

    return res.status(201).json({
      success: true,
      status: 201,
      data: { board_id: board._id },
      message: "Seeded POS Development board",
    });
  } catch (error) {
    console.error("❌ task seedDemo:", error);
    return errRes(res, 500, error.message || "Failed to seed");
  }
}

module.exports = {
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  archiveBoard,
  deleteBoard,
  duplicateBoard,
  addBoardMember,
  removeBoardMember,
  listColumns,
  createColumn,
  updateColumn,
  archiveColumn,
  reorderColumns,
  listTasks,
  getBoardKanban,
  getTask,
  createTask,
  updateTask,
  moveTask,
  reorderTasks,
  bulkTasks,
  archiveTask,
  deleteTask,
  addComment,
  updateComment,
  deleteComment,
  addChecklist,
  updateChecklist,
  deleteChecklist,
  uploadAttachment,
  deleteAttachment,
  getActivity,
  seedDemo,
  DEFAULT_COLUMNS,
  PRIORITY_VALUES,
};

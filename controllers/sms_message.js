const SmsMessage = require("../models/sms_message");
const {
  coalesceObjectId,
  activeNotDeletedCriteria,
} = require("../utils/modelHelper");
const { invalidateModuleListCachesForReq } = require("../utils/redisCache");

const MAX_FETCH_ATTEMPTS = 10;

function resolveCompanyId(req) {
  return coalesceObjectId(
    req.query?.company_id || req.body?.company_id || req.user?.company_id,
  );
}

function parseSkipLimit(query = {}) {
  const limitRaw = parseInt(query.limit, 10);
  const skipRaw = parseInt(query.skip, 10);
  const pageRaw = parseInt(query.page, 10);

  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
  let skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? skipRaw : 0;
  if ((!Number.isFinite(skipRaw) || skipRaw < 0) && Number.isFinite(pageRaw) && pageRaw > 0) {
    skip = (pageRaw - 1) * limit;
  }
  return { skip, limit, page: Math.floor(skip / limit) + 1 };
}

function onHoldFilter(companyId) {
  const filter = {
    status: "on_hold",
    $and: [activeNotDeletedCriteria()],
  };
  if (companyId) filter.company_id = companyId;
  return filter;
}

/**
 * GET /api/sms_message/on-hold
 * GET /api/sms_message/list-on-hold
 *
 * Lists on_hold SMS messages with total count and pagination.
 * Query: company_id (required unless Bearer has company), skip, limit, page, search
 */
async function listOnHoldSmsMessages(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const { skip, limit, page } = parseSkipLimit(req.query);
    const filter = onHoldFilter(companyId);

    const search = String(req.query.search || "").trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { number: { $regex: escaped, $options: "i" } },
        { message: { $regex: escaped, $options: "i" } },
      ];
    }

    const [total, data] = await Promise.all([
      SmsMessage.countDocuments(filter),
      SmsMessage.find(filter)
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      status: 200,
      message: "On-hold SMS messages",
      data,
      count: total,
      pagination: {
        total,
        count: data.length,
        skip,
        limit,
        page,
        totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      },
    });
  } catch (error) {
    console.error("❌ listOnHoldSmsMessages:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to list on-hold SMS messages",
    });
  }
}

/**
 * GET /api/sms_message/fetch-random?company_id=...
 *
 * Picks one random on_hold message and atomically marks it processing.
 * Returns data: null when the queue is empty.
 */
async function fetchRandomSmsMessage(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const skippedIds = [];

    for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
      const match = onHoldFilter(companyId);
      if (skippedIds.length) {
        match._id = { $nin: skippedIds };
      }

      const rows = await SmsMessage.aggregate([
        { $match: match },
        { $sample: { size: 1 } },
      ]);
      const sampled = rows[0] || null;
      if (!sampled) break;

      const update = { status: "processing" };
      if (req.user?._id) {
        update.updated_by = coalesceObjectId(req.user._id);
      }

      const claimed = await SmsMessage.findOneAndUpdate(
        {
          _id: sampled._id,
          status: "on_hold",
          deletedAt: null,
          company_id: companyId,
        },
        { $set: update },
        { new: true, runValidators: true },
      ).lean();

      if (!claimed) {
        skippedIds.push(sampled._id);
        continue;
      }

      return res.status(200).json({
        success: true,
        status: 200,
        message: "On-hold SMS message claimed for processing",
        data: claimed,
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "No on-hold SMS messages",
      data: null,
      skipped_count: skippedIds.length,
    });
  } catch (error) {
    console.error("❌ fetchRandomSmsMessage:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to fetch SMS message",
    });
  }
}

/**
 * GET|PATCH|POST /api/sms_message/mark-sent/:id?company_id=...
 *
 * Marks a processing SMS message as sent.
 */
async function markSmsMessageSent(req, res) {
  try {
    const messageId = coalesceObjectId(req.params?.id);
    if (!messageId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Message id is required",
      });
    }

    const companyId = resolveCompanyId(req);
    const filter = {
      _id: messageId,
      status: "processing",
      $and: [activeNotDeletedCriteria()],
    };
    if (companyId) {
      filter.company_id = companyId;
    }

    const update = { status: "sent" };
    if (req.user?._id) {
      update.updated_by = coalesceObjectId(req.user._id);
    }

    const updated = await SmsMessage.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updated) {
      return res.status(404).json({
        success: false,
        status: 404,
        message:
          "SMS message not found, or it is not in processing status",
      });
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message: "SMS message marked as sent",
      data: updated,
    });
  } catch (error) {
    console.error("❌ markSmsMessageSent:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to mark SMS message as sent",
    });
  }
}

const BULK_STATUSES = new Set(["on_hold", "processing", "sent", "failed"]);
const MAX_BULK_SMS = 5000;
const BULK_INSERT_CHUNK = 500;

function normalizeBulkSmsNumber(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits;
}

function isValidBulkSmsNumber(digits) {
  return digits.length >= 10 && digits.length <= 15;
}

function rawBulkRows(body = {}) {
  const sharedMessage = String(body.message || "").trim();
  const sharedStatus = String(body.status || "on_hold").trim() || "on_hold";
  const numbers = Array.isArray(body.numbers) ? body.numbers : null;
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.messages)
      ? body.messages
      : null;
  const source = numbers || items || [];
  return source.map((entry) => {
    if (entry && typeof entry === "object") {
      return {
        number: entry.number ?? entry.phone ?? entry.to,
        message: entry.message != null ? String(entry.message) : sharedMessage,
        status: entry.status || sharedStatus,
      };
    }
    return { number: entry, message: sharedMessage, status: sharedStatus };
  });
}

/**
 * Turn a bulk-create body into insertable sms_message docs.
 * Duplicate and invalid numbers are skipped; they are not inserted.
 */
function prepareSmsBulkDocuments(body, { companyId, userId } = {}) {
  const rows = rawBulkRows(body);
  const seen = new Set();
  const docs = [];
  const errors = [];
  let skipped = 0;

  if (rows.length > MAX_BULK_SMS) {
    return {
      docs: [],
      skipped: 0,
      errors: [`Send at most ${MAX_BULK_SMS} numbers at once.`],
      tooMany: true,
    };
  }

  for (const row of rows) {
    const rawNumber = String(row.number ?? "").trim();
    const number = normalizeBulkSmsNumber(rawNumber);
    const message = String(row.message || "").trim();
    const status = String(row.status || "on_hold").trim() || "on_hold";
    const label = rawNumber || "(blank)";

    if (!isValidBulkSmsNumber(number)) {
      skipped += 1;
      if (errors.length < 20) errors.push(`${label}: invalid number`);
      continue;
    }
    if (!BULK_STATUSES.has(status)) {
      skipped += 1;
      if (errors.length < 20) errors.push(`${label}: invalid status`);
      continue;
    }
    if (!message) {
      skipped += 1;
      if (errors.length < 20) errors.push(`${label}: message is required`);
      continue;
    }
    if (seen.has(number)) {
      skipped += 1;
      continue;
    }
    seen.add(number);
    const doc = {
      number,
      message,
      status,
      company_id: companyId,
      deletedAt: null,
    };
    if (userId) doc.created_by = userId;
    docs.push(doc);
  }

  return { docs, skipped, errors, tooMany: false };
}

/**
 * POST /api/sms_message/bulk-create
 * POST /api/sms_messages/bulk-create
 *
 * Body: { message, status?, numbers: ["03...", "923..."] }
 * Also accepts items: [{ number, message?, status? }].
 * Inserts the whole list in one request instead of one create per number.
 */
async function bulkCreateSmsMessages(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const userId = req.user?._id ? coalesceObjectId(req.user._id) : null;
    const prepared = prepareSmsBulkDocuments(req.body, {
      companyId,
      userId: userId || undefined,
    });

    if (prepared.tooMany) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: prepared.errors[0],
        saved: 0,
        failed: 0,
        skipped: 0,
        errors: prepared.errors,
      });
    }

    if (!prepared.docs.length) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: prepared.errors[0] || "Add at least one valid number",
        saved: 0,
        failed: 0,
        skipped: prepared.skipped,
        errors: prepared.errors,
      });
    }

    let saved = 0;
    for (let i = 0; i < prepared.docs.length; i += BULK_INSERT_CHUNK) {
      const chunk = prepared.docs.slice(i, i + BULK_INSERT_CHUNK);
      const inserted = await SmsMessage.insertMany(chunk, { ordered: true });
      saved += inserted.length;
    }

    return res.status(201).json({
      success: true,
      status: 201,
      message: `Saved ${saved} SMS message${saved === 1 ? "" : "s"}`,
      saved,
      failed: 0,
      skipped: prepared.skipped,
      errors: prepared.errors,
    });
  } catch (error) {
    console.error("❌ bulkCreateSmsMessages:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to save SMS messages",
      saved: 0,
      failed: 0,
      errors: [error.message || "Failed to save SMS messages"],
    });
  }
}

const MAX_BULK_DELETE = 5000;

/** Keep valid, unique message ids. Invalid values are counted and dropped. */
function collectSmsMessageIds(values) {
  const ids = [];
  const seen = new Set();
  let skipped = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const id = coalesceObjectId(value);
    const key = id == null ? "" : String(id).trim();
    if (!/^[a-f0-9]{24}$/i.test(key)) {
      skipped += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(key);
  }
  return { ids, skipped };
}

/**
 * POST /api/sms_message/bulk-delete
 * POST /api/sms_messages/bulk-delete
 *
 * Body: { ids: ["..."] }
 * Soft-deletes the selected messages for the signed-in company.
 */
async function bulkDeleteSmsMessages(req, res) {
  try {
    const companyId = resolveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "company_id is required",
      });
    }

    const raw = req.body?.ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "Select at least one SMS message",
        deleted: 0,
      });
    }
    if (raw.length > MAX_BULK_DELETE) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: `Delete at most ${MAX_BULK_DELETE} messages at once`,
        deleted: 0,
      });
    }

    const { ids, skipped } = collectSmsMessageIds(raw);
    if (!ids.length) {
      return res.status(400).json({
        success: false,
        status: 400,
        message: "No valid message ids",
        deleted: 0,
        skipped,
      });
    }

    const update = { deletedAt: new Date() };
    const userId = req.user?._id ? coalesceObjectId(req.user._id) : null;
    if (userId) update.updated_by = userId;

    const result = await SmsMessage.updateMany(
      {
        _id: { $in: ids },
        company_id: companyId,
        $and: [activeNotDeletedCriteria()],
      },
      { $set: update },
    );
    const deleted = result.modifiedCount ?? result.nModified ?? 0;

    try {
      await invalidateModuleListCachesForReq(req, "sms_message");
    } catch (cacheError) {
      console.error("❌ bulkDeleteSmsMessages cache:", cacheError);
    }

    return res.status(200).json({
      success: true,
      status: 200,
      message:
        deleted === 1
          ? "Deleted 1 SMS message"
          : `Deleted ${deleted} SMS messages`,
      deleted,
      skipped: skipped + (ids.length - deleted),
    });
  } catch (error) {
    console.error("❌ bulkDeleteSmsMessages:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      message: error.message || "Failed to delete SMS messages",
      deleted: 0,
    });
  }
}

module.exports = {
  listOnHoldSmsMessages,
  fetchRandomSmsMessage,
  markSmsMessageSent,
  bulkCreateSmsMessages,
  prepareSmsBulkDocuments,
  bulkDeleteSmsMessages,
  collectSmsMessageIds,
};

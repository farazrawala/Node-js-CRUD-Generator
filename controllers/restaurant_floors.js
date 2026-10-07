const mongoose = require("mongoose");
const RestaurantFloor = require("../models/restaurant_floors");
const {
  coalesceObjectId,
  handleGenericCreate,
  handleGenericUpdate,
} = require("../utils/modelHelper");
const { invalidateModuleListCachesForReq } = require("../utils/redisCache");

const LIST_CACHE_MODULE = "restaurant_floors";

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tables / fixtures may arrive as a JSON string (multipart forms). */
function parseJsonArrayFields(body) {
  for (const key of ["tables", "fixtures"]) {
    if (typeof body?.[key] === "string") {
      try {
        const parsed = JSON.parse(body[key]);
        body[key] = Array.isArray(parsed) ? parsed : [];
      } catch {
        body[key] = [];
      }
    }
  }
}

/** Another live floor in this company + branch already has this name? */
async function floorNameTaken(req, name, branchId, exceptId = null) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return false;
  const filter = {
    company_id: coalesceObjectId(req.user?.company_id),
    branch_id: coalesceObjectId(branchId) || null,
    deletedAt: null,
    name: new RegExp(`^${escapeRegex(trimmed)}$`, "i"),
  };
  if (exceptId) filter._id = { $ne: exceptId };
  return Boolean(await RestaurantFloor.exists(filter));
}

const duplicateNameResponse = (name) => ({
  success: false,
  status: 409,
  error: "Duplicate floor",
  message: `A floor named “${String(name).trim()}” already exists.`,
});

async function restaurantFloorCreate(req, res) {
  parseJsonArrayFields(req.body);
  if (await floorNameTaken(req, req.body?.name, req.body?.branch_id)) {
    const response = duplicateNameResponse(req.body.name);
    return res.status(response.status).json(response);
  }
  const response = await handleGenericCreate(req, "restaurant_floors", {
    afterCreate: async (record, req) => {
      await invalidateModuleListCachesForReq(req, LIST_CACHE_MODULE);
    },
  });
  return res.status(response.status).json(response);
}

async function restaurantFloorUpdate(req, res) {
  parseJsonArrayFields(req.body);
  const floorId = req.params?.id;
  if (req.body?.name !== undefined && mongoose.Types.ObjectId.isValid(String(floorId))) {
    const existing = await RestaurantFloor.findOne({
      _id: floorId,
      company_id: coalesceObjectId(req.user?.company_id),
    })
      .select("branch_id")
      .lean();
    const branchId = req.body.branch_id !== undefined ? req.body.branch_id : existing?.branch_id;
    if (existing && (await floorNameTaken(req, req.body.name, branchId, floorId))) {
      const response = duplicateNameResponse(req.body.name);
      return res.status(response.status).json(response);
    }
  }
  const response = await handleGenericUpdate(req, "restaurant_floors", {
    afterUpdate: async (record, req) => {
      await invalidateModuleListCachesForReq(req, LIST_CACHE_MODULE);
    },
  });
  return res.status(response.status).json(response);
}

/**
 * PATCH /restaurant_floors/table-status/:tableId  { status: "free" | "reserved" | "cleaning" }
 * POS shortcut (Reserve, Mark clean) — updates one table without resending the floor.
 */
async function restaurantTableStatusUpdate(req, res) {
  const tableId = req.params?.tableId;
  const status = String(req.body?.status ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(String(tableId))) {
    return res.status(400).json({ success: false, status: 400, message: "Invalid table id" });
  }
  if (!RestaurantFloor.TABLE_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      status: 400,
      message: `status must be one of: ${RestaurantFloor.TABLE_STATUSES.join(", ")}`,
    });
  }
  try {
    const floor = await RestaurantFloor.findOneAndUpdate(
      {
        company_id: coalesceObjectId(req.user?.company_id),
        deletedAt: null,
        "tables._id": tableId,
      },
      {
        $set: {
          "tables.$.status": status,
          ...(req.user?._id ? { updated_by: req.user._id } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!floor) {
      return res.status(404).json({ success: false, status: 404, message: "Table not found" });
    }
    await invalidateModuleListCachesForReq(req, LIST_CACHE_MODULE);
    const table = floor.tables.find((t) => String(t._id) === String(tableId));
    return res.status(200).json({
      success: true,
      status: 200,
      data: { floor_id: floor._id, table },
    });
  } catch (err) {
    console.error("❌ Table status update error:", err);
    return res.status(500).json({ success: false, status: 500, message: err.message });
  }
}

module.exports = {
  restaurantFloorCreate,
  restaurantFloorUpdate,
  restaurantTableStatusUpdate,
};

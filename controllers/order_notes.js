const mongoose = require("mongoose");
const OrderNotes = require("../models/order_notes");
const { coalesceObjectId } = require("../utils/modelHelper");

const MAX_ORDER_IDS = 200;

/**
 * GET /order_notes/latest?order_ids=id1,id2,…
 * Newest note per order (with author name) for the OMS list rows.
 */
async function getLatestOrderNotes(req, res) {
  try {
    const orderIds = [
      ...new Set(
        String(req.query.order_ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length === 24 && mongoose.Types.ObjectId.isValid(id)),
      ),
    ]
      .slice(0, MAX_ORDER_IDS)
      .map((id) => new mongoose.Types.ObjectId(id));

    if (!orderIds.length) {
      return res.status(200).json({ success: true, status: 200, data: [] });
    }

    const match = { order_id: { $in: orderIds }, deletedAt: null, status: "active" };
    const companyId = coalesceObjectId(req.user?.company_id);
    if (companyId) {
      match.company_id = new mongoose.Types.ObjectId(String(companyId));
    }

    const data = await OrderNotes.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$order_id",
          note_id: { $first: "$_id" },
          note: { $first: "$note" },
          type: { $first: "$type" },
          createdAt: { $first: "$createdAt" },
          created_by: { $first: "$created_by" },
        },
      },
      { $lookup: { from: "users", localField: "created_by", foreignField: "_id", as: "author" } },
      {
        $project: {
          _id: "$note_id",
          order_id: "$_id",
          note: 1,
          type: 1,
          createdAt: 1,
          created_by: {
            $let: {
              vars: { author: { $arrayElemAt: ["$author", 0] } },
              in: { _id: "$$author._id", name: "$$author.name" },
            },
          },
        },
      },
    ]);

    return res.status(200).json({ success: true, status: 200, data });
  } catch (err) {
    console.error("[order_notes] latest failed:", err.message);
    return res.status(500).json({ success: false, status: 500, error: err.message });
  }
}

module.exports = { getLatestOrderNotes };

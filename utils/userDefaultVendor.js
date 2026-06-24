const User = require("../models/user");
const { coalesceObjectId } = require("./modelHelper");

function userRolesList(user) {
  if (!user?.role) return [];
  return Array.isArray(user.role) ? user.role : [user.role];
}

function parseBooleanFlag(value) {
  if (value === true || value === "true" || value === 1 || value === "1") {
    return true;
  }
  if (value === false || value === "false" || value === 0 || value === "0") {
    return false;
  }
  return undefined;
}

function userHasRole(userOrRoles, role) {
  const roles = Array.isArray(userOrRoles)
    ? userOrRoles
    : userRolesList(userOrRoles);
  const target = String(role || "").toUpperCase();
  return roles.some((r) => String(r).toUpperCase() === target);
}

function resolveMergedRoles(existingUser, updateData) {
  if (updateData?.role !== undefined) {
    return userRolesList({ role: updateData.role });
  }
  return userRolesList(existingUser);
}

/**
 * Validate mark_as_default_vendor on create/update.
 * Returns `{ success: false, status, message }` or null when valid.
 */
function validateDefaultVendorFlag(updateData, existingUser) {
  const vendorFlag = parseBooleanFlag(updateData?.mark_as_default_vendor);
  if (vendorFlag !== true) return null;

  const roles = resolveMergedRoles(existingUser, updateData);
  if (!userHasRole(roles, "VENDOR")) {
    return {
      success: false,
      status: 400,
      error: "Invalid role",
      message: "Only users with the VENDOR role can be marked as default vendor.",
    };
  }

  return null;
}

/**
 * When one user is default vendor, clear the flag on all other users in the same company.
 * @param {import("mongoose").ClientSession | null} [session]
 */
async function syncDefaultVendorFlag(userDoc, session = null) {
  const userId = coalesceObjectId(userDoc?._id);
  const companyId = coalesceObjectId(userDoc?.company_id);
  if (!userId || !companyId || userDoc.mark_as_default_vendor !== true) {
    return;
  }

  const opts = session ? { session } : {};
  await User.updateMany(
    {
      company_id: companyId,
      _id: { $ne: userId },
      deletedAt: null,
      mark_as_default_vendor: true,
    },
    { $set: { mark_as_default_vendor: false } },
    opts,
  );
}

async function findDefaultVendor(companyId) {
  const cid = coalesceObjectId(companyId);
  if (!cid) return null;
  return User.findOne({
    company_id: cid,
    mark_as_default_vendor: true,
    deletedAt: null,
    role: { $in: ["VENDOR"] },
  }).select("-password");
}

module.exports = {
  userHasRole,
  validateDefaultVendorFlag,
  syncDefaultVendorFlag,
  findDefaultVendor,
};

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

/** Per-company "default" flags: only one user per company may hold each. */
const DEFAULT_USER_FLAGS = [
  { field: "mark_as_default_vendor", role: "VENDOR", label: "vendor" },
  { field: "mark_as_default_customer", role: "CUSTOMER", label: "customer" },
];

/**
 * Validate mark_as_default_vendor / mark_as_default_customer on create/update.
 * Returns `{ success: false, status, message }` or null when valid.
 */
function validateDefaultVendorFlag(updateData, existingUser) {
  for (const { field, role, label } of DEFAULT_USER_FLAGS) {
    if (parseBooleanFlag(updateData?.[field]) !== true) continue;

    const roles = resolveMergedRoles(existingUser, updateData);
    if (!userHasRole(roles, role)) {
      return {
        success: false,
        status: 400,
        error: "Invalid role",
        message: `Only users with the ${role} role can be marked as default ${label}.`,
      };
    }
  }

  return null;
}

/**
 * When one user is default vendor/customer, clear that flag on all other users in the same company.
 * @param {import("mongoose").ClientSession | null} [session]
 */
async function syncDefaultVendorFlag(userDoc, session = null) {
  const userId = coalesceObjectId(userDoc?._id);
  const companyId = coalesceObjectId(userDoc?.company_id);
  if (!userId || !companyId) return;

  const opts = session ? { session } : {};
  for (const { field } of DEFAULT_USER_FLAGS) {
    if (userDoc[field] !== true) continue;
    await User.updateMany(
      {
        company_id: companyId,
        _id: { $ne: userId },
        deletedAt: null,
        [field]: true,
      },
      { $set: { [field]: false } },
      opts,
    );
  }
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

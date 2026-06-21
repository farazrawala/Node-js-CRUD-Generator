require("dotenv").config();
const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");
const User = require("../models/user");
const Company = require("../models/company");
const { setUserToken } = require("../service/auth");
const { coalesceObjectId } = require("../utils/modelHelper");

const USER_A = "6a36b6f7aae26f7394a21659";
const USER_B = "6a36b6ebaae26f7394a2156b";
const BASE = process.env.TEST_API_BASE || "http://localhost:8000/pos_admin/api";

function userRolesList(user) {
  if (!user?.role) return [];
  return Array.isArray(user.role) ? user.role : [user.role];
}

function permissionFlagTruthy(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function userCanManageOtherUsers(user) {
  if (!user) return false;
  const roles = userRolesList(user);
  if (roles.some((r) => String(r).toUpperCase() === "ADMIN")) return true;
  const perms = user.permissions;
  if (!perms) return false;
  const usersPerm = perms instanceof Map ? perms.get("users") : perms.users;
  if (!usersPerm) return false;
  if (usersPerm instanceof Map) {
    return permissionFlagTruthy(usersPerm.get("edit"));
  }
  return permissionFlagTruthy(usersPerm.edit);
}

function resolveUserUpdateTargetId(req) {
  const loginUserId = req.user?._id
    ? String(coalesceObjectId(req.user._id))
    : "";
  const urlId = req.params.id ? String(req.params.id) : "";
  if (!loginUserId) return urlId;
  if (!urlId || urlId === loginUserId) return loginUserId;
  if (userCanManageOtherUsers(req.user)) return urlId;
  return loginUserId;
}

async function api(method, path, token, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function findAdminForCompany(companyId) {
  return User.findOne({
    role: { $elemMatch: { $regex: /ADMIN/i } },
    company_id: companyId,
    deletedAt: null,
  }).lean();
}

async function main() {
  await connectMonogodb();

  const userA = await User.findById(USER_A).lean();
  const userB = await User.findById(USER_B).lean();
  if (!userA || !userB) throw new Error("Test users not found in DB");

  let admin = await findAdminForCompany(userA.company_id);
  let adminSource = "same_company";
  if (!admin) {
    admin = await User.findOne({
      role: { $elemMatch: { $regex: /ADMIN/i } },
      deletedAt: null,
    }).lean();
    adminSource = "global_fallback";
  }

  const nonAdmin = await User.findById(USER_A).lean();
  const adminToken = setUserToken(admin).token;
  const nonAdminToken = setUserToken(nonAdmin).token;

  const unitTests = {
    adminUsesUrlId:
      resolveUserUpdateTargetId({
        user: admin,
        params: { id: USER_A },
      }) === USER_A,
    nonAdminUsesSelf:
      resolveUserUpdateTargetId({
        user: nonAdmin,
        params: { id: USER_B },
      }) === USER_A,
    selfEditUsesSelf:
      resolveUserUpdateTargetId({
        user: nonAdmin,
        params: { id: USER_A },
      }) === USER_A,
  };

  const beforeA = { name: userA.name, email: userA.email };
  const beforeB = { name: userB.name, email: userB.email };

  const ts = Date.now();
  const testName = `BACKEND-TEST-USER-A-${ts}`;

  const patch = await api("PATCH", `/user/update/${USER_A}`, adminToken, {
    name: testName,
  });

  const getA = await api("GET", `/user/get/${USER_A}`, adminToken);
  const getB = await api("GET", `/user/get/${USER_B}`, adminToken);

  const freshA = await User.findById(USER_A).lean();
  const freshB = await User.findById(USER_B).lean();

  const adminTest = {
    adminId: String(admin._id),
    adminSource,
    adminSameCompany: String(admin.company_id) === String(userA.company_id),
    patchStatus: patch.status,
    patchMessage: patch.body?.message || patch.body?.error,
    patchReturnedId: patch.body?.data?._id,
    userANameBefore: beforeA.name,
    userANameAfterApi: getA.body?.data?.name,
    userANameAfterDb: freshA?.name,
    userBNameBefore: beforeB.name,
    userBNameAfterApi: getB.body?.data?.name,
    userBNameAfterDb: freshB?.name,
    userAChanged: freshA?.name === testName,
    userBUnchanged: freshB?.name === beforeB.name,
    responseIdMatchesA:
      String(patch.body?.data?._id || getA.body?.data?._id || "") === USER_A,
    passed:
      freshA?.name === testName &&
      freshB?.name === beforeB.name &&
      String(patch.body?.data?._id || "") === USER_A,
  };

  const selfBefore = nonAdmin.name;
  const patchPerm = await api(
    "PATCH",
    `/user/update/${USER_B}`,
    nonAdminToken,
    { name: `SHOULD-NOT-UPDATE-B-${ts}` },
  );
  const freshSelf = await User.findById(USER_A).lean();
  const freshB2 = await User.findById(USER_B).lean();

  const permissionTest = {
    nonAdminId: USER_A,
    patchStatus: patchPerm.status,
    patchReturnedId: patchPerm.body?.data?._id,
    selfNameBefore: selfBefore,
    selfNameAfter: freshSelf?.name,
    userBNameAfter: freshB2?.name,
    urlIgnoredSelfUpdated:
      String(patchPerm.body?.data?._id) === USER_A &&
      freshSelf?.name === `SHOULD-NOT-UPDATE-B-${ts}`,
    userBUnchanged: freshB2?.name === beforeB.name,
    passed:
      String(patchPerm.body?.data?._id) === USER_A &&
      freshB2?.name === beforeB.name,
  };

  // Restore user A name if admin test modified it
  if (freshA?.name === testName) {
    await User.updateOne({ _id: USER_A }, { $set: { name: beforeA.name } });
  }
  if (freshSelf?.name !== selfBefore) {
    await User.updateOne({ _id: USER_A }, { $set: { name: selfBefore } });
  }

  console.log(
    JSON.stringify(
      {
        apiBase: BASE,
        unitTests,
        adminTest,
        permissionTest,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

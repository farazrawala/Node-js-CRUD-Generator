require("dotenv").config();
const mongoose = require("mongoose");
const { connectMonogodb } = require("../connection");
const User = require("../models/user");
const { setUserToken } = require("../service/auth");

const USER_A = "6a36b6f7aae26f7394a21659";
const USER_B = "6a36b6ebaae26f7394a2156b";

async function findAdminForCompany(companyId) {
  const queries = [
    { role: { $in: ["ADMIN"] }, company_id: companyId, deletedAt: null },
    { role: { $elemMatch: { $regex: /^ADMIN$/i } }, company_id: companyId, deletedAt: null },
    { role: { $elemMatch: { $regex: /ADMIN/i } }, deletedAt: null },
  ];
  for (const q of queries) {
    const u = await User.findOne(q).lean();
    if (u) return u;
  }
  return null;
}

function usersEditPerm(user) {
  const p = user?.permissions?.users;
  if (!p) return false;
  return p.edit === true || p.edit === "true" || p.edit === 1 || p.edit === "1";
}

async function main() {
  await connectMonogodb();
  const userA = await User.findById(USER_A).lean();
  const userB = await User.findById(USER_B).lean();
  const admin = await findAdminForCompany(userA.company_id);
  const companyUsers = await User.find({
    company_id: userA.company_id,
    deletedAt: null,
  })
    .select("name email role permissions")
    .lean();

  console.log(
    JSON.stringify(
      {
        userA: { id: USER_A, name: userA?.name, company: String(userA?.company_id) },
        userB: {
          id: USER_B,
          name: userB?.name,
          usersEdit: usersEditPerm(userB),
          role: userB?.role,
        },
        admin: admin
          ? {
              id: String(admin._id),
              name: admin.name,
              role: admin.role,
              company: String(admin.company_id),
              sameCompany: String(admin.company_id) === String(userA.company_id),
            }
          : null,
        companyUsers: companyUsers.map((u) => ({
          id: String(u._id),
          name: u.name,
          role: u.role,
          usersEdit: usersEditPerm(u),
        })),
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch(console.error);

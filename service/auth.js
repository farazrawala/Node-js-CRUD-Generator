// const sesssionIdToUseMap = new Map();
const jwt = require("jsonwebtoken");
const secret = "faraz";
function setUserToken(user) {
  console.log("🚀 setUserToken function called with user:", user);

  // Convert Mongoose document to plain object
  // Use toObject with options to ensure Map fields (like permissions) are converted properly
  const userObject = user.toObject
    ? user.toObject({ flattenMaps: true })
    : { ...user };

  const token = jwt.sign(
    {
      _id: userObject._id,
      name: userObject.name,
      company_id: userObject.company_id,
      email: userObject.email,
      password: userObject.password,
      role: userObject.role,
      permissions: userObject.permissions,
      deletedAt: userObject.deletedAt,
      createdAt: userObject.createdAt,
      updatedAt: userObject.updatedAt,
      __v: userObject.__v,
    },
    secret
  );

  userObject.token = token;
  return userObject;
}

function getUserToken(token) {
  if (!token) return null;

  try {
    const user = jwt.verify(token, secret);
    // console.log("getUser", user);
    return user;
  } catch (error) {
    console.log("❌ JWT Error:", error.message);
    return null;
  }
}

function createToken(user) {
  // Convert Mongoose document to plain object
  const userObject = user.toObject ? user.toObject() : { ...user };

  const token = jwt.sign(
    {
      _id: userObject._id,
      name: userObject.name,
      company_id: userObject.company_id,
      email: userObject.email,
      password: userObject.password,
      role: userObject.role,
      deletedAt: userObject.deletedAt,
      createdAt: userObject.createdAt,
      updatedAt: userObject.updatedAt,
      __v: userObject.__v,
    },
    secret
  );

  return token;
}

module.exports = {
  setUserToken,
  getUserToken,
  createToken,
};

// const sesssionIdToUseMap = new Map();
const jwt = require("jsonwebtoken");
const secret = "faraz";

/** JWT must stay small — Apache/proxies reject Set-Cookie above ~4KB. */
function companyIdForToken(companyId) {
  if (companyId == null) return null;
  if (typeof companyId === "object" && companyId._id != null) {
    return String(companyId._id);
  }
  return String(companyId);
}

function buildJwtPayload(userObject) {
  return {
    _id: userObject._id,
    name: userObject.name,
    company_id: companyIdForToken(userObject.company_id),
    email: userObject.email,
    role: userObject.role,
  };
}

function setUserToken(user) {
  // Convert Mongoose document to plain object
  // Use toObject with options to ensure Map fields (like permissions) are converted properly
  const userObject = user.toObject
    ? user.toObject({ flattenMaps: true })
    : { ...user };

  const token = jwt.sign(buildJwtPayload(userObject), secret);

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

  return jwt.sign(buildJwtPayload(userObject), secret);
}

module.exports = {
  setUserToken,
  getUserToken,
  createToken,
};

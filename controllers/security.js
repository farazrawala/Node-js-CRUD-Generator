const { whitelistRequestIp } = require("../utils/imunifyWhitelist");

function isAdmin(req) {
  const roles = req.user?.role;
  return Array.isArray(roles) && roles.includes("ADMIN");
}

/** POST /security/whitelist-my-ip — admin adds the IP they are browsing from to Imunify360. */
async function whitelistMyIp(req, res) {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only admins can whitelist IP addresses.",
    });
  }

  const result = await whitelistRequestIp(req, req.user?.email);
  const ok = result.status === "added" || result.status === "already";
  return res.status(ok ? 200 : result.status === "failed" ? 502 : 422).json({
    success: ok,
    ...result,
  });
}

module.exports = { whitelistMyIp };

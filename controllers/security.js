const {
  getClientIp,
  normalizePublicIp,
  unblockIp,
} = require("../utils/imunifyWhitelist");

function isAdmin(req) {
  const roles = req.user?.role;
  return Array.isArray(roles) && roles.includes("ADMIN");
}

/**
 * POST /security/whitelist-my-ip — admin unblocks an IP in Imunify360 (graylist removal +
 * whitelist). Body `{ ip }` targets another device (e.g. a blocked shop tablet, which cannot
 * reach the API itself); without it, the IP this request came from is used.
 */
async function whitelistMyIp(req, res) {
  if (!isAdmin(req)) {
    return res.status(403).json({
      success: false,
      message: "Only admins can whitelist IP addresses.",
    });
  }

  const rawTarget = String(req.body?.ip || "").trim();
  const ip = rawTarget ? normalizePublicIp(rawTarget) : getClientIp(req);
  if (!ip) {
    return res.status(422).json({
      success: false,
      status: "skipped",
      ip: rawTarget,
      message: rawTarget
        ? "Enter a valid public IP address."
        : "Could not determine a public IP for this connection.",
    });
  }

  const who = req.user?.email || "unknown user";
  const comment = rawTarget ? `POS unblock by ${who}` : `POS shop - ${who}`;
  const result = await unblockIp(ip, comment);
  const ok = result.status === "added" || result.status === "already";
  return res.status(ok ? 200 : result.status === "failed" ? 502 : 422).json({
    success: ok,
    ...result,
  });
}

module.exports = { whitelistMyIp };

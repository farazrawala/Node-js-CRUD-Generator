/**
 * Add a client's public IP to the Imunify360 whitelist on the live server, so its
 * bot-protection stops answering POS API calls with an HTML "Access denied" page.
 *
 * pos_admin runs under root's pm2, so `imunify360-agent` can be called directly.
 * Where the agent is not installed (local dev) every call resolves as "skipped".
 */
const net = require("net");
const { execFile } = require("child_process");
const fileLogger = require("./fileLogger");

const AGENT_BIN = process.env.IMUNIFY_AGENT_BIN || "imunify360-agent";
const AGENT_TIMEOUT_MS = 20000;
const COMMENT_MAX_LEN = 120;

/** Private, loopback and link-local ranges — never worth whitelisting. */
const nonPublicRanges = new net.BlockList();
nonPublicRanges.addSubnet("10.0.0.0", 8, "ipv4");
nonPublicRanges.addSubnet("127.0.0.0", 8, "ipv4");
nonPublicRanges.addSubnet("169.254.0.0", 16, "ipv4");
nonPublicRanges.addSubnet("172.16.0.0", 12, "ipv4");
nonPublicRanges.addSubnet("192.168.0.0", 16, "ipv4");
nonPublicRanges.addSubnet("100.64.0.0", 10, "ipv4");
nonPublicRanges.addSubnet("0.0.0.0", 8, "ipv4");
nonPublicRanges.addAddress("::1", "ipv6");
nonPublicRanges.addSubnet("fc00::", 7, "ipv6");
nonPublicRanges.addSubnet("fe80::", 10, "ipv6");

/** IPs already added by this process, so repeat logins don't re-run the agent. */
const whitelistedThisProcess = new Set();
let agentMissing = false;

/** Strip an IPv4-mapped IPv6 prefix and validate. Returns "" when not a usable public IP. */
function normalizePublicIp(raw) {
  let ip = String(raw || "").trim();
  if (ip.toLowerCase().startsWith("::ffff:") && net.isIPv4(ip.slice(7))) {
    ip = ip.slice(7);
  }
  const family = net.isIP(ip);
  if (!family) return "";
  if (nonPublicRanges.check(ip, family === 4 ? "ipv4" : "ipv6")) return "";
  return ip;
}

/**
 * Real visitor IP. The live API sits behind Cloudflare → Apache → Node, so the
 * browser's address arrives in CF-Connecting-IP; req.ip is the fallback off Cloudflare.
 */
function getClientIp(req) {
  const cfIp = normalizePublicIp(req.get?.("cf-connecting-ip"));
  if (cfIp) return cfIp;
  return normalizePublicIp(req.ip);
}

/** Keep the comment to plain printable text; it is passed as one argv entry, never via a shell. */
function sanitizeComment(text) {
  return String(text || "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, COMMENT_MAX_LEN);
}

function runAgent(args) {
  return new Promise((resolve) => {
    execFile(
      AGENT_BIN,
      args,
      { timeout: AGENT_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          error,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
        });
      }
    );
  });
}

/**
 * Permanently whitelist `ip` in Imunify360.
 * Resolves { status: "added" | "already" | "skipped" | "failed", ip, message } — never rejects.
 */
async function whitelistIp(ip, comment) {
  const cleanIp = normalizePublicIp(ip);
  if (!cleanIp) {
    return { status: "skipped", ip: String(ip || ""), message: "Not a public IP address." };
  }
  if (agentMissing) {
    return { status: "skipped", ip: cleanIp, message: "Imunify360 is not installed on this server." };
  }
  if (whitelistedThisProcess.has(cleanIp)) {
    return { status: "already", ip: cleanIp, message: "IP is already whitelisted." };
  }

  const { error, stdout, stderr } = await runAgent([
    "whitelist",
    "ip",
    "add",
    cleanIp,
    "--comment",
    sanitizeComment(comment) || "POS",
  ]);

  if (error?.code === "ENOENT") {
    agentMissing = true;
    return { status: "skipped", ip: cleanIp, message: "Imunify360 is not installed on this server." };
  }
  if (error) {
    const detail = stderr || stdout || error.message;
    if (/already/i.test(detail)) {
      whitelistedThisProcess.add(cleanIp);
      return { status: "already", ip: cleanIp, message: "IP is already whitelisted." };
    }
    fileLogger.error("Imunify360 whitelist failed", { ip: cleanIp, detail });
    return { status: "failed", ip: cleanIp, message: detail.slice(0, 300) };
  }

  whitelistedThisProcess.add(cleanIp);
  fileLogger.info("Imunify360 whitelist added", { ip: cleanIp, comment });
  return { status: "added", ip: cleanIp, message: stdout || "IP whitelisted." };
}

/**
 * Take `ip` off the Imunify360 graylist (where bot-protection parks blocked IPs).
 * Resolves { status: "removed" | "skipped" | "failed", ip, message } — never rejects.
 */
async function removeFromGraylist(ip) {
  const cleanIp = normalizePublicIp(ip);
  if (!cleanIp) {
    return { status: "skipped", ip: String(ip || ""), message: "Not a public IP address." };
  }
  if (agentMissing) {
    return { status: "skipped", ip: cleanIp, message: "Imunify360 is not installed on this server." };
  }

  const { error, stdout, stderr } = await runAgent(["graylist", "ip", "delete", cleanIp]);
  if (error?.code === "ENOENT") {
    agentMissing = true;
    return { status: "skipped", ip: cleanIp, message: "Imunify360 is not installed on this server." };
  }
  if (error) {
    // Usually "not in graylist" — harmless, the whitelist step still runs.
    return { status: "failed", ip: cleanIp, message: (stderr || stdout || error.message).slice(0, 300) };
  }
  fileLogger.info("Imunify360 graylist removed", { ip: cleanIp });
  return { status: "removed", ip: cleanIp, message: stdout || "Removed from graylist." };
}

/**
 * Unblock `ip`: remove it from the graylist, then whitelist it so it is not caught again.
 * Resolves the whitelist result plus `graylistRemoved` — never rejects.
 */
async function unblockIp(ip, comment) {
  const graylist = await removeFromGraylist(ip);
  const result = await whitelistIp(ip, comment);
  return { ...result, graylistRemoved: graylist.status === "removed" };
}

/** Whitelist the IP the request came from. `who` (e.g. the user's email) goes in the comment. */
function whitelistRequestIp(req, who) {
  const ip = getClientIp(req);
  if (!ip) {
    return Promise.resolve({
      status: "skipped",
      ip: "",
      message: "Could not determine a public IP for this connection.",
    });
  }
  return whitelistIp(ip, `POS shop - ${who || "unknown user"}`);
}

module.exports = {
  normalizePublicIp,
  getClientIp,
  sanitizeComment,
  whitelistIp,
  whitelistRequestIp,
  removeFromGraylist,
  unblockIp,
};

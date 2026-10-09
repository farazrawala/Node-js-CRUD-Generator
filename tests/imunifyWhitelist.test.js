/**
 * Imunify360 whitelist helper unit tests (no real agent is ever run).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.IMUNIFY_AGENT_BIN = "imunify360-agent-missing-for-tests";

const {
  normalizePublicIp,
  getClientIp,
  sanitizeComment,
  whitelistIp,
} = require("../utils/imunifyWhitelist");

const fakeReq = (headers, ip) => ({
  ip,
  get: (name) => headers[name.toLowerCase()],
});

describe("imunifyWhitelist", () => {
  it("accepts public IPv4/IPv6 and unwraps IPv4-mapped addresses", () => {
    assert.equal(normalizePublicIp("39.45.12.7"), "39.45.12.7");
    assert.equal(normalizePublicIp("::ffff:39.45.12.7"), "39.45.12.7");
    assert.equal(normalizePublicIp("2400:adc1:1::1"), "2400:adc1:1::1");
  });

  it("rejects private, loopback and malformed values", () => {
    for (const bad of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.5",
      "172.20.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "",
      "1.2.3.4; rm -rf /",
      "1.2.3.4 --comment x",
      "not-an-ip",
    ]) {
      assert.equal(normalizePublicIp(bad), "", bad);
    }
  });

  it("prefers CF-Connecting-IP and falls back to req.ip", () => {
    assert.equal(
      getClientIp(fakeReq({ "cf-connecting-ip": "39.45.12.7" }, "127.0.0.1")),
      "39.45.12.7"
    );
    assert.equal(getClientIp(fakeReq({}, "::ffff:39.45.12.8")), "39.45.12.8");
    assert.equal(getClientIp(fakeReq({ "cf-connecting-ip": "junk" }, "127.0.0.1")), "");
  });

  it("strips non-printable characters from the comment and caps its length", () => {
    assert.equal(sanitizeComment("POS shop - a@b.com\n\u0000"), "POS shop - a@b.com");
    assert.equal(sanitizeComment("x".repeat(500)).length, 120);
  });

  it("skips without running anything when the IP is not public", async () => {
    const r = await whitelistIp("192.168.0.10", "test");
    assert.equal(r.status, "skipped");
  });

  it("reports skipped when the agent binary is not installed", async () => {
    const r = await whitelistIp("39.45.12.7", "test");
    assert.equal(r.status, "skipped");
    assert.match(r.message, /not installed/);
  });
});

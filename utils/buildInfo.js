const fs = require("fs");
const path = require("path");

const BUILD_INFO_PATH = path.join(__dirname, "..", "deploy", "build-info.json");

/** @returns {Record<string, unknown> | null} */
function readDeployBuildInfoFile() {
  try {
    if (!fs.existsSync(BUILD_INFO_PATH)) {
      return null;
    }
    const raw = fs.readFileSync(BUILD_INFO_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function getPackageVersion() {
  try {
    return require("../package.json").version || "0.0.0";
  } catch (_) {
    return "0.0.0";
  }
}

/**
 * Runtime + deploy stamp for /health and /api/version.
 * Compare `gitCommitShort` on live vs `git rev-parse --short HEAD` locally.
 */
function getDeployVersionPayload() {
  const file = readDeployBuildInfoFile() || {};
  const gitCommit =
    typeof file.gitCommit === "string" && file.gitCommit.trim() ?
      file.gitCommit.trim()
    : "local-dev";
  const gitCommitShort =
    typeof file.gitCommitShort === "string" && file.gitCommitShort.trim() ?
      file.gitCommitShort.trim()
    : gitCommit.slice(0, 7);

  const processStartedAt = new Date(
    Date.now() - process.uptime() * 1000,
  ).toISOString();

  return {
    service: "pos-api",
    packageVersion: getPackageVersion(),
    deployVersion:
      typeof file.deployVersion === "string" && file.deployVersion.trim() ?
        file.deployVersion.trim()
      : getPackageVersion(),
    deployNumber:
      typeof file.deployNumber === "number" ? file.deployNumber : null,
    gitCommit,
    gitCommitShort,
    gitBranch: file.gitBranch ?? null,
    deployedAt: file.deployedAt ?? null,
    buildLabel: file.buildLabel ?? `${gitCommitShort}@local`,
    workflowRunId: file.workflowRunId ?? null,
    inventoryPolicy: "order_movements_no_soft_delete_v2",
    processStartedAt,
    processUptimeSec: Math.floor(process.uptime()),
    nodeVersion: process.version,
    appEnv: process.env.APP_ENV || null,
    nodeEnv: process.env.NODE_ENV || "development",
    pid: process.pid,
  };
}

function getHealthPayload(basePath) {
  return {
    ok: true,
    status: 200,
    basePath: basePath || null,
    time: new Date().toISOString(),
    version: getDeployVersionPayload(),
  };
}

module.exports = {
  BUILD_INFO_PATH,
  readDeployBuildInfoFile,
  getDeployVersionPayload,
  getHealthPayload,
};

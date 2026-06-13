const fs = require("fs");
const path = require("path");

/**
 * FTP deploy skips node_modules; server npm install often never runs.
 * iconv-lite then missing deploy/vendor/iconv-lite/encodings → POST JSON fails.
 */
function repairIconvLiteEncodings() {
  const projectRoot = path.join(__dirname, "..");
  const targetDir = path.join(projectRoot, "node_modules", "iconv-lite", "encodings");
  const vendorDir = path.join(
    projectRoot,
    "deploy",
    "vendor",
    "iconv-lite",
    "encodings",
  );
  const targetIndex = path.join(targetDir, "index.js");

  if (fs.existsSync(targetIndex)) {
    return;
  }

  if (!fs.existsSync(path.join(vendorDir, "index.js"))) {
    throw new Error(
      "iconv-lite encodings missing in node_modules and deploy/vendor. Run npm install locally, then redeploy.",
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(vendorDir, targetDir, { recursive: true });
  console.log("📦 Patched iconv-lite encodings from deploy/vendor");
}

module.exports = { repairIconvLiteEncodings };

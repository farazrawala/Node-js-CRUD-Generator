#!/usr/bin/env node
/**
 * CI deploy: set package.json version to MAJOR.MINOR.<GITHUB_RUN_NUMBER>.
 * Example: 1.0.0 + run #42 → 1.0.42 (increases on every main push deploy).
 *
 * Usage (GitHub Actions):
 *   GITHUB_RUN_NUMBER=42 node deploy/bump-deploy-version.js
 */
const fs = require("fs");
const path = require("path");

const runNumber = String(process.env.GITHUB_RUN_NUMBER || "").trim();
if (!/^\d+$/.test(runNumber)) {
  console.error(
    "GITHUB_RUN_NUMBER is required (set automatically in GitHub Actions).",
  );
  process.exit(1);
}

const root = path.join(__dirname, "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const parts = String(pkg.version || "1.0.0").split(".");
const major = parts[0] || "1";
const minor = parts[1] || "0";
const deployVersion = `${major}.${minor}.${runNumber}`;

pkg.version = deployVersion;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

console.log(deployVersion);

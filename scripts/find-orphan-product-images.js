/**
 * Find product image files on disk that no product document references.
 *
 * Usage:
 *   node scripts/find-orphan-product-images.js
 *   node scripts/find-orphan-product-images.js --company-id YOUR_ID
 *   node scripts/find-orphan-product-images.js --json
 *   node scripts/find-orphan-product-images.js --delete --yes
 */

require("dotenv").config();

const {
  findOrphanProductImages,
  deleteOrphanProductImages,
} = require("../utils/orphanProductImages");
const { connectMonogodb } = require("../connection");

function readArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const companyId = readArg("--company-id");
  const asJson = hasFlag("--json");
  const doDelete = hasFlag("--delete");
  const confirmDelete = hasFlag("--yes");
  const activeOnly = hasFlag("--active-only");

  await connectMonogodb();

  const result = await findOrphanProductImages({ companyId, activeOnly });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          productsScanned: result.productsScanned,
          filesOnDisk: result.filesOnDisk,
          linkedPaths: result.linkedPaths,
          orphanCount: result.orphans.length,
          orphans: result.orphans.map((o) => o.key),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Products scanned: ${result.productsScanned}${activeOnly ? " (active only)" : ""}`,
    );
    console.log(`Image files on disk: ${result.filesOnDisk}`);
    console.log(`Unique linked paths: ${result.linkedPaths}`);
    console.log(`Orphan files: ${result.orphans.length}`);
    if (result.orphans.length) {
      console.log("\nOrphans:");
      for (const o of result.orphans) {
        console.log(`  ${o.key}`);
      }
    }
  }

  if (doDelete) {
    if (!confirmDelete) {
      console.error(
        "\nRefusing to delete without --yes. Re-run with: --delete --yes",
      );
      process.exitCode = 1;
    } else {
      const keys = result.orphans.map((o) => o.key);
      const del = await deleteOrphanProductImages(keys, {
        companyId,
        activeOnly,
      });
      console.log(
        `\nDeleted ${del.deleted.length}/${keys.length} orphan file(s).`,
      );
      if (del.skipped.length) {
        console.log(`Skipped: ${del.skipped.length}`);
      }
      if (del.errors.length) {
        console.log(`Errors: ${del.errors.length}`);
      }
    }
  }

  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

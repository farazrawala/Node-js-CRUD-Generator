/**
 * One-time copy: VPS pos_db → Atlas pos_db (upsert by _id).
 * Usage: node scripts/migrate-posdb-to-atlas.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const SOURCE_URI =
  process.env.MIGRATE_SOURCE_URI ||
  "mongodb://admin:YourStrongPassword123%21@192.249.118.80:27017/pos_db?authSource=admin&replicaSet=rs0&directConnection=true";

const TARGET_URI =
  process.env.MIGRATE_TARGET_URI ||
  "mongodb+srv://johndavid78663_db_user:vVYRdagRbySqatO1@cluster0.jok4qhf.mongodb.net/pos_db?retryWrites=true&w=majority";

const BATCH_SIZE = 500;

async function migrateCollection(srcDb, dstDb, name) {
  const srcCol = srcDb.collection(name);
  const dstCol = dstDb.collection(name);
  const total = await srcCol.countDocuments();
  if (total === 0) {
    return { name, total: 0, migrated: 0 };
  }

  let migrated = 0;
  let batch = [];
  const cursor = srcCol.find({}).batchSize(BATCH_SIZE);

  for await (const doc of cursor) {
    batch.push({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    });

    if (batch.length >= BATCH_SIZE) {
      await dstCol.bulkWrite(batch, { ordered: false });
      migrated += batch.length;
      batch = [];
      process.stdout.write(`\r  ${name}: ${migrated}/${total}`);
    }
  }

  if (batch.length > 0) {
    await dstCol.bulkWrite(batch, { ordered: false });
    migrated += batch.length;
  }

  console.log(`\r  ${name}: ${migrated}/${total}`);
  return { name, total, migrated };
}

async function main() {
  console.log("Source:", SOURCE_URI.replace(/:([^:@]+)@/, ":****@"));
  console.log("Target:", TARGET_URI.replace(/:([^:@]+)@/, ":****@"));

  const srcConn = mongoose.createConnection(SOURCE_URI);
  const dstConn = mongoose.createConnection(TARGET_URI);

  await Promise.all([srcConn.asPromise(), dstConn.asPromise()]);
  console.log("Connected to source and target.\n");

  const srcDb = srcConn.db;
  const dstDb = dstConn.db;
  const collections = await srcDb.listCollections().toArray();
  const results = [];

  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    try {
      results.push(await migrateCollection(srcDb, dstDb, name));
    } catch (err) {
      console.error(`\n  FAILED ${name}:`, err.message);
      results.push({ name, error: err.message });
    }
  }

  const integrations = await dstDb
    .collection("integrations")
    .countDocuments();
  console.log("\nDone. Atlas pos_db integrations:", integrations);

  await srcConn.close();
  await dstConn.close();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});

const mongoose = require("mongoose");

const LOCAL_MONGODB_URI = "mongodb://localhost:27017/test";

function isLiveEnvironment() {
  const appEnv = String(process.env.APP_ENV || "")
    .trim()
    .toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "")
    .trim()
    .toLowerCase();
  return (
    appEnv === "live" ||
    appEnv === "production" ||
    nodeEnv === "production"
  );
}

/**
 * Local: MONGODB_URI (default localhost test).
 * Live: set APP_ENV=live (or NODE_ENV=production) and MONGODB_URI_LIVE.
 */
function getMongoUri() {
  if (isLiveEnvironment()) {
    const liveUri = process.env.MONGODB_URI_LIVE;
    if (!liveUri || String(liveUri).trim() === "") {
      throw new Error(
        "MONGODB_URI_LIVE is required when APP_ENV=live or NODE_ENV=production",
      );
    }
    return String(liveUri).trim();
  }
  return process.env.MONGODB_URI || LOCAL_MONGODB_URI;
}

async function connectMonogodb(url) {
  const resolvedUrl = url || getMongoUri();
  if (!resolvedUrl || String(resolvedUrl).trim() === "") {
    throw new Error(
      "MongoDB connection URL is required (set MONGODB_URI or MONGODB_URI_LIVE in .env)",
    );
  }

  const mode = isLiveEnvironment() ? "live (Atlas)" : "local";
  const dbLabel = (() => {
    try {
      const u = new URL(
        String(resolvedUrl).replace(/^mongodb(\+srv)?:/, "https:"),
      );
      const name = u.pathname.replace(/^\//, "").trim();
      return name || "test";
    } catch {
      return "(unknown)";
    }
  })();

  console.log(`📡 MongoDB mode: ${mode}`);
  console.log(`📡 MongoDB database: ${dbLabel}`);

  mongoose.connection.on("connected", () => {
    const activeDb = mongoose.connection.db?.databaseName || dbLabel;
    console.log(
      "✅ MongoDB connected:",
      mongoose.connection.host,
      `(db: ${activeDb})`,
    );
  });
  mongoose.connection.on("error", (err) => {
    console.error("❌ MongoDB connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("⚠️ MongoDB disconnected");
  });

  return mongoose.connect(resolvedUrl);
}

module.exports = {
  connectMonogodb,
  getMongoUri,
  isLiveEnvironment,
};

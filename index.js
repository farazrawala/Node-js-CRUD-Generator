require("dotenv").config();

const fileLogger = require("./utils/fileLogger");
fileLogger.installConsoleCapture();

const { repairIconvLiteEncodings } = require("./utils/repairIconvLite");
repairIconvLiteEncodings();

// Fail fast if node_modules is still incomplete after vendor patch
try {
  require("iconv-lite").encodingExists("utf8");
} catch (err) {
  console.error(
    "❌ Broken node_modules (iconv-lite encodings missing). On the server run:\n" +
      "   cd /home/demowebsitv3/public_html/pos_admin\n" +
      "   rm -rf node_modules\n" +
      "   npm ci --omit=dev   # or: npm install --production\n" +
      "   pm2 restart pos-api",
  );
  process.exit(1);
}

const express = require("express");
const { connectMonogodb, getMongoUri } = require("./connection");
const path = require("path");
const urlRouter = require("./routes/url");
const userRoute = require("./routes/user");
const apiRoute = require("./routes/api");
const adminRoute = require("./routes/admin");
const staticRoute = require("./routes/staticRouter");
const debugLogsRoute = require("./routes/debugLogs");
const fileUpload = require("express-fileupload");
const methodOverride = require("method-override");

const {
  restrictTo,
  checkForAuthentication,
  checkHeaderAuthentication,
} = require("./middlewares/auth");
const {
  getBasePath,
  withBasePath,
  createStripBasePathMiddleware,
  getCookiePath,
  isSecureCookie,
} = require("./utils/basePath");
const { getDeployVersionPayload, getHealthPayload } = require("./utils/buildInfo");

// Dynamically load all models to ensure they're registered before controllers
const fs = require("fs");
const modelsPath = path.join(__dirname, "models");
const modelFiles = fs
  .readdirSync(modelsPath)
  .filter((file) => file.endsWith(".js"));

modelFiles.forEach((file) => {
  const modelPath = path.join(modelsPath, file);
  // console.log(`📦 Loading model: ${file}`);
  require(modelPath);
});

const app = express();
const BASE_PATH = getBasePath();
const port = Number(process.env.PORT) || 8000;

app.set("trust proxy", 1);

const cookieParser = require("cookie-parser");
const session = require("express-session");
const flash = require("connect-flash");
const cors = require("cors");

// CORS configuration
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman, or curl)
      if (!origin) return callback(null, true);

      // Allow all origins in development, or specific origins in production
      const allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
        "http://localhost:5173", // Vite default port
        "http://localhost:5174",
        "http://localhost:8080",
        "http://localhost:8000",
      ];

      // In development, allow all origins
      if (process.env.NODE_ENV !== "production") {
        return callback(null, true);
      }

      // In production, check against allowed origins
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(null, true); // Still allow for now, but you can restrict in production
      }
    },
    credentials: true, // Allow cookies to be sent
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
      "Access-Control-Request-Method",
      "Access-Control-Request-Headers",
    ],
    exposedHeaders: ["Content-Range", "X-Content-Range"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  }),
);

app.use(cookieParser());
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

// Proxy sends /pos_admin/... — strip prefix before route matching
app.use(createStripBasePathMiddleware());

// Serve static files from uploads directory
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Session middleware (must come before flash)
app.use(
  session({
    secret: "your-secret-key-here",
    resave: false,
    saveUninitialized: false,
    cookie: {
      path: getCookiePath(),
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
    proxy: true,
  }),
);

// Flash messages middleware
app.use(flash());

// Make flash messages and base path available to all views
app.use((req, res, next) => {
  if (req.session) {
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.info = req.flash("info");
  } else {
    res.locals.success = [];
    res.locals.error = [];
    res.locals.info = [];
  }
  if (res.locals.basePath === undefined) {
    res.locals.basePath = BASE_PATH;
  }
  next();
});

// Configure express-fileupload for handling file uploads FIRST
app.use(
  fileUpload({
    createParentPath: true,
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max file size
    },
    abortOnLimit: true,
    responseOnLimit: "File size limit has been reached",
    useTempFiles: false, // Use memory instead of temp files
    debug: false,
    parseNested: true, // multipart keys like reference_id[module] → nested req.body
  }),
);

// Method override for PUT/DELETE requests (MUST be before body parsing)
app.use(
  methodOverride("_method", {
    methods: ["POST"],
  }),
);

// Middleware to handle different content types AFTER file upload
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Debug middleware to log request details
app.use((req, res, next) => {
  // Debug ALL admin requests
  if (
    req.url.includes("/admin/") &&
    (req.method === "POST" || req.method === "PUT")
  ) {
    console.log(`🔍 Admin Request Debug:`, {
      method: req.method,
      url: req.url,
      contentType: req.get("Content-Type"),
      body: req.body,
      originalMethod: req.originalMethod,
      query: req.query,
      headers: {
        "content-type": req.get("Content-Type"),
        "content-length": req.get("Content-Length"),
      },
    });
  }

  // Debug method override specifically
  if (req.url.includes("/admin/blogs/") && req.method === "POST") {
    console.log(`🔄 Method Override Debug:`, {
      originalMethod: req.originalMethod,
      method: req.method,
      body: req.body,
      _method: req.body._method,
    });
  }

  // Specific debug for complain requests
  if (
    req.url.includes("/admin/complain/") &&
    (req.method === "POST" || req.method === "PUT")
  ) {
    console.log(`🚨 COMPLAIN REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod,
    });
  }

  // Specific debug for blogs requests
  if (
    req.url.includes("/admin/blogs/") &&
    (req.method === "POST" || req.method === "PUT")
  ) {
    console.log(`📝 BLOG REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod,
    });
  }

  // Specific debug for products requests
  if (
    req.url.includes("/admin/products/") &&
    (req.method === "POST" || req.method === "PUT")
  ) {
    console.log(`🛍️ PRODUCT REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod,
      files: req.files ? Object.keys(req.files) : "none",
    });
  }

  next();
});

connectMonogodb(getMongoUri()).catch((err) => {
  console.error("❌ Failed to connect to MongoDB:", err.message);
  process.exit(1);
});

/** Public deploy check — registered before /api auth middleware. */
app.get("/api/version", (req, res) => {
  const payload = getHealthPayload(BASE_PATH || null);
  res.status(200).json({
    success: true,
    ...payload,
    data: payload.version,
  });
});
app.get("/api/health", (req, res) => {
  res.status(200).json(getHealthPayload(BASE_PATH || null));
});

app.use(checkForAuthentication); // <--- This line must be enabled

app.use("/admin/debug", debugLogsRoute);
app.use("/api/debug", debugLogsRoute);
app.use("/url", restrictTo(["NORMAL"]), urlRouter);
app.use("/user", userRoute);
app.use("/api", checkHeaderAuthentication, apiRoute);
app.use("/admin", adminRoute);
app.use("/", staticRoute);

console.log(
  `📁 Public base path: ${BASE_PATH || "(auto /pos_admin if proxied)"}`,
);

/** Fallback JSON 404 when no route matched (avoids opaque HTML from proxies/browsers). */
app.use((req, res) => {
  const fullPath = req.originalUrl || req.url || "/";
  fileLogger.warn(`${req.method} ${fullPath}`, { type: "not_found" });
  return res.status(404).json({
    success: false,
    status: 404,
    error: "Not found",
    details: `No handler for ${req.method} ${fullPath}. API routes are under ${withBasePath("/api")} (port ${port}).`,
    type: "not_found",
  });
});

/** Log unhandled route errors (e.g. body-parser / iconv-lite failures) */
app.use((err, req, res, next) => {
  fileLogger.logRequestError(req, err, { type: "express_error" });
  if (res.headersSent) return next(err);
  return res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
    type: "server_error",
  });
});

process.on("unhandledRejection", (reason) => {
  fileLogger.error("unhandledRejection", {
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

process.on("uncaughtException", (err) => {
  fileLogger.error("uncaughtException", {
    message: err?.message,
    stack: err?.stack,
  });
});

app.listen(port, () => {
  const version = getDeployVersionPayload();
  fileLogger.logStartup({
    port,
    basePath: BASE_PATH || null,
    nodeEnv: process.env.NODE_ENV || "development",
    appEnv: process.env.APP_ENV || null,
    cookiePath: getCookiePath(),
    logDir: fileLogger.LOG_DIR,
    gitCommitShort: version.gitCommitShort,
    buildLabel: version.buildLabel,
  });
  console.log("🚀 Server started at port " + port);
  console.log(
    `📁 BASE_PATH=${BASE_PATH || "(unset)"} cookiePath=${getCookiePath()}`,
  );
  console.log(
    `🏷️  Deploy v${version.deployVersion} (commit ${version.gitCommitShort}, run #${version.deployNumber ?? "local"}) — GET ${withBasePath("/api/version")}`,
  );

  const { startProcessQueueWorker } = require("./utils/processQueueWorker");
  startProcessQueueWorker();
});

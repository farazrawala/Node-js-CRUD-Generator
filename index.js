const express = require("express");
const { connectMonogodb } = require("./connection");
const path = require("path");
const urlRouter = require("./routes/url");
const userRoute = require("./routes/user");
const apiRoute = require("./routes/api");
const adminRoute = require("./routes/admin");
const staticRoute = require("./routes/staticRouter");
const fileUpload = require("express-fileupload");
const methodOverride = require("method-override");

const { restrictTo, checkForAuthentication,checkHeaderAuthentication } = require("./middlewares/auth");

// Dynamically load all models to ensure they're registered before controllers
const fs = require("fs");
const modelsPath = path.join(__dirname, "models");
const modelFiles = fs.readdirSync(modelsPath).filter(file => file.endsWith('.js'));

modelFiles.forEach(file => {
  const modelPath = path.join(modelsPath, file);
  // console.log(`📦 Loading model: ${file}`);
  require(modelPath);
});

const app = express();
const port = 8000;

const cookieParser = require("cookie-parser");
const session = require("express-session");
const flash = require("connect-flash");
const cors = require("cors");

// CORS configuration
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000'], // React development servers
  credentials: true, // Allow cookies to be sent
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(cookieParser());
app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session middleware (must come before flash)
app.use(session({
  secret: 'your-secret-key-here',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to true if using HTTPS
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Flash messages middleware
app.use(flash());

// Make flash messages available to all views
app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.info = req.flash('info');
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
  })
);

// Method override for PUT/DELETE requests (MUST be before body parsing)
app.use(methodOverride('_method', {
  methods: ['POST']
}));

// Middleware to handle different content types AFTER file upload
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Debug middleware to log request details
app.use((req, res, next) => {
  // Debug ALL admin requests
  if (req.url.includes('/admin/') && (req.method === 'POST' || req.method === 'PUT')) {
    console.log(`🔍 Admin Request Debug:`, {
      method: req.method,
      url: req.url,
      contentType: req.get("Content-Type"),
      body: req.body,
      originalMethod: req.originalMethod,
      query: req.query,
      headers: {
        'content-type': req.get('Content-Type'),
        'content-length': req.get('Content-Length')
      }
    });
  }
  
  // Debug method override specifically
  if (req.url.includes('/admin/blogs/') && req.method === 'POST') {
    console.log(`🔄 Method Override Debug:`, {
      originalMethod: req.originalMethod,
      method: req.method,
      body: req.body,
      _method: req.body._method
    });
  }
  
  // Specific debug for complain requests
  if (req.url.includes('/admin/complain/') && (req.method === 'POST' || req.method === 'PUT')) {
    console.log(`🚨 COMPLAIN REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod
    });
  }
  
  // Specific debug for blogs requests
  if (req.url.includes('/admin/blogs/') && (req.method === 'POST' || req.method === 'PUT')) {
    console.log(`📝 BLOG REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod
    });
  }
  
  // Specific debug for products requests
  if (req.url.includes('/admin/products/') && (req.method === 'POST' || req.method === 'PUT')) {
    console.log(`🛍️ PRODUCT REQUEST DETECTED:`, {
      method: req.method,
      url: req.url,
      body: req.body,
      _method: req.body._method,
      originalMethod: req.originalMethod,
      files: req.files ? Object.keys(req.files) : 'none'
    });
  }
  
  next();
});

connectMonogodb("mongodb://localhost:27017/test");

app.use(checkForAuthentication); // <--- This line must be enabled

app.use("/url", restrictTo(["NORMAL"]), urlRouter);
// console.log("🔧 Mounting user routes at /user");
app.use("/user", userRoute);
// console.log("✅ User routes mounted successfully");
app.use("/api", checkHeaderAuthentication, apiRoute);
app.use("/admin", adminRoute);
app.use("/", staticRoute);

app.listen(port, () => {
  console.log("🚀 Server started at port " + port);
  console.log("📝 Nodemon is watching for changes...");
});

const { getUserToken } = require("../service/auth");
const { handleGenericCreate } = require("../utils/modelHelper");

/**
 * Helper function to log API requests
 * Works for both authenticated and public routes
 * @param {Object} req - Express request object
 * @param {Object} user - User object (optional, can be null for public routes)
 */
async function logApiRequest(req, user = null) {
  try {
    const action = req.path.split("/").pop().toUpperCase() || "UNKNOWN";
    const method = req.method || "GET";

    // Determine user information
    let userEmail = "Anonymous";
    let userId = null;
    let companyId = null;

    if (user) {
      userEmail = user.email || user.name || "Unknown";
      userId = user._id || null;
      companyId = user.company_id || null;
    } else {
      // Try to get user from token if available (for public routes with optional auth)
      const authorizationHeaderValue = req.headers["authorization"];
      if (authorizationHeaderValue) {
        try {
          const token = authorizationHeaderValue.startsWith("Bearer ")
            ? authorizationHeaderValue.split("Bearer ")[1]
            : authorizationHeaderValue;
          const tokenUser = getUserToken(token);
          if (tokenUser) {
            userEmail = tokenUser.email || tokenUser.name || "Unknown";
            userId = tokenUser._id || null;
            companyId = tokenUser.company_id || null;
          }
        } catch (error) {
          // Token invalid or expired, continue with anonymous
        }
      }
    }

    // Create a mock request object with log data in req.body
    const logReq = Object.create(Object.getPrototypeOf(req));
    Object.assign(logReq, req, {
      body: {
        action: `${method} ${action}`,
        url: req.path,
        tags: ["api", method.toLowerCase(), user ? "authenticated" : "public"],
        description: `User ${userEmail} accessed ${req.path}`,
        company_id: companyId,
        created_by: userId,
      },
    });

    // Insert log asynchronously (don't block the request)
    handleGenericCreate(logReq, "logs", {
      afterCreate: async (record, req) => {
        console.log("✅ Log created successfully:", record._id);
      },
    }).catch((error) => {
      // Log error but don't block the request
      console.error("❌ Failed to create log:", error);
    });
  } catch (error) {
    // Log error but don't block the request
    console.error("❌ Error creating log:", error);
  }
}

function checkForAuthentication(req, res, next) {
  // const authorizationHeaderValue = req.headers["authorization"];
  const tokencookie = req.cookies?.token;
  req.user = null;

  if (!tokencookie) return next();

  const token = tokencookie;
  const user = getUserToken(token);
  req.user = user;

  return next();
}

async function checkHeaderAuthentication(req, res, next) {
  console.log(`🔐 checkHeaderAuthentication called for:`, req.path);
  const authorizationHeaderValue = req.headers["authorization"];
  req.user = null;

  // Allow public routes that don't need authentication
  const publicRoutePatterns = [
    "/user/login", // Direct route access
    // '/user/create',                    // Direct route access
    "/api/user/login", // API route access
    // '/api/user/create',                // API route access - REMOVED: Now requires auth to auto-add company_id
    "/login/admin", // Admin login
    "/api/login/admin", // Admin login
    "/api/blog/get-all", // Public blog routes
    "/api/blog/get-all-active", // Public blog routes
    // '/api/product/get-all',            // Public product routes
    // '/api/user/get-all',               // Public user routes
    "/user/user_company", // Public user routes
    // '/api/user/user_company',               // Public user routes
    /^\/api\/blog\/get\/.*/, // /api/blog/get/:id
    // /^\/api\/product\/get\/.*/, // /api/product/get/:id
    /^\/api\/user\/get\/.*/, // /api/user/get/:id
    "/api/test", // Test route
  ];

  // Check if current route should be public
  const isPublicRoute = publicRoutePatterns.some((pattern) => {
    const match =
      typeof pattern === "string"
        ? req.path === pattern
        : pattern instanceof RegExp
        ? pattern.test(req.path)
        : false;

    // Debug logging for this specific route
    if (req.path === "/api/user/user_company") {
      console.log(`🔍 Checking pattern: ${pattern} -> Match: ${match}`);
    }

    return match;
  });

  // Debug logging for this specific route
  if (
    req.path === "/api/user/user_company" ||
    req.path === "/api/user/create"
  ) {
    console.log("🔍 Route check:", req.path, "isPublicRoute:", isPublicRoute);
  }

  if (isPublicRoute) {
    console.log("✅ Public route - skipping auth check:", req.path);
    // Log public route access
    logApiRequest(req, null);
    return next();
  }

  if (!authorizationHeaderValue) {
    return res.status(401).json({
      success: false,
      error: "Authorization header is required",
      message: "Please provide authorization token in the header",
    });
  }

  // Extract token from "Bearer TOKEN" format or just use the token directly
  const token = authorizationHeaderValue.startsWith("Bearer ")
    ? authorizationHeaderValue.split("Bearer ")[1]
    : authorizationHeaderValue;

  const user = getUserToken(token);

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Invalid or expired token",
      message: "Please provide a valid authorization token",
    });
  }

  req.user = user;

  // Log authenticated route access
  logApiRequest(req, user);

  return next();
}

function restrictTo(roles) {
  return function (req, res, next) {
    if (!req.user) return res.redirect("/login/admin");

    console.log("Current user : " + req.user.email, req.user.role);

    // Check if user has any of the required roles (user.role is an array)
    const userHasRole = req.user.role.some((userRole) =>
      roles.includes(userRole)
    );
    if (!userHasRole) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Insufficient privileges.",
        required: roles,
        current: req.user.role,
      });
    }

    return next();
  };
}

async function restrictToLoginUserOnly(req, res, next) {
  //
  // To access a specific cookie, e.g., uid:
  //   console.log("uid", req.cookies.uid);

  // const userUid = req.cookies.uid;
  const userUid = req.headers["authorization"];
  console.log("Authorization", req.headers);
  if (!userUid) return res.redirect("/login");
  const token = userUid.split("Bearer ")[1];
  const user = getUserToken(token);
  if (!user) return res.redirect("/login");
  req.user = user;
  next();
}

module.exports = {
  // restrictToLoginUserOnly,
  checkHeaderAuthentication,
  checkForAuthentication,
  restrictTo,
};

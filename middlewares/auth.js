const { getUserToken } = require("../service/auth");

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



function checkHeaderAuthentication(req, res, next) {
  const authorizationHeaderValue = req.headers["authorization"];
  req.user = null;

  console.log('req.path',req.path);

  // Debug logging for this specific route
  if (req.path === '/api/user/user_company') {
    console.log('🔍 DEBUG: /api/user/user_company route hit');
    console.log('📝 Method:', req.method);
    console.log('📝 Path:', req.path);
    console.log('📝 URL:', req.url);
    console.log('📝 Authorization Header:', authorizationHeaderValue ? 'Present' : 'Missing');
  }

  // Allow public routes that don't need authentication
  const publicRoutePatterns = [
    '/user/login',                     // Direct route access
    '/user/create',                    // Direct route access
    '/api/user/login',                 // API route access
    '/api/user/create',                // API route access
    '/login/admin',                // Admin login
    '/api/login/admin',                // Admin login
    '/api/blog/get-all',               // Public blog routes
    '/api/blog/get-all-active',        // Public blog routes
    // '/api/product/get-all',            // Public product routes
    // '/api/user/get-all',               // Public user routes
    '/user/user_company',               // Public user routes
    // '/api/user/user_company',               // Public user routes
    /^\/api\/blog\/get\/.*/,          // /api/blog/get/:id
    /^\/api\/product\/get\/.*/,       // /api/product/get/:id
    /^\/api\/user\/get\/.*/,          // /api/user/get/:id
    '/api/test'                        // Test route
  ];

  // Check if current route should be public
  const isPublicRoute = publicRoutePatterns.some(pattern => {
    const match = typeof pattern === 'string' 
      ? req.path === pattern 
      : pattern instanceof RegExp 
        ? pattern.test(req.path) 
        : false;
    
    // Debug logging for this specific route
    if (req.path === '/api/user/user_company') {
      console.log(`🔍 Checking pattern: ${pattern} -> Match: ${match}`);
    }
    
    return match;
  });
  
  // Debug logging for this specific route
  if (req.path === '/api/user/user_company') {
    console.log('🔍 isPublicRoute:', isPublicRoute);
  }
  
  if (isPublicRoute) {
    console.log('✅ Public route - skipping auth check');
    return next();
  }

  if (!authorizationHeaderValue) {
    return res.status(401).json({
      success: false,
      error: "Authorization header is required",
      message: "Please provide authorization token in the header"
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
      message: "Please provide a valid authorization token"
    });
  }
  
  req.user = user;
  return next();
}

function restrictTo(roles) {
  return function (req, res, next) {
    if (!req.user) return res.redirect("/login/admin");

    console.log("Current user : " + req.user.email, req.user.role);

    // Check if user has any of the required roles (user.role is an array)
    const userHasRole = req.user.role.some(userRole => roles.includes(userRole));
    if (!userHasRole) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Insufficient privileges.",
        required: roles,
        current: req.user.role
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

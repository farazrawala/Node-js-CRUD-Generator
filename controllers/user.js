const User = require("../models/user");
const { setUserToken } = require("../service/auth");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  handleGenericGetById
} = require("../utils/modelHelper");

async function handleUserSignup(req, res) {
  const response = await handleGenericCreate(req, "user", {
    excludeFields: ["password"], // Don't return password in response
    beforeCreate: async (userData, req) => {
      console.log("🔐 Processing user signup...");
    },
    afterCreate: async (record, req) => {
      console.log("✅ Record created successfully:", record);
    },
  });

  if (response.success) {
    // Redirect to thank you page on successful signup
    return res.redirect("/thankyou");
  } else {
    // Return JSON error for failed signup
    return res.status(response.status).json(response);
  }
}

async function handleUserUpdate(req, res) {
  const response = await handleGenericUpdate(req, "user", {
    excludeFields: ["password"], // Don't return password in response
    // allowedFields: [] - Empty array means allow all fields except password (dynamic)
    beforeUpdate: async (updateData, req, existingUser) => {
      console.log("🔧 Processing user update...", {
        userId: existingUser._id,
        currentName: existingUser.name,
        newName: updateData.name,
        currentEmail: existingUser.email,
        newEmail: updateData.email,
        hasProfileImage: !!req.files?.profile_image,
        updateFields: Object.keys(updateData),
      });
    },
    afterUpdate: async (record, req, existingUser) => {
      console.log("✅ Record updated successfully:", record);
    },
  });

  return res.status(response.status).json(response);
}

async function handleUserLogin(req, res) {
  try {
    console.log("🔐 Login attempt:", {
      email: req.body.email,
      time: new Date().toISOString(),
    });
    
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    // Find user by email only
    const user = await User.findOne({ email: email.toLowerCase() , role: { $in: ["ADMIN", "USER"] } });
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    // Verify password using the comparePassword method
    const isPasswordValid = await user.comparePassword(password);
    
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    console.log("📞 About to call setUserToken with user:", user);
    const userWithToken = setUserToken(user);
    console.log("📞 setUserToken returned:", userWithToken);

    // Set cookie for regular user login too
    res.cookie("token", userWithToken.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      user: userWithToken
    });

  } catch (error) {
    console.error("❌ User login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
}


async function userById(req, res) {
  const response = await handleGenericGetById(req, "user", {
    excludeFields: [], // Don't exclude any fields
  });
  return res.status(response.status).json(response);
}

async function getAllUser(req, res) {
  const response = await handleGenericGetAll(req, "user", {
    excludeFields: [], // Don't exclude any fields
    sort: { createdAt: -1 }, // Sort by newest first
    limit: req.query.limit ? parseInt(req.query.limit) : null, // Support limit from query params
    skip: req.query.skip ? parseInt(req.query.skip) : 0, // Support skip from query params
  });
  return res.status(response.status).json(response);
}

async function handleAdminLogin(req, res) {
  try {
    console.log("🔐 Admin login attempt:", {
      email: req.body.email,
      time: new Date().toISOString(),
    });

    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and password are required" 
      });
    }
    
    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });
    
    if (!user) {
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password" 
      });
    }

    // Check if user is admin (role is stored as array)
    if (!user.role.includes("ADMIN")) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. Admin privileges required." 
      });
    }

    // Verify password using the comparePassword method
    const isPasswordValid = await user.comparePassword(password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ 
        success: false, 
        message: "Invalid email or password" 
      });
    }

    // Generate JWT token using setUserToken
    const userWithToken = setUserToken(user);
    const token = userWithToken.token;

    // Set cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    console.log("✅ Admin login successful for:", user.email);

    res.status(200).json({ 
      success: true, 
      message: "Admin login successful",
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        name: user.name
      }
    });

  } catch (error) {
    console.error("❌ Admin login error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
}


module.exports = {
  handleUserSignup,
  handleUserLogin,
  handleUserUpdate,
  userById,
  getAllUser,
  handleAdminLogin
};

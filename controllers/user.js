const mongoose = require("mongoose");
const User = require("../models/user");
const { setUserToken } = require("../service/auth");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  handleGenericGetById,
  handleGenericFindOne,
} = require("../utils/modelHelper");
const { performAccountCreate } = require("./account");

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
        message: "Email and password are required",
      });
    }

    // Find user by email only
    const user = await User.findOne({
      email: email.toLowerCase(),
      // role: { $in: ["ADMIN", "USER"] },
      // active: true,
    }).populate({
      path: "company_id",
      // `warehouse_id` is not defined in company schema, so avoid nested populate.
      select:
        "company_name company_email company_phone company_address company_logo",
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Verify password using the comparePassword method
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const userWithToken = setUserToken(user);
    console.log("📞 setUserToken returned:", userWithToken);
    console.log("📞 userWithToken.company_id:", userWithToken.company_id);

    // Set cookie for regular user login too
    res.cookie("token", userWithToken.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Ensure company data is included in response
    // Explicitly preserve populated company data
    const responseData = {
      success: true,
      message: "Login successful",
      user: userWithToken,
    };

    return res.status(200).json(responseData);
  } catch (error) {
    console.error("❌ User login error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
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

function safeBodyPreview(body) {
  try {
    return JSON.stringify(body, null, 2);
  } catch (e) {
    return `[body not JSON-serializable: ${e.message}]`;
  }
}

/** Clone-like request so `body`/`params` overrides are visible to modelHelper (some parsers ignore `req.body = …`). */
function requestWithOverrides(req, overrides) {
  return Object.assign(
    Object.create(Object.getPrototypeOf(req)),
    req,
    overrides,
  );
}

async function handleUserSignupCompany(req, res) {
  try {
    console.log("🚀 Starting handleUserSignupCompany function...");
    console.log("📧 Request body:", safeBodyPreview(req.body));

    const emailRaw = req.body && req.body.email;
    const email =
      typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
    if (!email || !req.body.password || !String(req.body.password).length) {
      return res.status(400).json({
        success: false,
        message: "email and password are required",
      });
    }
    if (!req.body.company_name || !String(req.body.company_name).trim()) {
      return res.status(400).json({
        success: false,
        message: "company_name is required",
      });
    }

    // Check if email already exists (handleGenericFindOne returns 404 when not found)
    const find_email = await handleGenericFindOne(req, "user", {
      searchCriteria: { email },
    });

    if (find_email.success && find_email.data) {
      console.log("❌ Email already exists:", email);
      return res.status(400).json({
        success: false,
        message: "Email already exists",
      });
    }
    if (!find_email.success && find_email.status !== 404) {
      return res.status(find_email.status || 500).json({
        success: false,
        message: "Could not verify email",
        details: find_email,
      });
    }

    console.log("🏢 Creating company...");

    const create_company = await handleGenericCreate(req, "company", {
      beforeCreate: async (data, req) => {
        console.log("🏢 Company beforeCreate hook called");
        const cn = String(req.body.company_name || "").trim();
        const em = String(req.body.email || "").trim();
        data.company_name = cn ? `${cn} (${em})` : `Company (${em})`;
        data.company_email = req.body.company_email || req.body.email;
        data.company_phone = req.body.company_phone || "N/A";
        data.company_address =
          req.body.company_address || req.body.address || "Default Address";
        data.status = "active";
        console.log(
          "🏢 Company data after setting:",
          JSON.stringify(data, null, 2),
        );
      },
    });

    if (!create_company.success) {
      console.log("❌ Company creation failed:", create_company);
      return res.status(create_company.status || 500).json({
        success: false,
        message: "Company creation failed",
        details: create_company,
      });
    }

    const companyIdRaw = create_company.data && create_company.data._id;
    if (!companyIdRaw) {
      return res.status(500).json({
        success: false,
        message: "Company created but response had no _id",
        details: create_company,
      });
    }
    const companyId =
      companyIdRaw instanceof mongoose.Types.ObjectId ?
        companyIdRaw
      : new mongoose.Types.ObjectId(String(companyIdRaw));

    console.log("✅ Company created:", companyId);
    console.log("🏪 About to create warehouse...");

    const signupBodySnapshot = { ...req.body };
    const warehouseName = "Head Office " + (req.body.company_name || "");
    // Only warehouse schema fields — avoids form permissions / extra keys breaking generic create
    const warehousePayload = {
      name: warehouseName,
      company_id: companyId,
      status: "active",
    };
    console.log("🏪 Warehouse create payload:", warehousePayload);

    const create_warehouse = await handleGenericCreate(
      requestWithOverrides(req, { body: warehousePayload }),
      "warehouse",
      {},
    );

    if (!create_warehouse.success) {
      console.log("❌ Warehouse creation failed:", create_warehouse);
      return res.status(create_warehouse.status || 500).json({
        success: false,
        message: "Warehouse creation failed",
        details: create_warehouse,
      });
    }

    console.log("👤 Creating user before chart (GL postings need user_id)...");

    const user_created = await handleGenericCreate(req, "user", {
      excludeFields: ["password"],
      beforeCreate: async (data, req) => {
        console.log("👤 User beforeCreate hook called");
        data.email = email;
        data.name = (req.body.name && String(req.body.name).trim()) || "User";
        data.password = req.body.password;
        data.company_id = companyId;
        data.role = ["USER", "ADMIN"];
        console.log("👤 User data:", JSON.stringify(data, null, 2));
      },
    });

    if (!user_created.success) {
      console.log("❌ User creation failed:", user_created);
      return res.status(user_created.status || 500).json({
        success: false,
        message: "User creation failed",
        details: user_created,
      });
    }

    const postingUser = {
      _id: user_created.data._id,
      company_id: companyId,
    };

    // account_type must match models/account.js enum exactly
    const accounts = [
      { name: "Cash", account_type: "current_asset" },
      { name: "Accounts Receivable", account_type: "current_asset" },
      { name: "Sales", account_type: "revenue" },
      { name: "Purchase", account_type: "cost_of_goods_sold_account" },
      { name: "Purchase Discount", account_type: "other" },
      { name: "Accounts Payable", account_type: "liability" },
      { name: "Sales Discount", account_type: "other" },
      { name: "Shipping", account_type: "operating_expense" },
      { name: "Expense", account_type: "operating_expense" },
      { name: "Salary", account_type: "operating_expense" },
      { name: "Equity", account_type: "equity" },
      { name: "Other Expense", account_type: "other_expense" },
      { name: "Utilities", account_type: "operating_expense" },
    ];

    // Create Equity first so opening-balance journals can resolve the contra account;
    // keep `createdAccountsData` in the original order for company default_* fields.
    const equitySpec = accounts.find((a) => a.account_type === "equity");
    const accountCreateOrder =
      equitySpec ?
        [equitySpec, ...accounts.filter((a) => a.account_type !== "equity")]
      : [...accounts];

    const createdByName = Object.create(null);
    for (const account of accountCreateOrder) {
      const accountPayload = {
        name: account.name,
        account_type: account.account_type,
        company_id: companyId,
        status: "active",
      };
      const accountResult = await performAccountCreate(
        requestWithOverrides(req, {
          body: accountPayload,
          user: postingUser,
        }),
        true,
      );
      if (!accountResult.success) {
        console.log(
          "❌ Default account creation failed:",
          account.name,
          accountResult,
        );
        return res.status(accountResult.status || 500).json({
          success: false,
          message: "Default chart of accounts creation failed",
          details: { account: account.name, result: accountResult },
        });
      }
      createdByName[account.name] = accountResult.data;
    }

    const createdAccountsData = accounts.map((a) => createdByName[a.name]);

    req.body = signupBodySnapshot;

    // Update company with warehouse_id
    const originalBody = { ...req.body };
    const originalParams = { ...req.params };

    const updateCompany = await handleGenericUpdate(
      requestWithOverrides(req, {
        params: { ...originalParams, id: companyId },
        body: {
          warehouse_id: create_warehouse.data._id,
          default_cash_account: createdAccountsData[0]._id,
          default_account_receivable_account: createdAccountsData[1]._id,
          default_sales_account: createdAccountsData[2]._id,
          default_purchase_account: createdAccountsData[3]._id,
          default_purchase_discount_account: createdAccountsData[4]._id,
          default_account_payable_account: createdAccountsData[5]._id,
          default_sales_discount_account: createdAccountsData[6]._id,
          default_shipping_account: createdAccountsData[7]._id,
          default_expense_account: createdAccountsData[8]._id,
          default_salary_account: createdAccountsData[9]._id,
          default_equity_account_id: createdAccountsData[10]._id,
          default_other_expense_account: createdAccountsData[11]._id,
          default_utilities_account: createdAccountsData[12]._id,
        },
      }),
      "company",
      {},
    );

    // Restore original req.body and req.params for subsequent operations (user creation)
    req.body = originalBody;
    req.params = originalParams;

    if (!updateCompany.success) {
      console.log("❌ Company warehouse_id update failed:", updateCompany);
      return res.status(200).json({
        success: false,
        message: "Failed to update company with warehouse_id",
        details: updateCompany,
      });
    }

    console.log(
      "✅ Company updated with warehouse_id:",
      create_warehouse.data._id,
    );

    console.log("✅ Warehouse created:", create_warehouse.data._id);
    console.log("✅ User created:", user_created.data._id);

    return res.status(200).json({
      success: true,
      message: "Company signup completed successfully",
      data: {
        company: create_company.data,
        warehouse: create_warehouse.data,
        user: user_created.data,
        accounts: createdAccountsData,
      },
    });
  } catch (error) {
    console.error("❌ Company user signup error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Internal server error during company signup",
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
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
        message: "Email and password are required",
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Check if user is admin (role is stored as array)
    if (!user.role.includes("ADMIN")) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Admin privileges required.",
      });
    }

    // Verify password using the comparePassword method
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
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
        name: user.name,
      },
    });
  } catch (error) {
    console.error("❌ Admin login error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
}

// Example: Find user by email using the new generic function
async function findUserByEmail(req, res) {
  // console.log("🔍 Searching for user with email:", req.body.email);
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: {
      email: req.body.email.toLowerCase(),
    },
    excludeFields: ["password"], // Never return password
    beforeFind: async (criteria, req) => {
      console.log("🔍 Searching for user with email:", criteria.email);
      return criteria;
    },
    afterFind: async (record, req) => {
      console.log("✅ Found user:", record.email);
    },
  });
  return res.status(response.status).json(response);
}

// Example: Find user by company name
async function findUserByCompany(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: {
      company_name: req.body.company_name,
    },
    excludeFields: ["password"],
    includeFields: ["name", "email", "company_name", "phone", "createdAt"], // Only return specific fields
  });
  return res.status(response.status).json(response);
}

// Example: Find active user with specific role
async function findActiveUserByRole(req, res) {
  const { role, email } = req.body;

  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: {
      role: { $in: [role] }, // MongoDB array contains operator
      email: email.toLowerCase(),
      active: true, // Assuming you have an active field
    },
    excludeFields: ["password"],
    sort: { lastLoginAt: -1 }, // Get the most recently active user
  });
  return res.status(response.status).json(response);
}

module.exports = {
  handleUserSignup,
  handleUserLogin,
  handleUserUpdate,
  userById,
  getAllUser,
  handleAdminLogin,
  handleUserSignupCompany,
  findUserByEmail,
  findUserByCompany,
  findActiveUserByRole,
};

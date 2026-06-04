const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/user");
const { setUserToken } = require("../service/auth");
const { generateTransactionNumber } = require("../utils/transactionNumber");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  handleGenericGetById,
  handleGenericFindOne,
  coalesceObjectId,
} = require("../utils/modelHelper");
const { performAccountCreate } = require("./account");
const Company = require("../models/company");
const Warehouse = require("../models/warehouse");
const Account = require("../models/account");
const Transaction = require("../models/transaction");
const { createTransactionsFromItems } = require("./transaction");
const { buildUserCompanyPopulate } = require("../utils/userCompanyPopulate");
const {
  logRollbackFailure,
  serializeErrorForLog,
} = require("../utils/logControllerError");
const { isMongoTransactionUnsupportedError } = require("../utils/mongoTransactionSupport");

/**
 * Build & post the 2-line user opening journal. Does not touch `user.transaction_number`.
 * @param {import("mongoose").ClientSession | null} [session]
 * @returns {{ ok: boolean, transaction_number: string | null, skipped: boolean }}
 */
async function executeUserInitialBalanceJournal(userDoc, req, session = null) {
  const openingRaw = Number(userDoc?.initial_balance ?? 0);
  if (Number.isNaN(openingRaw) || openingRaw === 0) {
    return { ok: true, transaction_number: null, skipped: true };
  }

  const companyId = userDoc.company_id;
  if (!companyId) {
    console.warn("⚠️ Skipping user initial_balance GL: user has no company_id");
    return { ok: true, transaction_number: null, skipped: true };
  }

  let companyQ = Company.findById(companyId).select(
    "default_account_receivable_account default_account_payable_account default_equity_account_id",
  );
  if (session) {
    companyQ = companyQ.session(session);
  }
  const company = await companyQ.lean();

  const arId = company?.default_account_receivable_account;
  const apId = company?.default_account_payable_account;
  const equityId = company?.default_equity_account_id;

  if (openingRaw > 0) {
    if (!arId || !equityId) {
      console.warn(
        "⚠️ Skipping user initial_balance GL: company missing default_account_receivable_account or default_equity_account_id",
      );
      return { ok: false, transaction_number: null, skipped: false };
    }
  } else {
    if (!equityId || !apId) {
      console.warn(
        "⚠️ Skipping user initial_balance GL: company missing default_equity_account_id or default_account_payable_account",
      );
      return { ok: false, transaction_number: null, skipped: false };
    }
  }

  const posterId = userDoc._id;
  if (!posterId) {
    return { ok: false, transaction_number: null, skipped: false };
  }

  const transaction_number = generateTransactionNumber();
  const amount = Math.abs(openingRaw);

  const transcReq = Object.assign(
    Object.create(Object.getPrototypeOf(req)),
    req,
    { user: { _id: posterId, company_id: companyId } },
  );

  const userCreatedAt = userDoc?.createdAt;
  const postingBase = {
    company_id: companyId,
    user_id: posterId,
    reference_user_id: posterId,
    transaction_number,
    description: "User initial balance",
    amount,
    ...(userCreatedAt ?
      {
        createdAt:
          userCreatedAt instanceof Date ? userCreatedAt : (
            new Date(userCreatedAt)
          ),
      }
    : {}),
  };

  const transactionData =
    openingRaw > 0 ?
      [
        { ...postingBase, account_id: arId, type: "debit" },
        { ...postingBase, account_id: equityId, type: "credit" },
      ]
    : [
        { ...postingBase, account_id: equityId, type: "debit" },
        { ...postingBase, account_id: apId, type: "credit" },
      ];

  const bulkOpts = { stopOnError: true };
  if (session) {
    bulkOpts.session = session;
  }
  const { failed, created } = await createTransactionsFromItems(
    transcReq,
    transactionData,
    bulkOpts,
  );

  if (failed.length) {
    console.error(
      "⚠️ Post-user initial_balance transaction bulk insert failed:",
      JSON.stringify(failed),
    );
    return { ok: false, transaction_number: null, skipped: false };
  }

  if (!created.length) {
    return { ok: false, transaction_number: null, skipped: false };
  }

  return {
    ok: true,
    transaction_number,
    skipped: false,
  };
}

/**
 * Called after dynamic `POST /api/user/create` when `initial_balance` is non-zero.
 * Positive: debit A/R, credit equity. Negative: debit equity, credit A/P.
 */
async function postTransactionsForUserInitialBalance(
  record,
  req,
  session = null,
) {
  const result = await executeUserInitialBalanceJournal(record, req, session);
  if (!result.ok || result.skipped || !result.transaction_number) {
    return;
  }

  if (record && typeof record.save === "function") {
    record.transaction_number = result.transaction_number;
    await record.save(session ? { session } : {});
  }
}

/**
 * On user update: post new journal first (or none if balance is 0), then delete the
 * previous batch by `transaction_number` so a failed re-post does not wipe old GL lines.
 */
async function reconcileUserInitialBalanceOnUpdate(
  updatedRecord,
  req,
  existingRecord,
  session = null,
) {
  const prevTn = existingRecord.transaction_number;

  const result = await executeUserInitialBalanceJournal(
    updatedRecord,
    req,
    session,
  );

  if (!result.ok) {
    return;
  }

  const deleteOpts = session ? { session } : {};

  if (result.skipped || !result.transaction_number) {
    if (prevTn) {
      const q = { transaction_number: prevTn };
      if (existingRecord.company_id) {
        q.company_id = existingRecord.company_id;
      }
      await Transaction.deleteMany(q, deleteOpts);
    }
    updatedRecord.transaction_number = null;
    await updatedRecord.save(session ? { session } : {});
    return;
  }

  if (prevTn && prevTn !== result.transaction_number) {
    const q = { transaction_number: prevTn };
    if (existingRecord.company_id) {
      q.company_id = existingRecord.company_id;
    }
    await Transaction.deleteMany(q, deleteOpts);
  }

  updatedRecord.transaction_number = result.transaction_number;
  await updatedRecord.save(session ? { session } : {});
}

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
      const rawPassword = req.body?.password;
      if (rawPassword != null && String(rawPassword).trim()) {
        const bcrypt = require("bcrypt");
        const salt = await bcrypt.genSalt(10);
        updateData.password = await bcrypt.hash(String(rawPassword).trim(), salt);
      }
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
    }).populate(buildUserCompanyPopulate());

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

function throwWithSignupFailure(response, fallbackMessage) {
  const err = new Error(
    response?.error ||
      response?.message ||
      fallbackMessage ||
      "Company signup step failed",
  );
  err.statusCode = response?.status || 400;
  err.responseType = response?.type || "validation";
  err.details = response?.details ?? response?.missing ?? response;
  err.clientErrorPayload = response;
  throw err;
}

function userCompanySignupLogContext(req, extra = {}) {
  const emailRaw = req.body?.email;
  const email =
    typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  return {
    email,
    company_name: req.body?.company_name,
    ...extra,
  };
}

function trackId(tracker, field, id) {
  if (id == null) return;
  const oid =
    id instanceof mongoose.Types.ObjectId ?
      id
    : new mongoose.Types.ObjectId(String(id));
  if (field === "companyId") {
    tracker.companyId = oid;
    return;
  }
  if (field === "warehouseId") {
    tracker.warehouseId = oid;
    return;
  }
  if (!tracker[field]) tracker[field] = [];
  tracker[field].push(oid);
}

/** Compensating soft-delete when Mongo multi-doc transactions are unavailable. */
async function rollbackUserCompanySignup(tracker, req, session = null) {
  if (!tracker?.companyId) return;

  const opts = session ? { session } : {};
  const softDeleteSet = { deletedAt: new Date(), status: "inactive" };
  const companyId = tracker.companyId;

  if (tracker.accountIds?.length) {
    await Transaction.updateMany(
      {
        company_id: companyId,
        account_id: { $in: tracker.accountIds },
        deletedAt: null,
      },
      { $set: softDeleteSet },
      opts,
    );
    await Account.updateMany(
      { _id: { $in: tracker.accountIds }, company_id: companyId },
      { $set: softDeleteSet },
      opts,
    );
  }

  if (tracker.userIds?.length) {
    await User.updateMany(
      { _id: { $in: tracker.userIds }, company_id: companyId },
      { $set: softDeleteSet },
      opts,
    );
  }

  if (tracker.warehouseId) {
    await Warehouse.updateOne(
      { _id: tracker.warehouseId, company_id: companyId },
      { $set: softDeleteSet },
      opts,
    );
  }

  await Company.updateOne(
    { _id: companyId },
    { $set: softDeleteSet },
    opts,
  );

  console.warn(
    `⚠️ user_company signup compensating rollback: company ${companyId}`,
  );
}

async function runUserCompanySignupWithOptionalTransaction(runFlow) {
  let session = null;
  let txnError = null;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runFlow(session);
    });
  } catch (error) {
    if (isMongoTransactionUnsupportedError(error)) {
      if (session) {
        try {
          session.endSession();
        } catch (_) {
          /* ignore */
        }
        session = null;
      }
      try {
        await runFlow(null);
      } catch (retryError) {
        txnError = retryError;
      }
    } else {
      txnError = error;
    }
  } finally {
    if (session) {
      try {
        session.endSession();
      } catch (_) {
        /* ignore */
      }
    }
  }
  return txnError;
}

/**
 * GET count of tenant users whose `role` includes CUSTOMER (active, not soft-deleted).
 */
async function countTotalCustomers(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const customer_count = await User.countDocuments({
      company_id: cid,
      role: "CUSTOMER",
      status: "active",
      deletedAt: null,
    });

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      customer_count,
    });
  } catch (error) {
    console.error("countTotalCustomers:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * GET count of all tenant users (active, not soft-deleted) for the authenticated company.
 */
async function countTotalUsers(req, res) {
  try {
    const rawCompany = req.user?.company_id;
    const companyId =
      rawCompany && typeof rawCompany === "object" && rawCompany._id ?
        rawCompany._id
      : rawCompany;
    if (!companyId) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Authentication with company context is required",
      });
    }

    const companyObjectId = coalesceObjectId(companyId);
    if (
      !companyObjectId ||
      !mongoose.Types.ObjectId.isValid(String(companyObjectId))
    ) {
      return res.status(400).json({
        success: false,
        status: 400,
        error: "company_id is required",
        message: "Invalid company context",
      });
    }

    const cid = new mongoose.Types.ObjectId(String(companyObjectId));
    const user_count = await User.countDocuments({
      company_id: cid,
      status: "active",
      deletedAt: null,
    });

    return res.status(200).json({
      success: true,
      status: 200,
      company_id: String(cid),
      user_count,
    });
  } catch (error) {
    console.error("countTotalUsers:", error);
    return res.status(500).json({
      success: false,
      status: 500,
      error: error.message || "Internal server error",
    });
  }
}

/**
 * Tenant bootstrap inside a transaction when the deployment supports it.
 * @returns {Promise<object>} Success payload for JSON response (`data` key).
 */
async function runUserCompanySignupBody(req, session, tracker) {
  const emailRaw = req.body && req.body.email;
  const email =
    typeof emailRaw === "string" ? emailRaw.trim().toLowerCase() : "";
  const txnOpts = session ? { session } : {};

  tracker.signup_step = "company";
  const create_company = await handleGenericCreate(req, "company", {
    ...txnOpts,
    beforeCreate: async (data) => {
      const cn = String(req.body.company_name || "").trim();
      const em = String(req.body.email || "").trim();
      data.company_name = cn ? `${cn} (${em})` : `Company (${em})`;
      data.company_email = req.body.company_email || req.body.email;
      data.company_phone = req.body.company_phone || "N/A";
      data.company_address =
        req.body.company_address || req.body.address || "Default Address";
      data.status = "active";
    },
  });
  if (!create_company.success) {
    throwWithSignupFailure(create_company, "Company creation failed");
  }
  const companyIdRaw = create_company.data?._id;
  if (!companyIdRaw) {
    const err = new Error("Company created but response had no _id");
    err.statusCode = 500;
    err.details = create_company;
    throw err;
  }
  const companyId =
    companyIdRaw instanceof mongoose.Types.ObjectId ?
      companyIdRaw
    : new mongoose.Types.ObjectId(String(companyIdRaw));
  trackId(tracker, "companyId", companyId);

  const signupBodySnapshot = { ...req.body };
  tracker.signup_step = "warehouse";
  const warehouseName = "Head Office " + (req.body.company_name || "");
  const warehousePayload = {
    name: warehouseName,
    company_id: companyId,
    status: "active",
  };
  const create_warehouse = await handleGenericCreate(
    requestWithOverrides(req, { body: warehousePayload }),
    "warehouse",
    txnOpts,
  );
  if (!create_warehouse.success) {
    throwWithSignupFailure(create_warehouse, "Warehouse creation failed");
  }
  trackId(tracker, "warehouseId", create_warehouse.data?._id);

  tracker.signup_step = "admin_user";
  const user_created = await handleGenericCreate(req, "user", {
    ...txnOpts,
    excludeFields: ["password"],
    beforeCreate: async (data) => {
      data.email = email;
      data.name = (req.body.name && String(req.body.name).trim()) || "User";
      data.password = req.body.password;
      data.company_id = companyId;
      data.role = ["USER", "ADMIN"];
    },
  });
  if (!user_created.success) {
    throwWithSignupFailure(user_created, "User creation failed");
  }
  trackId(tracker, "userIds", user_created.data?._id);

  tracker.signup_step = "default_user";
  const defaultUserEmail = `default.${crypto.randomBytes(8).toString("hex")}@gmail.com`;
  const user_default_created = await handleGenericCreate(
    requestWithOverrides(req, {
      body: { status: "active", company_id: companyId },
    }),
    "user",
    {
      ...txnOpts,
      excludeFields: ["password"],
      beforeCreate: async (data) => {
        data.email = defaultUserEmail;
        data.name = "Default User";
        data.password = defaultUserEmail;
        data.company_id = companyId;
        data.role = ["USER", "CUSTOMER", "VENDOR"];
      },
    },
  );
  if (!user_default_created.success) {
    throwWithSignupFailure(
      user_default_created,
      "Default user creation failed",
    );
  }
  trackId(tracker, "userIds", user_default_created.data?._id);

  const postingUser = {
    _id: user_created.data._id,
    company_id: companyId,
  };

  const accounts = [
    { name: "Cash", account_type: "current_asset" },
    { name: "Accounts Receivable", account_type: "current_asset" },
    { name: "Sales", account_type: "revenue" },
    { name: "Purchase", account_type: "cost_of_goods_sold_account" },
    { name: "Purchase Discount", account_type: "other" },
    { name: "Accounts Payable", account_type: "current_liability" },
    { name: "Sales Discount", account_type: "other" },
    { name: "Shipping", account_type: "operating_expense" },
    { name: "Expense", account_type: "operating_expense" },
    { name: "Salary", account_type: "operating_expense" },
    { name: "Equity", account_type: "equity" },
    { name: "Other Expense", account_type: "other_expense" },
    { name: "Utilities", account_type: "operating_expense" },
    { name: "Fixed Asset", account_type: "fixed_asset" },
    { name: "Adjustment", account_type: "equity" },
    { name: "Withdraw", account_type: "other_expense" },
  ];

  const equitySpec = accounts.find(
    (a) => a.name === "Equity" && a.account_type === "equity",
  );
  const accountCreateOrder =
    equitySpec ?
      [equitySpec, ...accounts.filter((a) => a.name !== "Equity")]
    : [...accounts];

  const createdByName = Object.create(null);
  tracker.signup_step = "chart_of_accounts";
  for (const account of accountCreateOrder) {
    tracker.signup_step = `account:${account.name}`;
    const accountResult = await performAccountCreate(
      requestWithOverrides(req, {
        body: {
          name: account.name,
          account_type: account.account_type,
          company_id: companyId,
          status: "active",
        },
        user: postingUser,
      }),
      true,
      txnOpts,
    );
    if (!accountResult.success) {
      const err = new Error(
        `Default chart of accounts creation failed: ${account.name}`,
      );
      err.statusCode = accountResult.status || 500;
      err.details = { account: account.name, result: accountResult };
      err.clientErrorPayload = {
        success: false,
        message: "Default chart of accounts creation failed",
        details: { account: account.name, result: accountResult },
      };
      throw err;
    }
    trackId(tracker, "accountIds", accountResult.data?._id);
    createdByName[account.name] = accountResult.data;
  }

  const createdAccountsData = accounts.map((a) => createdByName[a.name]);
  const missingCoa = accounts
    .map((a, i) => (!createdAccountsData[i]?._id ? a.name : null))
    .filter(Boolean);
  if (missingCoa.length) {
    const err = new Error("Default chart of accounts incomplete after signup");
    err.statusCode = 500;
    err.details = { missing_accounts: missingCoa };
    throw err;
  }

  req.body = signupBodySnapshot;
  const originalBody = { ...req.body };
  const originalParams = { ...req.params };

  tracker.signup_step = "company_defaults_patch";
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
        default_fixed_asset_account: createdAccountsData[13]._id,
        default_adjustment_account: createdAccountsData[14]._id,
        default_withdraw_account: createdAccountsData[15]._id,
      },
    }),
    "company",
    txnOpts,
  );

  req.body = originalBody;
  req.params = originalParams;

  if (!updateCompany.success) {
    const err = new Error("Failed to update company with warehouse_id");
    err.statusCode = 200;
    err.clientErrorPayload = {
      success: false,
      message: "Failed to update company with warehouse_id",
      details: updateCompany,
    };
    err.details = updateCompany;
    throw err;
  }

  tracker.signup_step = "completed";
  return {
    company: create_company.data,
    warehouse: create_warehouse.data,
    user: user_created.data,
    default_user: user_default_created.data,
    accounts: createdAccountsData,
  };
}

/**
 * POST /api/user/user_company — bootstrap a new tenant: company, default warehouse, first admin user,
 * default chart of accounts, then wire `company` default GL / warehouse refs.
 *
 * Uses `session.withTransaction` when supported; on standalone Mongo, retries without a session
 * and runs compensating soft-delete on failure. Failures are written to `logs` via `logRollbackFailure`.
 */
async function handleUserSignupCompany(req, res) {
  const tracker = {
    signup_step: "validation",
    companyId: null,
    warehouseId: null,
    userIds: [],
    accountIds: [],
  };

  try {
    console.log("🚀 Starting handleUserSignupCompany...");
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

    const find_email = await handleGenericFindOne(req, "user", {
      searchCriteria: { email },
    });
    if (find_email.success && find_email.data) {
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

    let signupData = null;
    const txnError = await runUserCompanySignupWithOptionalTransaction(
      async (session) => {
        try {
          signupData = await runUserCompanySignupBody(req, session, tracker);
        } catch (stepError) {
          if (!session && tracker.companyId) {
            await rollbackUserCompanySignup(tracker, req, null);
          }
          throw stepError;
        }
      },
    );

    if (txnError) {
      console.error(
        "❌ handleUserSignupCompany failed:\n",
        serializeErrorForLog(txnError),
      );
      await logRollbackFailure(req, txnError, {
        action: "USER COMPANY SIGNUP ROLLBACK",
        tags: ["user", "user_company", "signup", "error"],
        fallbackUrl: "/api/user/user_company",
        context: userCompanySignupLogContext(req, {
          signup_step: tracker.signup_step,
          company_id: tracker.companyId,
          warehouse_id: tracker.warehouseId,
          user_ids: tracker.userIds,
          account_ids: tracker.accountIds,
          execution_mode:
            isMongoTransactionUnsupportedError(txnError) ?
              "no_mongodb_transaction_compensating_rollback"
            : "mongodb_transaction_aborted",
          api_client_error: txnError.clientErrorPayload ?? null,
        }),
        fallbackCompanyId: tracker.companyId,
      });

      if (txnError.clientErrorPayload) {
        const status = txnError.clientErrorPayload.status || 400;
        return res.status(status).json(txnError.clientErrorPayload);
      }
      return res.status(txnError.statusCode || 500).json({
        success: false,
        status: txnError.statusCode || 500,
        message: txnError.message || "Company signup failed",
        details: txnError.details ?? undefined,
        type: txnError.responseType || "internal",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Company signup completed successfully",
      data: signupData,
    });
  } catch (error) {
    console.error("❌ Company user signup error:", error);
    await logRollbackFailure(req, error, {
      action: "USER COMPANY SIGNUP ROLLBACK",
      tags: ["user", "user_company", "signup", "error", "outer"],
      fallbackUrl: "/api/user/user_company",
      context: userCompanySignupLogContext(req, {
        signup_step: tracker.signup_step,
        company_id: tracker.companyId,
      }),
      fallbackCompanyId: tracker.companyId,
    });
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
  countTotalCustomers,
  countTotalUsers,
  postTransactionsForUserInitialBalance,
  reconcileUserInitialBalanceOnUpdate,
};

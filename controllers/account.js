const mongoose = require("mongoose");
const {
  handleGenericCreate,
  handleGenericUpdate,
  handleGenericGetAll,
  parseSearchFieldsFromQuery,
} = require("../utils/modelHelper");
const Transaction = require("../models/transaction");
const Company = require("../models/company");
const AccountModel = require("../models/account");
const { logControllerError } = require("../utils/logControllerError");
const {
  createTransactionsFromItems: transactionBulkCreate,
} = require("./transaction");

const ACCOUNT_TRANSACTION_ERROR_LOG = {
  action: "POST ACCOUNT TRANSACTION ERROR",
  tags: [
    "api",
    "account",
    "transaction",
    "error",
    "insert",
    "update",
    "delete",
  ],
  fallbackUrl: "/api/account",
};

/** Must match `models/account.js` account_type enum */
const ACCOUNT_TYPES = new Set([
  "current_asset",
  "fixed_asset",
  "revenue",
  "cost_of_goods_sold_account",
  "operating_expense",
  "other_expense",
  "equity",
  "current_liability",
  "long_term_liability",
  "other",
]);

function makeNumberPositive(number) {
  return Math.abs(number);
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) {
    return toObjectId(value._id);
  }
  const s = String(value);
  return mongoose.Types.ObjectId.isValid(s) ?
      new mongoose.Types.ObjectId(s)
    : null;
}

/** Per-account GL line totals (same debit/credit convention as transaction list summary). */
async function aggregateTransactionSumsByAccountIds(accountIds, companyId) {
  if (!accountIds.length) return new Map();

  const match = {
    account_id: { $in: accountIds },
    deletedAt: null,
  };
  const coId = toObjectId(companyId);
  if (coId) match.company_id = coId;

  const rows = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$account_id",
        total_debit: {
          $sum: {
            $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0],
          },
        },
        total_credit: {
          $sum: {
            $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0],
          },
        },
        line_count: { $sum: 1 },
      },
    },
  ]);

  const map = new Map();
  for (const row of rows) {
    const totalDebit = Number((row.total_debit ?? 0).toFixed(2));
    const totalCredit = Number((row.total_credit ?? 0).toFixed(2));
    map.set(String(row._id), {
      total_debit: totalDebit,
      total_credit: totalCredit,
      line_count: row.line_count ?? 0,
      net_debit_minus_credit: Number((totalDebit - totalCredit).toFixed(2)),
      credit_minus_debit: Number((totalCredit - totalDebit).toFixed(2)),
    });
  }
  return map;
}

/**
 * Equity leg for opening-balance journals: populated company, DB default, or first equity GL.
 */
async function resolveDefaultEquityAccountId(record, transcReq) {
  const populatedCompany = transcReq.user?.company_id;
  if (populatedCompany && typeof populatedCompany === "object") {
    const id = populatedCompany.default_equity_account_id;
    if (id) return id;
  }
  if (record.company_id) {
    const comp = await Company.findById(record.company_id)
      .select("default_equity_account_id")
      .lean();
    if (comp?.default_equity_account_id) return comp.default_equity_account_id;
  }
  if (!record.company_id) return null;
  const eq = await AccountModel.findOne({
    company_id: record.company_id,
    account_type: "equity",
    status: "active",
    deletedAt: null,
  })
    .sort({ createdAt: 1 })
    .lean();
  return eq?._id ?? null;
}

/**
 * Same behavior as HTTP `accountCreate` but returns the generic-create response
 * (for internal callers such as company signup that are not Express handlers).
 */
async function performAccountCreate(req, comp_create = false) {
  console.log("🔐 Processing account creation...", req.user);
  const transaction_number = `TXN-${Date.now()}-${Math.floor(
    Math.random() * 1000000,
  )
    .toString()
    .padStart(6, "0")}`;

  req.body.transaction_number = transaction_number;
  req.body.is_editable = true;

  if (comp_create == true) {
    req.body.is_deletable = false;
    req.body.is_editable = req.body.name == "Cash" ? true : false;
  }

  return handleGenericCreate(req, "account", {
    beforeCreate: async (record, transcReq) => {
      console.log("🔍 Before Create_account", record);
      // return false;
    },
    // Always persist server-generated number (covers /account/create vs body-only edge cases)
    afterCreate: async (record, transcReq) => {
      console.log("✅ Record created successfully:", record);

      const openingRaw = Number(record?.initial_balance ?? 0);
      if (Number.isNaN(openingRaw)) {
        return;
      }

      const amount = makeNumberPositive(openingRaw);
      const equityAccountId = await resolveDefaultEquityAccountId(
        record,
        transcReq,
      );

      if (!equityAccountId) {
        console.warn(
          "⚠️ Skipping opening balance journal: no equity account resolved yet",
        );
        return;
      }
      if (String(equityAccountId) === String(record._id)) {
        return;
      }

      if (!transcReq.user?._id) {
        console.warn(
          "⚠️ Skipping opening balance journal: req.user._id missing (transactions require user_id)",
        );
        return;
      }

      try {
        const posting = {
          company_id: record.company_id,
          user_id: transcReq.user._id,
          description: "Account Initial Balance",
          amount,
          transaction_number,
        };

        let transactionData = [];
        if (
          record?.account_type == "current_asset" ||
          record?.account_type == "fixed_asset"
        ) {
          transactionData.push({
            ...posting,
            account_id: record._id,
            type: record?.initial_balance >= 0 ? "debit" : "credit",
          });
          transactionData.push({
            ...posting,
            account_id: equityAccountId,
            type: record?.initial_balance >= 0 ? "credit" : "debit",
          });
        } else if (record?.account_type == "liability") {
          transactionData.push({
            ...posting,
            account_id: record._id,
            type: record?.initial_balance >= 0 ? "credit" : "debit",
          });
          transactionData.push({
            ...posting,
            account_id: equityAccountId,
            type: record?.initial_balance >= 0 ? "debit" : "credit",
          });
        }

        console.log("🔍 Transaction Data:", transactionData);

        const { created, failed } = await transactionBulkCreate(
          transcReq,
          transactionData,
          { stopOnError: true },
        );

        if (failed.length) {
          console.error(
            "⚠️ Post-order transaction bulk insert failed:",
            failed,
          );
          await logControllerError(
            req,
            `Post-account transaction bulk insert failed: ${JSON.stringify(failed)}`,
            ACCOUNT_TRANSACTION_ERROR_LOG,
          );
        } else if (created[0]?.data?._id) {
          console.log(
            "✅ Transaction(s) created:",
            created.map((c) => c.data._id),
          );
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-account transaction error: ${e.message}`,
          ACCOUNT_TRANSACTION_ERROR_LOG,
        );
      }
    },
  });
}

async function accountCreate(req, res, comp_create = false) {
  const response = await performAccountCreate(req, comp_create);
  return res.status(response.status).json(response);
}

async function accountUpdate(req, res) {
  const response = await handleGenericUpdate(req, "account", {
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
    afterUpdate: async (record, transcReq, existingUser) => {
      console.log("✅ Record updated successfully:", record);

      try {
        const transaction_number = record?.transaction_number;
        const deleteTransc =
          transaction_number ?
            await Transaction.deleteMany({ transaction_number })
          : { deletedCount: 0 };
        if (deleteTransc.deletedCount > 0) {
          console.log("✅ Transaction deleted:", deleteTransc.deletedCount);
        }
        const amount = makeNumberPositive(Number(record?.initial_balance ?? 0));
        const equityAccountId = await resolveDefaultEquityAccountId(
          record,
          transcReq,
        );
        if (
          equityAccountId &&
          String(equityAccountId) !== String(record._id) &&
          transcReq.user?._id
        ) {
          const posting = {
            company_id: record.company_id,
            user_id: transcReq.user._id,
          };
          const { created, failed } = await transactionBulkCreate(
            transcReq,
            [
              {
                ...posting,
                account_id: record._id,
                type: record?.initial_balance > 0 ? "debit" : "credit",
                amount,
                transaction_number,
                description: "Account Initial Balance",
              },
              {
                ...posting,
                account_id: equityAccountId,
                type: record?.initial_balance > 0 ? "credit" : "debit",
                amount,
                transaction_number,
                description: "Account Initial Balance",
              },
            ],
            { stopOnError: true },
          );
          if (failed.length) {
            console.error(
              "⚠️ Post-order transaction bulk insert failed:",
              failed,
            );
            await logControllerError(
              req,
              `Post-account transaction bulk insert failed: ${JSON.stringify(failed)}`,
              ACCOUNT_TRANSACTION_ERROR_LOG,
            );
          } else if (created[0]?.data?._id) {
            console.log(
              "✅ Transaction(s) created:",
              created.map((c) => c.data._id),
            );
          }
        }
      } catch (e) {
        console.error("⚠️ Post-order transaction error:", e.message);
        await logControllerError(
          req,
          `Post-account transaction error: ${e.message}`,
          ACCOUNT_TRANSACTION_ERROR_LOG,
        );
      }
    },
  });

  return res.status(response.status).json(response);
}

/**
 * GET ?account_type=current_asset
 * Optional: limit, skip, search, searchFields (via handleGenericGetAll).
 * Each account includes `transactions_sum`: debit/credit totals, line_count,
 * `net_debit_minus_credit`, and `credit_minus_debit` for that GL.
 */
async function fetchAccountsByType(req, res) {
  const accountType = String(
    req.query.account_type ?? req.query.type ?? "",
  ).trim();

  if (!accountType) {
    return res.status(400).json({
      success: false,
      message:
        "Query parameter account_type is required (e.g. account_type=current_asset)",
    });
  }

  if (!ACCOUNT_TYPES.has(accountType)) {
    return res.status(400).json({
      success: false,
      message: `Invalid account_type. Allowed values: ${[...ACCOUNT_TYPES].join(", ")}`,
    });
  }

  const filter = {
    account_type: accountType,
    status: "active",
    deletedAt: null,
  };

  if (req.user?.company_id) {
    filter.company_id = req.user.company_id;
  }

  const response = await handleGenericGetAll(req, "account", {
    filter,
    sort: { name: 1 },
    limit: req.query.limit ? parseInt(req.query.limit, 10) : null,
    skip: req.query.skip ? parseInt(req.query.skip, 10) || 0 : 0,
    search: req.query.search,
    searchFields: parseSearchFieldsFromQuery(req.query.searchFields),
  });

  if (!response.success || !Array.isArray(response.data)) {
    return res.status(response.status || 200).json(response);
  }

  const accountObjectIds = response.data
    .map((a) => toObjectId(a._id))
    .filter(Boolean);

  const sumByAccount = await aggregateTransactionSumsByAccountIds(
    accountObjectIds,
    req.user?.company_id,
  );

  const emptySum = {
    total_debit: 0,
    total_credit: 0,
    line_count: 0,
    net_debit_minus_credit: 0,
    credit_minus_debit: 0,
  };

  response.data = response.data.map((acc) => ({
    ...acc,
    transactions_sum: sumByAccount.get(String(acc._id)) ?? { ...emptySum },
  }));

  return res.status(response.status || 200).json(response);
}

module.exports = {
  accountCreate,
  performAccountCreate,
  accountUpdate,
  fetchAccountsByType,
};

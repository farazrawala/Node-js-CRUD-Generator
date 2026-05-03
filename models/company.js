const mongoose = require("mongoose");

/** Default GL account refs on company — validated against tenant in pre("validate"). */
const COMPANY_DEFAULT_ACCOUNT_REF_FIELDS = [
  "default_cash_account",
  "default_sales_account",
  "default_purchase_account",
  "default_sales_discount_account",
  "default_purchase_discount_account",
  "default_account_receivable_account",
  "default_account_payable_account",
  "default_shipping_account",
  "default_equity_account_id",
];

/** Account.company_id must match this row’s `_id` and/or parent `company_id` (branch vs root). */
function allowedCompanyIdsForDefaultAccounts(doc) {
  const set = new Set();
  if (doc._id) set.add(String(doc._id));
  if (doc.company_id) set.add(String(doc.company_id));
  return set;
}

function getDocField(doc, field) {
  if (doc && typeof doc.get === "function") return doc.get(field);
  return doc[field];
}

async function validateCompanyDefaultAccountRefs(doc) {
  const allowed = allowedCompanyIdsForDefaultAccounts(doc);
  if (allowed.size === 0) return;

  let Account;
  try {
    Account = mongoose.model("account");
  } catch {
    const hasRef = COMPANY_DEFAULT_ACCOUNT_REF_FIELDS.some((f) => {
      const v = getDocField(doc, f);
      return v != null && v !== "";
    });
    if (hasRef) {
      throw new Error(
        "account model must be registered before validating company default GL refs",
      );
    }
    return;
  }

  for (const field of COMPANY_DEFAULT_ACCOUNT_REF_FIELDS) {
    const ref = getDocField(doc, field);
    if (ref == null || ref === "") continue;
    const acc = await Account.findById(ref).select("company_id").lean();
    if (!acc) {
      throw new Error(`${field}: referenced account not found`);
    }
    if (!acc.company_id || !allowed.has(String(acc.company_id))) {
      throw new Error(
        `${field}: account must belong to this company row or its parent tenant (company_id)`,
      );
    }
  }
}

/**
 * Company collection holds both **root tenants** and **child org rows** (e.g. branch / franchise site).
 *
 * - **Root tenant:** `company_id` is unset/null. Other models’ `company_id` points at this document’s `_id`.
 * - **Child under a parent:** `company_id` is set to the **parent company** `_id` (same collection, self-ref).
 *   Example: `getMyBranches` loads `{ _id: userTenant }` OR `{ company_id: userTenant }` so users see their
 *   tenant row plus subsidiaries that point at that tenant.
 *
 * Do not confuse with `user.company_id`, which is always “the tenant the user belongs to” (usually the root `_id`).
 */
const modelSchema = new mongoose.Schema(
  {
    company_name: {
      type: String,
      required: true,
    },
    company_phone: {
      type: String,
      // required: true,
    },
    company_email: {
      type: String,
      // required: true,
    },
    company_address: {
      type: String,
      // required: true,
    },
    company_logo: {
      type: String,
      field_name: "Logo Image",
      field_type: "image",
    },

    default_cash_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Cash Account",
    },
    default_sales_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Sales Account",
    },
    default_purchase_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Purchase Account",
    },
    default_sales_discount_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Sales Discount Account",
    },
    default_purchase_discount_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Purchase Discount Account",
    },
    default_account_receivable_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Account Receivable Account",
    },
    default_account_payable_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Account Payable Account",
    },
    default_shipping_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Shipping Account",
    },
    default_expense_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Expense Account",
    },
    default_salary_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Salary Account",
    },

    default_equity_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Equity Account",
    },
    default_other_expense_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Other Expense Account",
    },
    default_utilities_account: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      field_name: "Default Utilities Account",
    },

    warehouse_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "warehouse",
      field_name: "Default Store",
    },
    // default fields
    /** Parent company `_id` when this row is a branch/subsidiary; omit for root tenant companies. */
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Parent company",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true },
);

modelSchema.index(
  { company_id: 1, status: 1 },
  { sparse: true, name: "company_parent_status_1" },
);

modelSchema.pre("validate", async function () {
  await validateCompanyDefaultAccountRefs(this);
});

/**
 * findByIdAndUpdate does not run document pre("validate"); validate merged default_* refs when touched.
 */
modelSchema.pre(
  ["findOneAndUpdate", "findByIdAndUpdate"],
  async function (next) {
    try {
      const raw = this.getUpdate();
      if (!raw || Array.isArray(raw)) return next();

      const plain =
        raw.$set && typeof raw.$set === "object" ?
          { ...raw.$set }
        : Object.fromEntries(
            Object.entries(raw).filter(([k]) => !k.startsWith("$")),
          );

      const touched = COMPANY_DEFAULT_ACCOUNT_REF_FIELDS.some((f) =>
        Object.prototype.hasOwnProperty.call(plain, f),
      );
      if (!touched) return next();

      const filter = this.getFilter();
      if (!filter || !(filter._id ?? filter.id)) return next();

      const existing = await this.model.findOne(filter).lean();
      if (!existing) return next();

      const merged = { ...existing, ...plain };
      await validateCompanyDefaultAccountRefs(merged);
      next();
    } catch (err) {
      next(err);
    }
  },
);

const MODEL = mongoose.model("company", modelSchema);
MODEL.COMPANY_DEFAULT_ACCOUNT_REF_FIELDS = COMPANY_DEFAULT_ACCOUNT_REF_FIELDS;
MODEL.validateCompanyDefaultAccountRefs = validateCompanyDefaultAccountRefs;

module.exports = MODEL;

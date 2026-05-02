const mongoose = require("mongoose");

/**
 * Allowed `reference_id.module` values (Mongoose model names). Used with refPath on `ref_id`.
 * Keep in sync with controllers that post GL linkage (order, purchase_order).
 */
const TRANSACTION_REFERENCE_MODULES = ["order", "purchase_order"];

const referenceEmbedSchema = new mongoose.Schema(
  {
    module: {
      type: String,
      enum: {
        values: TRANSACTION_REFERENCE_MODULES,
        message: "{VALUE} is not a valid transaction reference module",
      },
    },
    ref_id: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "module",
    },
    field: { type: String },
    amount: { type: Number },
  },
  { _id: false },
);

const modelSchema = new mongoose.Schema(
  {
    /**
     * Journal / batch id shared by **multiple** posting rows (debit + credit lines).
     * Not unique per document — do not add unique({ company_id, transaction_number }).
     * Use compound index below for list-by-journal; for line-level idempotency use app keys or a future `line_id`.
     */
    transaction_number: {
      type: String,
      required: true,
    },
    // Populated via GET ?populate=account_id or together with ?populate=ref_id (account_id is auto-added when ref_id is used)
    account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "account",
      required: true,
      field_name: "Debit Account",
    },
    type: {
      type: String,
      required: true,
      enum: ["debit", "credit"],
      field_name: "Type",
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
      field_name: "Amount",
    },
    reference_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      // required: true,
    },
    reference_id: {
      type: referenceEmbedSchema,
      required: false,
    },
    description: {
      type: String,
      //   required: true,
    },

    // default fields
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      field_name: "Posted User",
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    branch_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "branch",
      field_name: "Branch",
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

modelSchema.index({ company_id: 1, createdAt: -1 });
modelSchema.index({ company_id: 1, account_id: 1 });
/** List/filter postings by journal batch id (many rows share one transaction_number). */
modelSchema.index(
  { company_id: 1, transaction_number: 1, createdAt: -1 },
  {
    name: "company_transaction_number_created_1",
    partialFilterExpression: { deletedAt: null },
  },
);

/**
 * Cross-tenant guards: GL account and branch must belong to transaction.company_id.
 * Polymorphic reference_id target is checked the same way.
 */
modelSchema.pre("validate", async function () {
  const companyId = this.company_id;
  if (!companyId) return;

  if (this.account_id) {
    const Account = mongoose.model("account");
    const acc = await Account.findById(this.account_id).select("company_id").lean();
    if (!acc) {
      throw new Error("account_id: referenced account not found");
    }
    if (String(acc.company_id) !== String(companyId)) {
      throw new Error(
        "account_id: account company_id does not match transaction company_id",
      );
    }
  }

  if (this.branch_id) {
    const Branch = mongoose.model("branch");
    const br = await Branch.findById(this.branch_id).select("company_id").lean();
    if (!br) {
      throw new Error("branch_id: referenced branch not found");
    }
    if (String(br.company_id) !== String(companyId)) {
      throw new Error(
        "branch_id: branch company_id does not match transaction company_id",
      );
    }
  }

  const ref = this.reference_id;
  if (!ref || ref.ref_id == null || ref.ref_id === "") return;
  if (!ref.module || !TRANSACTION_REFERENCE_MODULES.includes(ref.module)) {
    throw new Error(
      `reference_id.module must be one of: ${TRANSACTION_REFERENCE_MODULES.join(", ")} when ref_id is set`,
    );
  }

  let RefModel;
  try {
    RefModel = mongoose.model(ref.module);
  } catch {
    throw new Error(`reference_id.module: unknown model "${ref.module}"`);
  }

  const target = await RefModel.findById(ref.ref_id).select("company_id").lean();
  if (!target) {
    throw new Error("reference_id.ref_id: referenced document not found");
  }
  if (String(target.company_id) !== String(companyId)) {
    throw new Error(
      "reference_id.ref_id: referenced document company_id does not match transaction company_id",
    );
  }
});

const MODEL = mongoose.model("transaction", modelSchema);
MODEL.TRANSACTION_REFERENCE_MODULES = TRANSACTION_REFERENCE_MODULES;

module.exports = MODEL;

const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

/** Allowed role strings; keep in sync with routes/admin.js fieldOptions.role */
const USER_ROLE_VALUES = ["USER", "ADMIN", "VENDOR", "CUSTOMER"];

/** Only role `["ADMIN"]` may omit company_id (platform super-admin pattern). */
function companyIdRequiredForRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return true;
  return !(roles.length === 1 && roles[0] === "ADMIN");
}

/**
 * Whitelist: keep in sync with `routes/admin.js` → userAdminCRUD fieldOptions.permissions.modules[].key
 * Includes `order` (SPA) alongside `orders`; `proces` tolerates a common client typo for `process`.
 */
const PERMISSION_MODULE_KEYS = [
  "pos",
  "orders",
  "purchase-orders",
  "purchase-order-returns",
  "sales-returns",
  "products",
  "categories",
  "brands",
  "integration",
  "courier-integration",
  "big-commerce",
  "process",
  "warehouse",
  "warehouse-inventory",
  "stock",
  "adjustments",
  "company",
  "barcode-print",
  "attributes",
  "users",
  "amount-transfers",
  "branch",
  "accounts",
  "balance-sheet",
  "advance-balance-sheet",
  "profit-vs-gl-gap",
  "income-statement",
  "ledger",
  "payments",
  "payment-receipts",
  "expenses",
  "transactions",
  "logs",
  "support-tickets",
  "tasks",
  // Legacy / SPA aliases — keep so existing saved permissions are not stripped
  "order",
  "proces",
  "category",
];

/** Keys allowed on each permission row (matches permissionSetSchema). */
const PERMISSION_ACTION_KEYS = ["view", "edit", "delete", "add"];

/**
 * Dashboard chart keys stored on `show_graphs_on_dashboard`.
 * Keep in sync with `ai-pos/src/constants/dashboardGraphs.js` and
 * `routes/admin.js` → userAdminCRUD fieldOptions.show_graphs_on_dashboard.
 */
const DASHBOARD_GRAPH_OPTIONS = [
  { value: "todays_money", label: "Today's Money" },
  { value: "todays_users", label: "Today's Users" },
  { value: "total_customers", label: "Total Customers" },
  { value: "sales", label: "Sales" },
  { value: "sales_overview", label: "Sales Overview" },
  { value: "purchases_vs_sales", label: "Purchases vs Sales" },
  { value: "sales_by_month", label: "Sales by Month" },
  { value: "gross_profit_margin_trend", label: "Gross profit / margin trend" },
  { value: "cogs_vs_sales", label: "COGS vs sales" },
  { value: "inventory_value", label: "Inventory Value (by location)" },
  { value: "discount_total", label: "Discount (total)" },
  { value: "ledger_debit_credit", label: "Ledger Debit / Credit" },
  { value: "top_selling_products", label: "Top Selling Products" },
  { value: "peak_sales_hours", label: "Peak Sales Hours" },
  { value: "top_vendors", label: "Top Vendors" },
  { value: "daily_orders", label: "Daily Orders" },
  { value: "avg_order_value", label: "Average Order Value" },
  { value: "expense_summary", label: "Expense Summary" },
  { value: "accounts_receivable_summary", label: "Accounts Receivable" },
  { value: "receivables_by_customer", label: "Receivables by Customer" },
  { value: "receivables_aging", label: "Receivables Aging" },
  { value: "sales_by_category", label: "Sales by Category" },
  { value: "expenses_by_account", label: "Expenses by Account" },
  { value: "expense_vs_revenue", label: "Expense vs Revenue" },
  { value: "low_stock_alerts", label: "Low Stock Alerts" },
];

const DASHBOARD_GRAPH_KEYS = DASHBOARD_GRAPH_OPTIONS.map((item) => item.value);

function showGraphsInputToArray(input) {
  if (input == null || input === false) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through — comma-separated or single key
    }
    return trimmed.split(",").map((part) => part.trim());
  }
  return [];
}

/** Drop unknown graph keys so clients cannot inject extra dashboard widgets. */
function sanitizeShowGraphsOnDashboard(input) {
  const allowed = new Set(DASHBOARD_GRAPH_KEYS);
  const out = [];
  for (const item of showGraphsInputToArray(input)) {
    const key = String(item || "").trim();
    if (!allowed.has(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

function permissionsInputToPlain(input) {
  if (input == null) return {};
  if (input instanceof Map) return Object.fromEntries(input);
  if (typeof input === "object") return { ...input };
  return {};
}

/** Plain object from a permission row (plain JSON or Mongoose subdocument). */
function permissionRowToPlain(row) {
  if (row == null || typeof row !== "object") return {};
  if (typeof row.toObject === "function") return row.toObject();
  return { ...row };
}

/** Drop unknown module / action keys so clients cannot inject privilege buckets. */
function sanitizeUserPermissions(plain) {
  const src = plain && typeof plain === "object" ? plain : {};
  const out = {};
  for (const mod of PERMISSION_MODULE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, mod)) continue;
    const row = permissionRowToPlain(src[mod]);
    if (!row || typeof row !== "object") continue;
    const clean = {};
    for (const act of PERMISSION_ACTION_KEYS) {
      // Subdocuments use schema paths on the prototype — `hasOwnProperty` is always false.
      if (!(act in row)) continue;
      clean[act] = Boolean(row[act]);
    }
    out[mod] = clean;
  }
  return out;
}

const permissionSetSchema = new mongoose.Schema(
  {
    view: {
      type: Boolean,
      default: false,
    },
    edit: {
      type: Boolean,
      default: false,
    },
    delete: {
      type: Boolean,
      default: false,
    },
    add: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    // default fields
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      field_name: "Phone",
      default: "92",
      maxlength: [13, "Phone must be at most 13 digits"],
      set(value) {
        if (value == null || value === "") return "92";
        const digits = String(value).trim().replace(/\D/g, "").slice(0, 13);
        return digits || "92";
      },
    },
    password: {
      type: String,
      required: true,
    },
    profile_image: {
      type: String,
      field_type: "image",
    },
    initial_balance: {
      type: Number,
      default: 0,
    },
    mark_as_default_vendor: {
      type: Boolean,
      default: false,
      field_name: "Make default vendor",
    },
    role: {
      type: [String],
      required: true,
      default: () => ["USER"],
      validate: {
        validator(value) {
          if (!Array.isArray(value) || value.length === 0) return false;
          return value.every((r) => USER_ROLE_VALUES.includes(r));
        },
        message:
          "role must be a non-empty array of USER, ADMIN, VENDOR, or CUSTOMER.",
      },
      field_type: "multiselect",
    },
    transaction_number: {
      type: String,
      field_name: "Transaction Number",
    },
    // assign_company_id: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "company",
    //   field_name: "Assign Branch",
    // },
    show_graphs_on_dashboard: {
      type: [String],
      default: () => [],
      field_type: "multiselect",
      field_name: "Show Graphs on Dashboard",
    },
    permissions: {
      type: Map,
      of: permissionSetSchema,
      default: {},
      field_name: "Permissions",
    },
    city: {
      type: String,
      field_name: "City",
    },
    state: {
      type: String,
      field_name: "State",
    },
    area: {
      type: String,
      field_name: "Area",
    },
    country: {
      type: String,
      field_name: "Country",
    },
    zip_code: {
      type: String,
      field_name: "Zip Code",
    },
    /**
     * Tenant scope. Required in pre("validate") unless role is exclusively ADMIN.
     * See unique index (company_id, email) for active tenant users.
     */
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      field_name: "Company",
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
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

userSchema.pre("validate", function (next) {
  if (typeof this.email === "string") {
    this.email = this.email.trim().toLowerCase();
  }
  if (companyIdRequiredForRoles(this.role) && !this.company_id) {
    this.invalidate(
      "company_id",
      "company_id is required for this role set (only a single ADMIN role may omit it)",
    );
  }

  const permPlain = permissionsInputToPlain(this.permissions);
  const sanitized = sanitizeUserPermissions(permPlain);
  this.permissions = new Map(Object.entries(sanitized));
  this.show_graphs_on_dashboard = sanitizeShowGraphsOnDashboard(
    this.show_graphs_on_dashboard,
  );

  next();
});

userSchema.pre(["findOneAndUpdate", "findByIdAndUpdate"], function (next) {
  const raw = this.getUpdate();
  if (!raw || Array.isArray(raw)) return next();

  const patchPermissions = (obj) => {
    if (!obj || typeof obj !== "object" || obj.permissions === undefined)
      return;
    const plain = permissionsInputToPlain(obj.permissions);
    obj.permissions = sanitizeUserPermissions(plain);
  };

  const patchShowGraphs = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const next =
      obj.show_graphs_on_dashboard !== undefined
        ? obj.show_graphs_on_dashboard
        : obj.show_graphs !== undefined
          ? obj.show_graphs
          : obj.show_grahs_on_dashboard;
    if (next === undefined) return;
    obj.show_graphs_on_dashboard = sanitizeShowGraphsOnDashboard(next);
    if (obj.show_grahs_on_dashboard !== undefined) {
      delete obj.show_grahs_on_dashboard;
    }
    if (obj.show_graphs !== undefined) {
      delete obj.show_graphs;
    }
  };

  if (raw.$set && typeof raw.$set === "object") {
    patchPermissions(raw.$set);
    patchShowGraphs(raw.$set);
  }
  const topKeys = Object.keys(raw).filter((k) => !k.startsWith("$"));
  if (topKeys.includes("permissions")) {
    patchPermissions(raw);
  }
  if (
    topKeys.includes("show_graphs_on_dashboard") ||
    topKeys.includes("show_graphs") ||
    topKeys.includes("show_grahs_on_dashboard")
  ) {
    patchShowGraphs(raw);
  }
  next();
});

userSchema.index(
  { company_id: 1, email: 1 },
  {
    unique: true,
    name: "user_company_email_1",
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true, $ne: null },
      email: { $exists: true, $nin: [null, ""] },
    },
  },
);

// Add methods to the schema
userSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Hash password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

const USER = mongoose.model("user", userSchema);
USER.USER_ROLE_VALUES = USER_ROLE_VALUES;
USER.companyIdRequiredForRoles = companyIdRequiredForRoles;
USER.PERMISSION_MODULE_KEYS = PERMISSION_MODULE_KEYS;
USER.PERMISSION_ACTION_KEYS = PERMISSION_ACTION_KEYS;
USER.sanitizeUserPermissions = sanitizeUserPermissions;
USER.DASHBOARD_GRAPH_KEYS = DASHBOARD_GRAPH_KEYS;
USER.DASHBOARD_GRAPH_OPTIONS = DASHBOARD_GRAPH_OPTIONS;
USER.sanitizeShowGraphsOnDashboard = sanitizeShowGraphsOnDashboard;

module.exports = USER;

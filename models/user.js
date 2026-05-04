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
  "integration",
  "orders",
  "order",
  "analytics",
  "inventory",
  "category",
  "process",
  "proces",
];

/** Keys allowed on each permission row (matches permissionSetSchema). */
const PERMISSION_ACTION_KEYS = ["view", "edit", "delete", "add"];

function permissionsInputToPlain(input) {
  if (input == null) return {};
  if (input instanceof Map) return Object.fromEntries(input);
  if (typeof input === "object") return { ...input };
  return {};
}

/** Drop unknown module / action keys so clients cannot inject privilege buckets. */
function sanitizeUserPermissions(plain) {
  const src = plain && typeof plain === "object" ? plain : {};
  const out = {};
  for (const mod of PERMISSION_MODULE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(src, mod)) continue;
    const row = src[mod];
    if (!row || typeof row !== "object") continue;
    const clean = {};
    for (const act of PERMISSION_ACTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(row, act)) {
        clean[act] = Boolean(row[act]);
      }
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
    // assign_company_id: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "company",
    //   field_name: "Assign Branch",
    // },
    permissions: {
      type: Map,
      of: permissionSetSchema,
      default: {},
      field_name: "Permissions",
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
  { timestamps: true },
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

  if (raw.$set && typeof raw.$set === "object") {
    patchPermissions(raw.$set);
  }
  const topKeys = Object.keys(raw).filter((k) => !k.startsWith("$"));
  if (topKeys.includes("permissions")) {
    patchPermissions(raw);
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

module.exports = USER;

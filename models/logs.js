const mongoose = require("mongoose");

/** Hard caps — keep documents bounded for replication and admin list views. */
const MAX_ACTION_LEN = 500;
const MAX_URL_LEN = 2000;
const MAX_DESCRIPTION_LEN = 8000;
const MAX_TAGS = 30;
const MAX_TAG_LEN = 64;

/** Case-normalized key names (alphanumeric only) we never persist verbatim. */
const SENSITIVE_KEY_NORMALIZED = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "clientsecret",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "creditcard",
  "cardnumber",
  "cvv",
  "ssn",
]);

function normalizeKeyName(k) {
  return String(k || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function truncate(str, max) {
  if (str == null) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max - 20)}…[truncated]`;
}

/**
 * Redact common secret-bearing JSON keys and obvious query-string secrets.
 * Safe for free-text error messages; does not guarantee zero leakage from crafted payloads.
 */
function sanitizeLogDescription(raw) {
  let s = truncate(raw == null ? "" : String(raw), MAX_DESCRIPTION_LEN);

  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const redacted = { ...o };
      for (const k of Object.keys(redacted)) {
        if (SENSITIVE_KEY_NORMALIZED.has(normalizeKeyName(k))) {
          redacted[k] = "[REDACTED]";
        }
      }
      return truncate(JSON.stringify(redacted), MAX_DESCRIPTION_LEN);
    }
  } catch (_) {
    /* not JSON */
  }

  s = s.replace(
    /("(?:password|passwd|secret|token|authorization|apikey|api_key|client_secret|access_token|refresh_token)"\s*:\s*")([^"]*)(")/gi,
    '$1[REDACTED]$3',
  );
  s = s.replace(
    /(?:^|[?&])(password|secret|token|api_key|client_secret|access_token|refresh_token)=([^&\s#]+)/gi,
    "$1=[REDACTED]",
  );
  return truncate(s, MAX_DESCRIPTION_LEN);
}

function clampTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : [tags];
  return arr
    .slice(0, MAX_TAGS)
    .map((t) => truncate(String(t), MAX_TAG_LEN))
    .filter((t) => t.length > 0);
}

/**
 * Use for insertMany / raw payloads (document `pre("validate")` does not run on insertMany).
 */
function sanitizeLogPlainObject(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const out = { ...doc };
  if (out.action != null) out.action = truncate(out.action, MAX_ACTION_LEN);
  if (out.url != null) out.url = truncate(out.url, MAX_URL_LEN);
  if (out.description != null) {
    out.description = sanitizeLogDescription(out.description);
  }
  if (out.tags !== undefined) {
    out.tags = clampTags(out.tags);
  }
  return out;
}

const modelSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      maxlength: MAX_ACTION_LEN,
    },
    url: {
      type: String,
      required: true,
      maxlength: MAX_URL_LEN,
    },
    tags: {
      type: [String],
      validate: {
        validator(v) {
          return !v || (Array.isArray(v) && v.length <= MAX_TAGS);
        },
        message: `At most ${MAX_TAGS} tags`,
      },
    },
    description: {
      type: String,
      maxlength: MAX_DESCRIPTION_LEN,
    },

    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
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

modelSchema.pre("validate", function (next) {
  try {
    if (this.action != null) {
      this.action = truncate(this.action, MAX_ACTION_LEN);
    }
    if (this.url != null) {
      this.url = truncate(this.url, MAX_URL_LEN);
    }
    if (this.description != null) {
      this.description = sanitizeLogDescription(this.description);
    }
    if (this.tags != null) {
      this.tags = clampTags(this.tags);
    }
    next();
  } catch (e) {
    next(e);
  }
});

function patchUpdateDescriptionTags(u) {
  const target = u.$set && typeof u.$set === "object" ? u.$set : u;
  if (target.description != null) {
    target.description = sanitizeLogDescription(target.description);
  }
  if (target.action != null) {
    target.action = truncate(target.action, MAX_ACTION_LEN);
  }
  if (target.url != null) target.url = truncate(target.url, MAX_URL_LEN);
  if (target.tags != null) target.tags = clampTags(target.tags);
}

modelSchema.pre(["findOneAndUpdate", "findByIdAndUpdate"], function (next) {
  try {
    const u = this.getUpdate();
    if (!u || Array.isArray(u)) return next();
    patchUpdateDescriptionTags(u);
    next();
  } catch (e) {
    next(e);
  }
});

/** Auto-purge operational rows (tune or drop index if you need indefinite retention). */
modelSchema.index(
  { createdAt: 1 },
  {
    name: "logs_createdAt_ttl_180d",
    expireAfterSeconds: 15552000,
  },
);

modelSchema.index({ company_id: 1, createdAt: -1 });

const MODEL = mongoose.model("logs", modelSchema);

MODEL.sanitizeLogPlainObject = sanitizeLogPlainObject;
MODEL.MAX_DESCRIPTION_LEN = MAX_DESCRIPTION_LEN;

module.exports = MODEL;

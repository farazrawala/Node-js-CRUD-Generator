const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ─── Schema / enum tests ─────────────────────────────────────────────

describe("SupportTicket model", () => {
  const SupportTicket = require("../models/support_ticket");
  const {
    CATEGORY_VALUES,
    PRIORITY_VALUES,
    STATUS_VALUES,
  } = require("../models/support_ticket");

  it("exports category enum values", () => {
    assert.ok(Array.isArray(CATEGORY_VALUES));
    assert.ok(CATEGORY_VALUES.includes("General"));
    assert.ok(CATEGORY_VALUES.includes("Billing"));
    assert.ok(CATEGORY_VALUES.includes("Technical"));
    assert.ok(CATEGORY_VALUES.includes("Bug Report"));
    assert.ok(CATEGORY_VALUES.includes("Other"));
  });

  it("exports priority enum values", () => {
    assert.deepStrictEqual(PRIORITY_VALUES, [
      "low",
      "medium",
      "high",
      "urgent",
    ]);
  });

  it("exports status enum values", () => {
    assert.ok(STATUS_VALUES.includes("open"));
    assert.ok(STATUS_VALUES.includes("pending"));
    assert.ok(STATUS_VALUES.includes("waiting_for_user"));
    assert.ok(STATUS_VALUES.includes("waiting_for_admin"));
    assert.ok(STATUS_VALUES.includes("resolved"));
    assert.ok(STATUS_VALUES.includes("closed"));
  });

  it("has required schema paths", () => {
    const paths = SupportTicket.schema.paths;
    const required = [
      "ticket_number",
      "subject",
      "category",
      "priority",
      "status",
      "company_id",
    ];
    for (const p of required) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });

  it("has expected indexes", () => {
    const indexes = SupportTicket.schema.indexes();
    assert.ok(indexes.length >= 4, `expected >= 4 indexes, got ${indexes.length}`);
  });
});

describe("SupportMessage model", () => {
  const SupportMessage = require("../models/support_message");

  it("has required schema paths", () => {
    const paths = SupportMessage.schema.paths;
    for (const p of ["ticket_id", "user", "role", "message", "is_internal"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });

  it("role enum is user/admin", () => {
    const roleEnum = SupportMessage.schema.path("role").enumValues;
    assert.deepStrictEqual(roleEnum, ["user", "admin"]);
  });
});

describe("SupportAttachment model", () => {
  const SupportAttachment = require("../models/support_attachment");

  it("has required schema paths", () => {
    const paths = SupportAttachment.schema.paths;
    for (const p of ["name", "filename", "path", "uploaded_by", "company_id"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });
});

describe("SupportTicketRead model", () => {
  const SupportTicketRead = require("../models/support_ticket_read");

  it("has required schema paths", () => {
    const paths = SupportTicketRead.schema.paths;
    for (const p of ["ticket_id", "user_id", "last_read_at"]) {
      assert.ok(paths[p], `missing schema path: ${p}`);
    }
  });

  it("has unique compound index on ticket_id + user_id", () => {
    const indexes = SupportTicketRead.schema.indexes();
    const compound = indexes.find(
      (idx) => idx[0].ticket_id === 1 && idx[0].user_id === 1,
    );
    assert.ok(compound, "compound index missing");
    assert.strictEqual(compound[1].unique, true);
  });
});

describe("SupportTicketCounter model", () => {
  const SupportTicketCounter = require("../models/support_ticket_counter");

  it("has company_id and seq fields", () => {
    const paths = SupportTicketCounter.schema.paths;
    assert.ok(paths.company_id);
    assert.ok(paths.seq);
  });
});

// ─── Upload utility tests ────────────────────────────────────────────

describe("supportTicketUploads", () => {
  const {
    validateFile,
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE,
  } = require("../utils/supportTicketUploads");

  it("rejects oversized files", () => {
    const err = validateFile({ name: "big.png", size: MAX_FILE_SIZE + 1, mimetype: "image/png" });
    assert.ok(err);
    assert.ok(err.includes("10MB"));
  });

  it("rejects disallowed extensions", () => {
    const err = validateFile({ name: "virus.exe", size: 100, mimetype: "application/x-msdownload" });
    assert.ok(err);
    assert.ok(err.includes("not allowed"));
  });

  it("accepts valid image file", () => {
    const err = validateFile({ name: "photo.jpg", size: 5000, mimetype: "image/jpeg" });
    assert.strictEqual(err, null);
  });

  it("accepts valid PDF file", () => {
    const err = validateFile({ name: "doc.pdf", size: 5000, mimetype: "application/pdf" });
    assert.strictEqual(err, null);
  });

  it("accepts valid zip file", () => {
    const err = validateFile({ name: "archive.zip", size: 5000, mimetype: "application/zip" });
    assert.strictEqual(err, null);
  });

  it("accepts valid docx file", () => {
    const err = validateFile({
      name: "document.docx",
      size: 5000,
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    assert.strictEqual(err, null);
  });

  it("exports expected allowed extensions", () => {
    for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".zip", ".docx"]) {
      assert.ok(ALLOWED_EXTENSIONS.has(ext), `missing extension: ${ext}`);
    }
  });
});

// ─── Controller export tests ─────────────────────────────────────────

describe("support_ticket controller exports", () => {
  const ctrl = require("../controllers/support_ticket");

  it("exports all nine handler functions", () => {
    const expected = [
      "getAll",
      "getById",
      "create",
      "reply",
      "changeStatus",
      "changePriority",
      "assign",
      "uploadAttachment",
      "deleteAttachment",
    ];
    for (const fn of expected) {
      assert.strictEqual(typeof ctrl[fn], "function", `missing export: ${fn}`);
    }
  });
});

// ─── Route registration tests ────────────────────────────────────────

describe("support-ticket routes in api.js", () => {
  const fs = require("fs");
  const path = require("path");
  const routeFile = fs.readFileSync(
    path.join(__dirname, "..", "routes", "api.js"),
    "utf8",
  );

  const expectedPaths = [
    "/support-ticket/get-all",
    "/support-ticket/get/:id",
    "/support-ticket/create",
    "/support-ticket/reply/:id",
    "/support-ticket/change-status/:id",
    "/support-ticket/change-priority/:id",
    "/support-ticket/assign/:id",
    "/support-ticket/upload-attachment",
    "/support-ticket/delete-attachment/:id",
  ];

  for (const p of expectedPaths) {
    it(`registers route ${p}`, () => {
      assert.ok(
        routeFile.includes(`"${p}"`),
        `route ${p} not found in api.js`,
      );
    });
  }

  it("excludes support models from dynamic CRUD", () => {
    for (const m of [
      "support_ticket",
      "support_message",
      "support_attachment",
      "support_ticket_read",
      "support_ticket_counter",
    ]) {
      assert.ok(
        routeFile.includes(`"${m}"`),
        `${m} should be in excludedModels`,
      );
    }
  });
});

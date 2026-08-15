const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { getPublicAssetBaseUrl } = require("./basePath");

const ALLOWED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".pdf",
  ".zip",
  ".docx",
  ".xlsx",
  ".txt",
]);

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

function resolveTaskUploadDir(companyId, taskId) {
  return path.join(UPLOADS_ROOT, "tasks", String(companyId), String(taskId));
}

function sanitizeFilename(raw) {
  return String(raw || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 200);
}

function generateSafeFilename(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  const rand = crypto.randomBytes(16).toString("hex");
  return `${Date.now()}_${rand}${ext}`;
}

function validateFile(file) {
  if (!file) return "No file provided";
  if (file.size > MAX_FILE_SIZE) {
    return `File exceeds 10MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
  }
  const ext = path.extname(file.name || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `File type not allowed: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`;
  }
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime && !ALLOWED_MIME_TYPES.has(mime)) {
    return `MIME type not allowed: ${mime}`;
  }
  return null;
}

async function saveTaskFiles(files, opts) {
  const { companyId, taskId, uploadedBy, req } = opts;
  const fileArr = Array.isArray(files) ? files : [files];
  const dir = resolveTaskUploadDir(companyId, taskId);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const results = [];
  for (const file of fileArr) {
    const err = validateFile(file);
    if (err) throw new Error(err);

    const originalName = sanitizeFilename(file.name);
    const filename = generateSafeFilename(file.name);
    const absPath = path.join(dir, filename);
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(path.resolve(UPLOADS_ROOT))) {
      throw new Error("Invalid upload path");
    }

    await file.mv(absPath);

    const relativePath = path
      .relative(path.join(__dirname, ".."), absPath)
      .split(path.sep)
      .join("/");

    const baseUrl = getPublicAssetBaseUrl(req || null);
    results.push({
      name: originalName,
      filename,
      url: `${baseUrl}/${relativePath}`,
      path: relativePath,
      mime_type: file.mimetype || "",
      size: file.size || 0,
      uploaded_by: uploadedBy,
      uploaded_at: new Date(),
    });
  }
  return results;
}

function safeUnlinkAttachment(relativePath) {
  if (!relativePath) return false;
  const absPath = path.resolve(path.join(__dirname, "..", relativePath));
  if (!absPath.startsWith(path.resolve(UPLOADS_ROOT))) return false;
  try {
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      return true;
    }
  } catch (e) {
    console.error("❌ taskUploads unlink error:", e.message);
  }
  return false;
}

module.exports = {
  saveTaskFiles,
  safeUnlinkAttachment,
  validateFile,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
};

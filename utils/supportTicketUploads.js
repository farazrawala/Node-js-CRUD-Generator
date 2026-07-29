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
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const UPLOADS_ROOT = path.join(__dirname, "..", "uploads");

function resolveTicketUploadDir(companyId, ticketId) {
  return path.join(
    UPLOADS_ROOT,
    "support-tickets",
    String(companyId),
    String(ticketId),
  );
}

function sanitizeFilename(raw) {
  return String(raw || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 200);
}

function generateSafeFilename(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  const rand = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  return `${ts}_${rand}${ext}`;
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

/**
 * Save uploaded files for a support ticket.
 * @param {object|object[]} files - express-fileupload file(s)
 * @param {{ companyId: string, ticketId: string, uploadedBy: string, req?: object }} opts
 * @returns {Promise<object[]>} saved file metadata array
 */
async function saveTicketFiles(files, opts) {
  const { companyId, ticketId, uploadedBy, req } = opts;
  const fileArr = Array.isArray(files) ? files : [files];
  const dir = resolveTicketUploadDir(companyId, ticketId);

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
    const url = `${baseUrl}/${relativePath}`;

    results.push({
      name: originalName,
      filename,
      url,
      path: relativePath,
      mime_type: file.mimetype || "",
      size: file.size || 0,
      uploaded_by: uploadedBy,
    });
  }
  return results;
}

/**
 * Safely delete a file from disk within the uploads root.
 * @param {string} relativePath
 * @returns {boolean}
 */
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
    console.error("❌ supportTicketUploads unlink error:", e.message);
  }
  return false;
}

module.exports = {
  saveTicketFiles,
  safeUnlinkAttachment,
  validateFile,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE,
};

const express = require("express");
const fs = require("fs");
const router = express.Router();
const { restrictTo } = require("../middlewares/auth");
const fileLogger = require("../utils/fileLogger");

router.use(restrictTo(["ADMIN"]));

/** List log files available for download */
router.get("/logs", (req, res) => {
  try {
    const files = fileLogger.listLogFiles();
    return res.json({
      success: true,
      logDir: "logs/",
      files,
      downloadHint:
        "GET /admin/debug/logs/download?file=app-YYYY-MM-DD.log (admin cookie or Bearer token)",
    });
  } catch (err) {
    fileLogger.error("debug logs list failed", { message: err.message });
    return res.status(500).json({
      success: false,
      message: "Failed to list log files",
    });
  }
});

/** Download a single log file */
router.get("/logs/download", (req, res) => {
  try {
    const filePath = fileLogger.resolveSafeLogFile(req.query.file);
    if (!filePath) {
      return res.status(400).json({
        success: false,
        message: "Invalid or missing file parameter",
      });
    }

    const filename = req.query.file;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    return fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    fileLogger.error("debug logs download failed", {
      file: req.query.file,
      message: err.message,
    });
    return res.status(500).json({
      success: false,
      message: "Failed to download log file",
    });
  }
});

module.exports = router;

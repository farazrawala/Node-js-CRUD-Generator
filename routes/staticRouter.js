const express = require("express");
const router = express.Router();
const URL = require("../models/url");
const { restrictTo } = require("../middlewares/auth");
const { withBasePath, getBasePath } = require("../utils/basePath");

/** Public — verify Node is running (not Apache static index.js). */
router.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "pos-api",
    basePath: getBasePath() || null,
    nodeEnv: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
  });
});

router.get("/", async (req, res) => {
  const allUrls = URL.find({});
  return res.render("home", {
    urls: allUrls,
  });
});

router.get("/admin/url", restrictTo(["ADMIN"]), async (req, res) => {
  const allUrls = URL.find({});
  return res.render("home", {
    urls: allUrls,
  });
});

router.get("/signup", (req, res) => {
  return res.render("signup");
});

router.get("/login", (req, res) => {
  return res.render("login");
});

router.get("/login/admin", (req, res) => {
  return res.render("admin-login");
});

router.get("/admin/dashboard", restrictTo(["ADMIN"]), (req, res) => {
  return res.render("admin-dashboard", {
    user: req.user
  });
});

router.get("/admin/logout", (req, res) => {
  res.clearCookie("token");
  res.redirect(withBasePath("/login/admin"));
});

router.get("/thankyou", (req, res) => {
  return res.render("thankyou");
});

module.exports = router;

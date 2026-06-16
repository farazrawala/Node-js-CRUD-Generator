const express = require("express");
const router = express.Router();
const URL = require("../models/url");
const { restrictTo } = require("../middlewares/auth");
const { withBasePath, getBasePath } = require("../utils/basePath");
const { getHealthPayload } = require("../utils/buildInfo");

/** Public — verify Node is running + which deploy/build is loaded. */
router.get("/health", (req, res) => {
  res.status(200).json(getHealthPayload(getBasePath() || null));
});

/** Alias for Postman clients that prefer /version. */
router.get("/version", (req, res) => {
  const payload = getHealthPayload(getBasePath() || null);
  res.status(200).json({
    success: true,
    ...payload,
    data: payload.version,
  });
});

router.get("/", (req, res) => {
  return res.redirect(withBasePath("/login/admin"));
});

router.get("/home", async (req, res) => {
  const allUrls = await URL.find({});
  return res.render("home", {
    allUrls,
  });
});

router.get("/admin/url", restrictTo(["ADMIN"]), async (req, res) => {
  const allUrls = await URL.find({});
  return res.render("home", {
    allUrls,
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

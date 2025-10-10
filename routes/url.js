const express = require("express");
const router = express();
const {
  handleGetallUrls,
  handleCreateurl,
  handFetchUrl,
} = require("../controllers/url");

// const { restrictTo } = require("../middlewares/auth");

router.get("/all", handleGetallUrls);
router.get("/fetch/:id", handFetchUrl);

router.post("/create", handleCreateurl);

module.exports = router;

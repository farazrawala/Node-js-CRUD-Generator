const express = require("express");
const router = express.Router();

const {
  handleUserSignup,
  handleUserLogin,
  handleUserUpdate,
} = require("../controllers/user");

console.log("🔧 Registering user routes...");
router.post("/signup", handleUserSignup);
router.post("/login", handleUserLogin);
router.put("/update/:id", handleUserUpdate); // Changed to PUT with ID parameter
console.log("✅ User routes registered successfully");

module.exports = router;

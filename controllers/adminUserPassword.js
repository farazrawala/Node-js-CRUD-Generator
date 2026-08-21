const User = require("../models/user");
const mongoose = require("mongoose");

/**
 * POST /admin/users/:id/reset-password
 * Body: { password, confirmPassword }
 */
async function resetUserPassword(req, res) {
  try {
    const userId = String(req.params.id || "").trim();
    if (
      !mongoose.Types.ObjectId.isValid(userId) ||
      String(userId).length !== 24
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid user id",
      });
    }

    const password = String(req.body?.password || "").trim();
    const confirmPassword = String(
      req.body?.confirmPassword || req.body?.confirm_password || "",
    ).trim();

    if (!password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters",
      });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match",
      });
    }

    const user = await User.findOne({ _id: userId, deletedAt: null });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Plain password — user model pre-save hook hashes it once
    user.password = password;
    await user.save();

    return res.json({
      success: true,
      message: `Password reset for ${user.name || user.email || "user"}`,
    });
  } catch (error) {
    console.error("Admin reset password error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to reset password",
    });
  }
}

module.exports = {
  resetUserPassword,
};

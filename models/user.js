const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      // required: true,
      field_name: "Company",
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
      encrypt: true,
    },
    profile_image: {
      type: String,
      field_type: "image",
    },
    role: {
      type: [String],
      required: true,
      default: ["USER"], //  ADMIN, SUPERADMIN, VENDOR, USER ,CUSTOMER
      field_type: "multiselect",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true }
);

// Add methods to the schema
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

const USER = mongoose.model("user", userSchema);

module.exports = USER;

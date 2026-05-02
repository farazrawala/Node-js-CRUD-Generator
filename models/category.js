const mongoose = require("mongoose");

/**
 * `isActive` is catalog visibility (boolean). Other models often use string `status` (active/inactive)
 * for record lifecycle / soft delete — different meaning; keep both patterns unless you run a migration.
 */
const categorySchema = new mongoose.Schema(
  {
    parent_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "category",
      default: null,
      set: function (value) {
        // Convert empty strings, 'null', undefined to null
        if (
          value === "" ||
          value === "null" ||
          value === undefined ||
          value === null
        ) {
          return null;
        }
        return value;
      },
    },
    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      minlength: [2, "Category name must be at least 2 characters long"],
      maxlength: [100, "Category name cannot exceed 100 characters"],
    },
    slug: {
      type: String,
      field_name: "Slug",
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    /** Show/hide in storefront or pickers; not the same as collection-level `status` on order, product, etc. */
    isActive: {
      type: Boolean,
      default: true,
    },
    icon: {
      type: String,
      default: "",
    },
    image: {
      type: String,
      field_name: "Category Image",
      field_type: "image",
    },
    color: {
      type: String,
      default: "#667eea",
    },
    sort_order: {
      type: Number,
      default: 0,
    },
    // default fields
    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Created By",
    },
    updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      field_name: "Updated By",
    },
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive"],
      default: "active",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for formatted creation date
categorySchema.virtual("formattedCreatedAt").get(function () {
  return this.createdAt ? this.createdAt.toLocaleDateString() : "";
});

// Virtual for formatted update date
categorySchema.virtual("formattedUpdatedAt").get(function () {
  return this.updatedAt ? this.updatedAt.toLocaleDateString() : "";
});

// Tenant-scoped indexes (avoid full scans / cross-company name collisions)
categorySchema.index({ company_id: 1, name: 1 });
categorySchema.index({ company_id: 1, sort_order: 1 });
categorySchema.index({ company_id: 1, isActive: 1 });

// Pre-save middleware
categorySchema.pre("save", function (next) {
  // Ensure name is properly formatted
  if (this.name) {
    this.name = this.name.trim();
  }

  // Ensure description is properly formatted
  if (this.description) {
    this.description = this.description.trim();
  }

  // Handle empty parent_id - convert empty string to null
  if (
    this.parent_id === "" ||
    this.parent_id === "null" ||
    this.parent_id === undefined
  ) {
    this.parent_id = null;
  }

  next();
});

// Static method to get active categories
categorySchema.statics.getActiveCategories = function () {
  return this.find({ isActive: true }).sort({ sort_order: 1, name: 1 });
};

// Static method to get categories by name pattern
categorySchema.statics.searchByName = function (searchTerm) {
  return this.find({
    name: { $regex: searchTerm, $options: "i" },
    isActive: true,
  }).sort({ name: 1 });
};

// Instance method to toggle active status
categorySchema.methods.toggleActive = function () {
  this.isActive = !this.isActive;
  return this.save();
};

// Instance method to update sort order
categorySchema.methods.updateSortOrder = function (newOrder) {
  this.sort_order = newOrder;
  return this.save();
};

const Category = mongoose.model("category", categorySchema);

module.exports = Category;

const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      unique: true,
      minlength: [2, 'Category name must be at least 2 characters long'],
      maxlength: [50, 'Category name cannot exceed 50 characters']
    },
    description: {
      type: String,
      trim: true,
      maxlength: [200, 'Description cannot exceed 200 characters']
    },
    isActive: {
      type: Boolean,
      default: true
    },
    icon: {
      type: String,
      default: '📁'
    },
    color: {
      type: String,
      default: '#667eea'
    },
    sort_order: {
      type: Number,
      default: 0
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual for formatted creation date
categorySchema.virtual('formattedCreatedAt').get(function() {
  return this.createdAt ? this.createdAt.toLocaleDateString() : '';
});

// Virtual for formatted update date
categorySchema.virtual('formattedUpdatedAt').get(function() {
  return this.updatedAt ? this.updatedAt.toLocaleDateString() : '';
});

// Index for better query performance
categorySchema.index({ name: 1 });
categorySchema.index({ isActive: 1 });
categorySchema.index({ sort_order: 1 });

// Pre-save middleware
categorySchema.pre('save', function(next) {
  // Ensure name is properly formatted
  if (this.name) {
    this.name = this.name.trim();
  }
  
  // Ensure description is properly formatted
  if (this.description) {
    this.description = this.description.trim();
  }
  
  next();
});

// Static method to get active categories
categorySchema.statics.getActiveCategories = function() {
  return this.find({ isActive: true }).sort({ sort_order: 1, name: 1 });
};

// Static method to get categories by name pattern
categorySchema.statics.searchByName = function(searchTerm) {
  return this.find({
    name: { $regex: searchTerm, $options: 'i' },
    isActive: true
  }).sort({ name: 1 });
};

// Instance method to toggle active status
categorySchema.methods.toggleActive = function() {
  this.isActive = !this.isActive;
  return this.save();
};

// Instance method to update sort order
categorySchema.methods.updateSortOrder = function(newOrder) {
  this.sort_order = newOrder;
  return this.save();
};

const Category = mongoose.model('category', categorySchema);

module.exports = Category;

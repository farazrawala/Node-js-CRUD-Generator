const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const modelSchema = new mongoose.Schema(
  {
    product_name: {
      type: String,
      required: true,
      field_name: "Product Name",
    },
    product_slug: {
      type: String,
      field_name: "Product Slug",
      default: null,
      set: function(value) {
        // If value provided, slugify it to ensure it's URL-friendly
        if (value && value !== '' && value !== 'null' && value !== null && value !== undefined) {
          return generateSlug(value);
        }
        // Return null for empty values - will be handled in pre-save hook
        return null;
      }
    },
    product_price: {
      type: String,
    required: true,
      field_name: "Product Price",
    },
    product_description: {
      type: String,
      field_name: "Product Description",
    },
    product_image: {
      type: String,
      field_type: "image",
      field_name: "Featured Image",
    },
    multi_images: {
      type: [String],
      field_type: "image",
      field_name: "Multiple Images",
    },
    deletedAt: {
      type: Date,
      default: null,
      field_name: "Deleted At",
    },
  },
  { timestamps: true }
);

// Pre-validate hook to handle slug generation before validation (runs first)
modelSchema.pre('validate', function(next) {
  console.log('🔧 Pre-validate hook - product_name:', this.product_name);
  console.log('🔧 Pre-validate hook - product_slug before:', this.product_slug);
  
  // If slug is empty, null, or undefined, generate it from product_name
  if ((!this.product_slug || this.product_slug === '' || this.product_slug === null) && this.product_name) {
    const newSlug = generateSlug(this.product_name);
    console.log('✅ Generated new slug in validate:', newSlug);
    this.product_slug = newSlug;
  }
  next();
});

// Pre-save hook to ensure slug is always generated from product_name if empty (backup)
modelSchema.pre('save', function(next) {
  console.log('🔧 Pre-save hook - product_name:', this.product_name);
  console.log('🔧 Pre-save hook - product_slug before:', this.product_slug);
  
  // If slug is still empty, null, or undefined, generate it from product_name
  if ((!this.product_slug || this.product_slug === '' || this.product_slug === null) && this.product_name) {
    const newSlug = generateSlug(this.product_name);
    console.log('✅ Generated new slug in save:', newSlug);
    this.product_slug = newSlug;
  }
  
  console.log('🔧 Pre-save hook - product_slug after:', this.product_slug);
  next();
});

const MODEL = mongoose.model("product", modelSchema);

module.exports = MODEL;

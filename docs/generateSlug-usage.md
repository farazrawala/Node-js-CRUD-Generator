# generateSlug Function - Usage Guide

## Overview

The `generateSlug` function is a utility function available in `modelHelper.js` that converts any text into a URL-friendly slug. It's accessible to all models and controllers.

## Import

```javascript
const { generateSlug } = require("../utils/modelHelper");
```

## Function Signature

```javascript
generateSlug(text)
```

### Parameters
- **text** (String): The text to convert into a slug

### Returns
- **String**: URL-friendly slug (lowercase, hyphen-separated)

## How It Works

The function performs the following transformations:
1. Converts text to lowercase
2. Trims whitespace from start and end
3. Replaces spaces with hyphens (-)
4. Removes all non-word characters (except hyphens)
5. Replaces multiple consecutive hyphens with a single hyphen
6. Removes hyphens from start and end

## Usage Examples

### Example 1: In Model Schema (Setter)

```javascript
const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const modelSchema = new mongoose.Schema({
  product_name: {
    type: String,
    required: true,
  },
  product_slug: {
    type: String,
    required: true,
    set: function(value) {
      // If empty, generate slug from product_name
      if (!value || value === '' || value === 'null' || value === undefined) {
        if (this.product_name) {
          return generateSlug(this.product_name);
        }
        return '';
      }
      // If value provided, slugify it to ensure it's URL-friendly
      return generateSlug(value);
    }
  }
});
```

### Example 2: In Pre-Save Hook

```javascript
const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const blogSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    unique: true,
  }
});

// Auto-generate slug before saving
blogSchema.pre('save', function(next) {
  if (!this.slug && this.title) {
    this.slug = generateSlug(this.title);
  }
  next();
});

module.exports = mongoose.model("blog", blogSchema);
```

### Example 3: In Controller

```javascript
const { generateSlug } = require("../utils/modelHelper");

async function createProduct(req, res) {
  try {
    // Generate slug from product name if not provided
    if (!req.body.slug && req.body.product_name) {
      req.body.slug = generateSlug(req.body.product_name);
    }
    
    const product = await Product.create(req.body);
    res.status(201).json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
```

### Example 4: Manual Usage

```javascript
const { generateSlug } = require("../utils/modelHelper");

// Generate slugs manually
const slug1 = generateSlug("Gaming Laptop Pro");
// Result: "gaming-laptop-pro"

const slug2 = generateSlug("iPhone 15 Pro Max!!!");
// Result: "iphone-15-pro-max"

const slug3 = generateSlug("Node.js Tutorial - Part 1");
// Result: "nodejs-tutorial-part-1"

const slug4 = generateSlug("Product @ Special Price $99");
// Result: "product-special-price-99"
```

### Example 5: Category Model with Auto-Slug

```javascript
const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    unique: true,
    set: function(value) {
      return value ? generateSlug(value) : generateSlug(this.name);
    }
  }
}, { timestamps: true });

// Ensure slug is generated before validation
categorySchema.pre('validate', function(next) {
  if (!this.slug && this.name) {
    this.slug = generateSlug(this.name);
  }
  next();
});

module.exports = mongoose.model("category", categorySchema);
```

### Example 6: With Unique Slug Generation

```javascript
const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");

const articleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  slug: {
    type: String,
    unique: true,
  }
});

// Generate unique slug with counter if duplicate exists
articleSchema.pre('save', async function(next) {
  if (!this.slug && this.title) {
    let baseSlug = generateSlug(this.title);
    let slug = baseSlug;
    let counter = 1;
    
    // Check if slug exists, if yes, add counter
    while (await this.constructor.findOne({ slug, _id: { $ne: this._id } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    this.slug = slug;
  }
  next();
});

module.exports = mongoose.model("article", articleSchema);
```

### Example 7: Using in Update Operations

```javascript
const { generateSlug } = require("../utils/modelHelper");

async function updateProduct(req, res) {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // If product_name is being updated and no slug provided, regenerate slug
    if (updateData.product_name && !updateData.product_slug) {
      updateData.product_slug = generateSlug(updateData.product_name);
    }
    
    const product = await Product.findByIdAndUpdate(
      id, 
      updateData, 
      { new: true }
    );
    
    res.json({ success: true, data: product });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
```

## Transformation Examples

| Input | Output |
|-------|--------|
| `"Product Name"` | `"product-name"` |
| `"iPhone 15 Pro Max"` | `"iphone-15-pro-max"` |
| `"Gaming Laptop 2024"` | `"gaming-laptop-2024"` |
| `"Node.js Tutorial"` | `"nodejs-tutorial"` |
| `"Product @ $99.99"` | `"product-9999"` |
| `"Hello   World"` | `"hello-world"` |
| `"--Product--"` | `"product"` |
| `"Café & Restaurant"` | `"caf-restaurant"` |
| `"100% Organic!"` | `"100-organic"` |

## Best Practices

### 1. Always Validate Unique Slugs
```javascript
// Before creating
const existingSlug = await Model.findOne({ slug: generatedSlug });
if (existingSlug) {
  // Handle duplicate - add counter or show error
}
```

### 2. Store Original Title/Name
```javascript
// Always keep both the original name and the slug
{
  product_name: "iPhone 15 Pro Max!!!",  // Original
  product_slug: "iphone-15-pro-max"      // Slug for URLs
}
```

### 3. Index Slug Fields
```javascript
// Make slug searchable and unique
modelSchema.index({ slug: 1 }, { unique: true });
```

### 4. Handle Empty Values
```javascript
// Always check if the source field exists
if (this.product_name) {
  this.product_slug = generateSlug(this.product_name);
} else {
  this.product_slug = '';
}
```

### 5. Use in URL Routing
```javascript
// Use slugs in URLs instead of IDs
router.get('/products/:slug', async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug });
  res.json(product);
});

// Example: /products/iphone-15-pro-max
// Instead of: /products/507f1f77bcf86cd799439011
```

## Benefits

1. **SEO Friendly**: Clean, readable URLs
2. **User Friendly**: Easy to share and remember
3. **Consistent**: Same format across all models
4. **Reusable**: One function for all slug needs
5. **Safe**: Removes special characters and handles edge cases

## Common Use Cases

- Product slugs for e-commerce
- Blog post URLs
- Category pages
- User profile URLs
- Tag/keyword pages
- Article permalinks
- Documentation pages

This utility function helps maintain clean, consistent, and SEO-friendly URLs throughout your entire application!

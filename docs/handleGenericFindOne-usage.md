# handleGenericFindOne - Generic Find One Record Function

## Overview

The `handleGenericFindOne` function is a powerful generic utility that allows you to find a single record from any model using custom search criteria and flexible options. Unlike `handleGenericGetById` which only finds by ID, this function lets you search by any field or combination of fields.

## Import

```javascript
const { handleGenericFindOne } = require("../utils/modelHelper");
```

## Basic Usage

```javascript
async function findUserByEmail(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: { email: req.params.email }
  });
  return res.status(response.status).json(response);
}
```

## Function Signature

```javascript
handleGenericFindOne(req, controllerName, options)
```

### Parameters

- **req** (Object): Express request object
- **controllerName** (String, optional): Name of the model/controller (auto-detected if not provided)
- **options** (Object): Configuration options

### Options Object

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `searchCriteria` | Object | `{}` | **Required.** MongoDB query criteria |
| `excludeFields` | Array | `[]` | Fields to exclude from response |
| `includeFields` | Array | `[]` | Fields to include (if specified, only these returned) |
| `populate` | Array | `[]` | Fields to populate with referenced data |
| `sort` | Object | `{}` | Sort criteria |
| `beforeFind` | Function | `null` | Hook function executed before finding |
| `afterFind` | Function | `null` | Hook function executed after finding |
| `errorHandlers` | Object | `{}` | Custom error handlers |

## Examples

### 1. Simple Field Search

```javascript
// Find user by email
async function findUserByEmail(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: { email: req.body.email.toLowerCase() },
    excludeFields: ["password"]
  });
  return res.status(response.status).json(response);
}
```

### 2. Multiple Criteria Search

```javascript
// Find active blog by category and status
async function findActiveBlog(req, res) {
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria: {
      category: req.body.category,
      status: "published",
      active: true
    }
  });
  return res.status(response.status).json(response);
}
```

### 3. Field Selection

```javascript
// Only return specific fields
async function findUserBasicInfo(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: { email: req.params.email },
    includeFields: ["name", "email", "createdAt"] // Only these fields returned
  });
  return res.status(response.status).json(response);
}
```

### 4. Population (Join Related Data)

```javascript
// Find blog with populated author and category
async function findBlogWithDetails(req, res) {
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria: { slug: req.params.slug },
    populate: ["author", "category"],
    excludeFields: ["internal_notes"]
  });
  return res.status(response.status).json(response);
}
```

### 5. Complex Population

```javascript
// Advanced populate with field selection
async function findBlogWithAuthorName(req, res) {
  const response = await handleGenericFindOne(req, "blog", {
    searchCriteria: { _id: req.params.id },
    populate: [
      { path: "author", select: "name email" },
      { path: "category", select: "name slug" }
    ]
  });
  return res.status(response.status).json(response);
}
```

### 6. MongoDB Operators

```javascript
// Using MongoDB query operators
async function findUserInRoles(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: {
      role: { $in: ["ADMIN", "MODERATOR"] }, // Array contains
      age: { $gte: 18 }, // Greater than or equal
      status: { $ne: "banned" } // Not equal
    },
    sort: { lastLoginAt: -1 } // Most recently active
  });
  return res.status(response.status).json(response);
}
```

### 7. Dynamic Search Criteria

```javascript
// Build search criteria dynamically
async function findProductByFilters(req, res) {
  const { category, minPrice, maxPrice, brand, inStock } = req.body;
  
  const searchCriteria = {};
  if (category) searchCriteria.category = category;
  if (brand) searchCriteria.brand = brand;
  if (minPrice || maxPrice) {
    searchCriteria.price = {};
    if (minPrice) searchCriteria.price.$gte = minPrice;
    if (maxPrice) searchCriteria.price.$lte = maxPrice;
  }
  if (inStock !== undefined) searchCriteria.inStock = inStock;
  
  const response = await handleGenericFindOne(req, "product", {
    searchCriteria,
    sort: { createdAt: -1 }
  });
  return res.status(response.status).json(response);
}
```

### 8. Using Hooks

```javascript
// With before/after hooks
async function findAndLogUser(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: { email: req.params.email },
    excludeFields: ["password"],
    beforeFind: async (criteria, req) => {
      console.log("🔍 Searching for user with criteria:", criteria);
      // Modify criteria if needed
      criteria.active = true;
      return criteria;
    },
    afterFind: async (record, req) => {
      console.log("✅ Found user:", record.name);
      // Log user access, update last seen, etc.
    }
  });
  return res.status(response.status).json(response);
}
```

### 9. Custom Error Handling

```javascript
async function findUserWithCustomErrors(req, res) {
  const response = await handleGenericFindOne(req, "user", {
    searchCriteria: { email: req.params.email },
    errorHandlers: {
      11000: (error) => ({
        success: false,
        status: 409,
        error: "Duplicate key error",
        message: "This operation conflicts with existing data"
      })
    }
  });
  return res.status(response.status).json(response);
}
```

## Return Format

### Success Response

```javascript
{
  success: true,
  status: 200,
  data: {
    // Record data with requested fields
  }
}
```

### Error Response

```javascript
{
  success: false,
  status: 404, // or other error code
  error: "Record not found",
  details: "Additional error details",
  type: "not_found" // Error type
}
```

## Common Error Types

- `configuration`: Missing controller name
- `missing_criteria`: No search criteria provided
- `not_found`: No record matches criteria
- `invalid_format`: Invalid field format (e.g., invalid ObjectId)
- `validation`: MongoDB validation error
- `database`: General database error

## Tips and Best Practices

### 1. Always Exclude Sensitive Fields

```javascript
// Always exclude password and other sensitive data
excludeFields: ["password", "token", "internal_notes"]
```

### 2. Use Indexes for Performance

Ensure your search criteria fields are indexed in MongoDB:

```javascript
// Good - indexed fields
searchCriteria: { email: "user@example.com" } // email should be indexed

// Be careful - non-indexed fields may be slow
searchCriteria: { description: { $regex: "keyword" } }
```

### 3. Limit Fields for Large Documents

```javascript
// For large documents, only return what you need
includeFields: ["name", "email", "status"]
```

### 4. Use Population Wisely

```javascript
// Good - specific field selection in populate
populate: [{ path: "author", select: "name email" }]

// Avoid - populating entire large documents
populate: ["author"] // May return too much data
```

### 5. Handle Array Fields

```javascript
// Find documents where array contains value
searchCriteria: { tags: { $in: ["javascript", "nodejs"] } }

// Find documents where array has exact match
searchCriteria: { tags: "javascript" }
```

## Route Integration Examples

### API Routes

```javascript
// In routes/api.js
const { findUserByEmail, findBlogBySlug } = require("../controllers/user");

router.get("/user/email/:email", findUserByEmail);
router.get("/blog/slug/:slug", findBlogBySlug);
router.post("/user/find-by-company", findUserByCompany);
```

### Controller Function Structure

```javascript
// Standard controller function using handleGenericFindOne
async function controllerFunction(req, res) {
  try {
    const response = await handleGenericFindOne(req, "modelName", {
      searchCriteria: { /* your criteria */ },
      // other options...
    });
    
    return res.status(response.status).json(response);
  } catch (error) {
    // This catch is usually not needed as handleGenericFindOne handles errors
    console.error("Unexpected error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error"
    });
  }
}
```

This function provides a powerful and flexible way to query your database while maintaining consistency with your existing generic functions.

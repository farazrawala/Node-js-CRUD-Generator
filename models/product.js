const mongoose = require("mongoose");
const { generateSlug } = require("../utils/modelHelper");
const {
  buildProductThumbnailFields,
} = require("../utils/productImageThumbnail");

const modelSchema = new mongoose.Schema(
  {
    parent_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      field_name: "Parent Product",
    },
    product_name: {
      type: String,
      required: true,
      field_name: "Product Name",
    },
    product_code: {
      type: String,
      field_name: "Product code",
    },
    alert_qty: {
      type: Number,
      field_name: "Alert Qty",
      default: 0,
    },
    brand_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "brands",
      field_name: "Brand Name",
    },
    unit: {
      type: String,
      required: true,
      field_type: "select",
      enum: [
        "Piece",
        "Kg",
        "Ltr",
        "Box",
        "Meter",
        "Feet",
        "Yard",
        "Inch",
        "Centimeter",
        "Millimeter",
        "Others",
      ],
      default: "Piece",
    },
    weight: {
      type: Number,
      field_name: "Weight",
    },
    length: {
      type: Number,
      field_name: "Length",
    },
    width: {
      type: Number,
      field_name: "Width",
    },
    height: {
      type: Number,
      field_name: "Height",
    },
    dimension: {
      type: String,
      field_name: "Dimension",
    },
    price_before_tax: {
      type: Number,
      field_name: "Price Before Tax",
      default: 0,
    },
    tax_rate: {
      type: Number,
      field_name: "Tax Rate",
    },
    barcode: {
      type: String,
      field_name: "Product Barcode",
    },
    sku: {
      type: String,
      field_name: "SKU",
    },
    product_type: {
      type: String,
      required: true,
      enum: ["Single", "Variable"],
      default: "Single",
    },
    // stock: {
    //   type: Number,
    //   default: 0,
    //   field_name: "Stock",
    // },
    category_id: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "category",
      default: [],
      // required: true,
      field_name: "Category",
      field_type: "multiselect",
    },
    product_relations: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "product_relations",
      default: [],
      field_name: "Product Relations",
    },

    ///// BigCommerce Settings /////
    fetch_from_product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "product",
      field_name: "Fetch From Product",
    },

    ///// BigCommerce Settings /////

    company_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "company",
      required: true,
      field_name: "Company",
    },
    product_slug: {
      type: String,
      field_name: "Product Slug",
      default: null,
      set: function (value) {
        // If value provided, slugify it to ensure it's URL-friendly
        if (
          value &&
          value !== "" &&
          value !== "null" &&
          value !== null &&
          value !== undefined
        ) {
          return generateSlug(value);
        }
        // Return null for empty values - will be handled in pre-save hook
        return null;
      },
    },
    wholesale_price: {
      type: Number,
      default: 0,
      field_name: "Wholesale Price",
    },
    product_price: {
      type: Number,
      default: 0,
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
    product_image_thumbnail_url: {
      type: String,
      field_type: "image",
      field_name: "Thumbnail Image",
    },
    multi_images: {
      type: [String],
      field_type: "image",
      field_name: "Multiple Images",
    },
    multi_image_thumbnails: {
      type: [String],
      field_type: "image",
      field_name: "Gallery Thumbnails",
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
  { timestamps: true, shardKey: { company_id: 1, _id: 1 } },
);

/** Rows in `warehouse_inventory` for this product (separate collection, not embedded). */
modelSchema.virtual("warehouse_inventory", {
  ref: "warehouse_inventory",
  localField: "_id",
  foreignField: "product_id",
});

modelSchema.set("toObject", { virtuals: true });
modelSchema.set("toJSON", { virtuals: true });

// Pre-validate hook to handle slug generation before validation (runs first)
modelSchema.pre("validate", function (next) {
  if (
    !this.product_type ||
    this.product_type === "" ||
    this.product_type === null
  ) {
    this.product_type = "Single";
  }

  // If slug is empty, null, or undefined, generate it from product_name
  if (
    (!this.product_slug ||
      this.product_slug === "" ||
      this.product_slug === null) &&
    this.product_name
  ) {
    const newSlug = generateSlug(this.product_name);
    this.product_slug = newSlug;
  }
  next();
});

// Pre-save hook to ensure slug is always generated from product_name if empty (backup)
modelSchema.pre("save", function (next) {
  if (
    !this.product_type ||
    this.product_type === "" ||
    this.product_type === null
  ) {
    this.product_type = "Single";
  }

  // If slug is still empty, null, or undefined, generate it from product_name
  if (
    (!this.product_slug ||
      this.product_slug === "" ||
      this.product_slug === null) &&
    this.product_name
  ) {
    const newSlug = generateSlug(this.product_name);
    this.product_slug = newSlug;
  }

  // Standalone/parent products keep parent_product_id null.
  // Only variants should set parent_product_id to another product's _id.
  if (
    this.parent_product_id &&
    this._id &&
    String(this.parent_product_id) === String(this._id)
  ) {
    this.parent_product_id = null;
  }

  next();
});

// Generate thumbnail paths when featured/gallery images change.
modelSchema.pre("save", async function (next) {
  if (this._syncingThumbnails) return next();
  if (!this.isModified("product_image") && !this.isModified("multi_images")) {
    return next();
  }

  try {
    this._syncingThumbnails = true;
    const thumbFields = await buildProductThumbnailFields({
      product_image: this.product_image,
      multi_images: this.multi_images,
    });
    Object.assign(this, thumbFields);
    this._syncingThumbnails = false;
    next();
  } catch (error) {
    this._syncingThumbnails = false;
    next(error);
  }
});

// Tenant-scoped uniqueness for POS lookup (only non-empty values, active rows)
modelSchema.index(
  { company_id: 1, sku: 1 },
  {
    unique: true,
    name: "product_company_sku_1",
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true, $ne: null },
      sku: { $exists: true, $nin: [null, ""] },
    },
  },
);
modelSchema.index(
  { company_id: 1, barcode: 1 },
  {
    unique: true,
    name: "product_company_barcode_1",
    partialFilterExpression: {
      deletedAt: null,
      company_id: { $exists: true, $ne: null },
      barcode: { $exists: true, $nin: [null, ""] },
    },
  },
);

const MODEL = mongoose.model("product", modelSchema);

module.exports = MODEL;

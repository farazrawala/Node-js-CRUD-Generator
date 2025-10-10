const mongoose = require("mongoose");

const modelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      field_name: "Product Name",
    },
    price: {
      type: String,
      required: true,
      field_name: "Product Price",
    },
    description: {
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

const MODEL = mongoose.model("product", modelSchema);

module.exports = MODEL;

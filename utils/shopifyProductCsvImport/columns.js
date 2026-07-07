/** Shopify export columns we read (header names normalized to snake_case). */
const SHOPIFY_IMPORT_COLUMNS = {
  handle: ["handle"],
  title: ["title"],
  description: ["body_(html)", "body_html", "body"],
  vendor: ["vendor"],
  category: ["product_category", "category"],
  type: ["type"],
  variant_sku: ["variant_sku", "sku"],
  variant_barcode: ["variant_barcode", "barcode"],
  variant_price: ["variant_price", "price"],
  cost_per_item: ["cost_per_item", "cost"],
  variant_inventory_qty: [
    "variant_inventory_qty",
    "inventory_qty",
    "qty",
    "quantity",
  ],
  option1_value: ["option1_value"],
  option2_value: ["option2_value"],
  option3_value: ["option3_value"],
  status: ["status"],
  image_src: ["image_src"],
  variant_image: ["variant_image"],
};

module.exports = { SHOPIFY_IMPORT_COLUMNS };

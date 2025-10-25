/**
 * EAN13 Barcode Generator Utility
 * Generates valid EAN13 barcodes with proper check digit calculation
 */

/**
 * Calculate the check digit for EAN13 barcode
 * @param {string} barcode - 12-digit barcode without check digit
 * @returns {string} - The calculated check digit
 */
function calculateEAN13CheckDigit(barcode) {
  if (barcode.length !== 12) {
    throw new Error('Barcode must be exactly 12 digits');
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(barcode[i]);
    // Odd positions (1, 3, 5, ...) are multiplied by 1
    // Even positions (2, 4, 6, ...) are multiplied by 3
    sum += digit * (i % 2 === 0 ? 1 : 3);
  }

  // The check digit is the smallest number that makes the sum divisible by 10
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit.toString();
}

/**
 * Generate a unique EAN13 barcode
 * @param {string} prefix - Optional prefix (default: "200" for internal use)
 * @param {number} timestamp - Optional timestamp for uniqueness
 * @returns {string} - Complete 13-digit EAN13 barcode
 */
function generateEAN13(prefix = "200", timestamp = null) {
  // Use current timestamp if not provided
  if (!timestamp) {
    timestamp = Date.now();
  }

  // Convert timestamp to string and take last digits
  const timestampStr = timestamp.toString();
  
  // Create 12-digit base (prefix + timestamp digits)
  let base = prefix;
  
  // Add timestamp digits to reach 12 digits total
  const remainingDigits = 12 - prefix.length;
  if (remainingDigits > 0) {
    // Take last digits from timestamp
    const timestampDigits = timestampStr.slice(-remainingDigits);
    base += timestampDigits.padStart(remainingDigits, '0');
  }

  // Ensure we have exactly 12 digits
  base = base.slice(0, 12).padStart(12, '0');

  // Calculate check digit
  const checkDigit = calculateEAN13CheckDigit(base);

  // Return complete 13-digit EAN13
  return base + checkDigit;
}

/**
 * Validate an EAN13 barcode
 * @param {string} barcode - 13-digit EAN13 barcode
 * @returns {boolean} - True if valid, false otherwise
 */
function validateEAN13(barcode) {
  if (!barcode || barcode.length !== 13) {
    return false;
  }

  // Check if all characters are digits
  if (!/^\d{13}$/.test(barcode)) {
    return false;
  }

  // Extract base and check digit
  const base = barcode.slice(0, 12);
  const providedCheckDigit = barcode.slice(12, 13);

  // Calculate expected check digit
  const expectedCheckDigit = calculateEAN13CheckDigit(base);

  return providedCheckDigit === expectedCheckDigit;
}

/**
 * Generate a unique EAN13 barcode for products
 * Uses product-specific prefix and ensures uniqueness
 * @param {string} productPrefix - Optional product-specific prefix
 * @returns {string} - Unique EAN13 barcode
 */
function generateProductBarcode(productPrefix = "200") {
  // Add microseconds for better uniqueness
  const timestamp = Date.now() + Math.floor(Math.random() * 1000);
  return generateEAN13(productPrefix, timestamp);
}

module.exports = {
  generateEAN13,
  generateProductBarcode,
  validateEAN13,
  calculateEAN13CheckDigit
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateDDMMYYYY(d) {
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}`;
}

function formatTimeHHMMSS(d) {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * Generate transaction number.
 *
 * Examples:
 * - default: TXN-1715199548123-123456
 * - date only: TXN-08052026-123456
 * - date + time: TXN-08052026-205532-123456
 */
function generateTransactionNumber(options = {}) {
  const {
    prefix = "TXN",
    includeDate = false,
    includeTime = false,
    randomDigits = 7,
    now = new Date(),
  } = options;

  const randomPart = Math.floor(Math.random() * 10 ** randomDigits)
    .toString()
    .padStart(randomDigits, "0");

  const parts = [prefix];
  if (includeDate) {
    parts.push(formatDateDDMMYYYY(now));
    if (includeTime) {
      parts.push(formatTimeHHMMSS(now));
    }
  } else {
    parts.push(String(now.getTime()));
  }
  parts.push(randomPart);
  return parts.join("-");
}

module.exports = { generateTransactionNumber };

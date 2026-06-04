function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateDDMMYY(d) {
  return `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${pad2(d.getFullYear() % 100)}`;
}

function formatTimeHHMMSS(d) {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * Generate transaction number.
 *
 * Examples:
 * - default: TXN-040626-143022-1234567 (DDMMYY-HHMMSS + 7 random digits)
 * - date only: TXN-040626-1234567 (`includeTime: false`)
 * - legacy timestamp: TXN-1715199548123-1234567 (`includeDate: false`)
 */
function generateTransactionNumber(options = {}) {
  const {
    prefix = "TXN",
    includeDate = true,
    includeTime = true,
    randomDigits = 7,
    now = new Date(),
  } = options;

  const randomPart = Math.floor(Math.random() * 10 ** randomDigits)
    .toString()
    .padStart(randomDigits, "0");

  const parts = [prefix];
  if (includeDate) {
    parts.push(formatDateDDMMYY(now));
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

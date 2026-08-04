/**
 * Shared HTTP helper with timeout + retry for courier provider APIs.
 * Uses native fetch (Node 18+).
 * @module src/utils/httpClient
 */

const courierLogger = require("./courierLogger");
const {
  networkTimeout,
  rateLimited,
  fromProviderMessage,
} = require("../couriers/errors");

/**
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {*} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {string} [options.provider]
 * @param {'auto'|'json'|'text'|'buffer'} [options.responseType]
 * @returns {Promise<{ status: number, data: *, headers: Headers, contentType: string }>}
 */
async function httpRequest(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = Number(process.env.COURIER_HTTP_TIMEOUT_MS || 30000),
    retries = Number(process.env.COURIER_HTTP_RETRIES || 2),
    provider = "courier",
    responseType = "auto",
  } = options;

  let lastError;
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init = {
        method,
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      };
      if (body !== undefined && body !== null) {
        if (typeof body === "string" || Buffer.isBuffer(body)) {
          init.body = body;
        } else {
          init.headers["Content-Type"] =
            init.headers["Content-Type"] || "application/json";
          init.body = JSON.stringify(body);
        }
      }

      const res = await fetch(url, init);
      const contentType = String(res.headers.get("content-type") || "").toLowerCase();
      const wantsBuffer =
        responseType === "buffer" ||
        (responseType === "auto" &&
          (contentType.includes("application/pdf") ||
            contentType.includes("octet-stream") ||
            contentType.includes("application/zip")));

      let data = null;
      if (wantsBuffer) {
        const ab = await res.arrayBuffer();
        data = Buffer.from(ab);
      } else {
        const text = await res.text();
        if (responseType === "text") {
          data = text;
        } else {
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = text;
          }
        }
      }

      if (res.status === 429) {
        const err = rateLimited(provider, { status: res.status, data });
        if (attempt < maxAttempts) {
          courierLogger.retry({
            provider,
            url,
            attempt,
            reason: "rate_limit",
          });
          await sleep(500 * attempt);
          lastError = err;
          continue;
        }
        throw err;
      }

      if (res.status >= 500 && attempt < maxAttempts) {
        courierLogger.retry({
          provider,
          url,
          attempt,
          reason: `http_${res.status}`,
        });
        await sleep(500 * attempt);
        lastError = fromProviderMessage(`HTTP ${res.status}`, {
          provider,
          httpStatus: res.status,
          details: Buffer.isBuffer(data) ? { bytes: data.length } : data,
          retryable: true,
        });
        continue;
      }

      return { status: res.status, data, headers: res.headers, contentType };
    } catch (err) {
      if (err.name === "AbortError" || err.code === "NETWORK_TIMEOUT") {
        lastError = networkTimeout(provider);
      } else if (err.code && err.httpStatus) {
        lastError = err;
      } else {
        const cause =
          err?.cause?.code ||
          err?.cause?.message ||
          err?.code ||
          "";
        const msg = cause
          ? `${err.message || "Network error"} (${cause})`
          : err.message || "Network error";
        lastError = fromProviderMessage(msg, {
          provider,
          retryable: /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|socket/i.test(
            `${err.message || ""} ${cause}`,
          ),
          httpStatus: 503,
        });
      }

      if (attempt < maxAttempts && (lastError.retryable || err.name === "AbortError")) {
        courierLogger.retry({
          provider,
          url,
          attempt,
          reason: lastError.code || err.message,
        });
        await sleep(500 * attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { httpRequest, sleep };

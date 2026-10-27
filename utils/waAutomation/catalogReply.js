/**
 * Product details for an AI auto-reply.
 *
 * The model has no catalog and no second turn, so "let me check, give me a sec"
 * is the whole message the customer ever gets. When their text is a product
 * name, look the products up first and send name, price and stock in that same
 * message. A flow that is already waiting on a question does its own search;
 * this only runs when the AI is the one answering.
 */
const { runApi } = require("./lookups");
const { formatProductList, isClosingReply, normalizeReply } = require("./messageFormat");

const ACKS = new Set([
  "yes", "no", "ok", "okay", "y", "n", "yeah", "yep", "nope", "ji", "jee",
  "haan", "han", "nahi", "nah", "cancel", "stop",
]);
const GREETINGS = new Set([
  "hi", "hello", "hey", "salam", "salaam", "aoa", "menu", "help", "start",
  "assalam", "assalam o alaikum", "assalamu alaikum", "walaikum salam", "wa alaikum salam",
]);

function askedForProduct(text) {
  return /product|looking for|sku|barcode|name or type/i.test(String(text || ""));
}

/**
 * Whether this customer message should hit the catalog.
 * `mustAnswer` means a miss is "we don't have that", not another AI guess.
 * Returns null when the AI should answer normally (greetings, menu numbers, "yes").
 */
function catalogDecision(message, previousBotText) {
  const raw = String(message ?? "").trim();
  if (!raw || raw.length > 80) return null;
  const norm = normalizeReply(raw);
  if (!norm || isClosingReply(raw)) return null;
  if (/^\d+$/.test(norm)) return null;
  if (GREETINGS.has(norm) || ACKS.has(norm)) return null;
  const asked = askedForProduct(previousBotText);
  if (asked) return { mustAnswer: true };
  if (norm.split(" ").length > 4) return null;
  return { mustAnswer: false };
}

function quoteQuery(message) {
  return String(message ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function catalogMessage(query, products) {
  if (products?.length) {
    return `Here is what we found for “${query}”:\n\n${formatProductList(products)}`;
  }
  return `Sorry, we could not find any product matching “${query}”.`;
}

async function readAppUrl(companyId) {
  const Settings = require("../../models/wa_automation_settings");
  const row = companyId ? await Settings.findOne({ company_id: companyId }).select("app_url").lean() : null;
  return String(row?.app_url || "");
}

/**
 * The WhatsApp text to send instead of an AI reply, or null to let the AI talk.
 * `search(query)` is for tests; live chats use the POS product search.
 */
async function catalogReplyForMessage({ companyId, message, previousBotText, appUrl, search } = {}) {
  const decision = catalogDecision(message, previousBotText);
  if (!decision) return null;
  const query = quoteQuery(message);
  let result = null;
  try {
    result = search
      ? await search(query)
      : await runApi("pos_products", {}, { search_query: query }, {
          companyId,
          appUrl: appUrl != null ? appUrl : await readAppUrl(companyId),
        });
  } catch {
    return null;
  }
  const products = result?.ok && Array.isArray(result.products) ? result.products : [];
  if (!products.length && !decision.mustAnswer) return null;
  const shown = String(result?.vars?.search_query || query);
  return catalogMessage(shown, products);
}

module.exports = {
  catalogDecision,
  catalogMessage,
  catalogReplyForMessage,
};

/**
 * WhatsApp automation — text helpers shared by the flow engine, the inbound
 * handler and the builder's test chat. Pure functions, no database access.
 *
 * Messages reach customers through the WhatsApp Web extension, which can only
 * type plain text and read plain text back. So menus are numbered text lists
 * the customer answers by typing a number or the option's name.
 *
 * Keep composeMenuText / interpolate in sync with the frontend copy in
 * ai-pos `src/features/whatsappAutomation/messageFormat.js`.
 */

/** WhatsApp's limit for one text message. */
const MAX_TEXT_LENGTH = 4096;

const KEYCAPS = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const OPTIONS_PLACEHOLDER = /\{\{\s*options\s*\}\}/g;
const OPTIONS_SENTINEL = "\u0000OPTIONS\u0000";

/** Arabic-Indic (٠-٩) and Urdu/Persian (۰-۹) digits → 0-9. */
function toAsciiDigits(text) {
  return String(text ?? "").replace(/[٠-٩۰-۹]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * Lower-case words only, for matching replies and keywords:
 * "1️⃣" → "1", "Order Status!" → "order status", "۲" → "2".
 */
function normalizeReply(text) {
  return toAsciiDigits(text)
    .normalize("NFKC")
    .replace(/🔟/g, "10")
    .replace(/[⃣️]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Thanks and goodbyes (after normalizeReply): these close a chat. */
const THANKS_PHRASES = new Set([
  "thanks", "thank you", "thankyou", "thank u", "thanku", "thx", "thnx", "tnx", "ty", "tysm", "many thanks",
  "shukriya", "shukria", "shukrya", "shukran", "jazakallah", "jazak allah", "jzk",
  "bye", "goodbye", "allah hafiz", "khuda hafiz", "شکریہ", "جزاک اللہ",
]);
/** "ok", "ji", "acha"… go with a thanks ("ok thanks"), but alone they can mean "yes". */
const ACK_PHRASES = new Set([
  "ok", "okay", "okey", "okk", "k", "kk", "alright", "fine", "done", "got it", "noted", "great", "perfect", "nice",
  "good", "cool", "theek hai", "thik hai", "acha", "achha", "g", "ji", "jee", "ٹھیک ہے", "اوکے",
]);
const FILLER_WORDS = new Set(["so", "much", "a", "lot", "very", "bohat", "boht", "bht", "bhai", "bro", "sir", "dear", "again", "khair"]);

/**
 * The customer is closing the chat rather than answering: "Thanks", "ok shukriya
 * bhai", "thank you so much", or emoji only ("👍", "🙏").
 */
function isClosingReply(text) {
  const norm = normalizeReply(text);
  if (!norm) return /\p{Extended_Pictographic}/u.test(String(text ?? ""));
  const words = norm.split(" ");
  let thanked = false;
  for (let i = 0; i < words.length; ) {
    const pair = i + 1 < words.length ? `${words[i]} ${words[i + 1]}` : "";
    if (pair && (THANKS_PHRASES.has(pair) || ACK_PHRASES.has(pair))) {
      thanked ||= THANKS_PHRASES.has(pair);
      i += 2;
    } else if (THANKS_PHRASES.has(words[i]) || ACK_PHRASES.has(words[i]) || FILLER_WORDS.has(words[i])) {
      thanked ||= THANKS_PHRASES.has(words[i]);
      i += 1;
    } else {
      return false;
    }
  }
  return thanked;
}

/** "hi, Hello , salam" → ["hi", "hello", "salam"] */
function parseKeywords(raw) {
  return String(raw ?? "")
    .split(",")
    .map(normalizeReply)
    .filter(Boolean);
}

/**
 * Replace `{{variable}}` and `{{variable|fallback}}`.
 * Live messages drop variables that have no value (with the space before them),
 * so "Hi {{customer_name}}!" becomes "Hi!" rather than showing the braces.
 * `keepUnknown` leaves never-set variables as typed (editor previews).
 */
function interpolate(text, vars = {}, { keepUnknown = false } = {}) {
  return String(text ?? "").replace(
    /( ?)\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g,
    (match, space, key, fallback) => {
      const value = vars[key];
      if (value != null && String(value) !== "") return space + String(value);
      if (fallback != null && fallback.trim() !== "") return space + fallback.trim();
      if (keepUnknown && !(key in vars)) return match;
      return "";
    },
  );
}

/** The key a customer types for an option: its value, else its position. */
function optionKey(option, index) {
  const value = String(option?.value ?? "").trim();
  return value || String(index + 1);
}

/** "1️⃣ Order Status" lines (or "A. Title" for non-numeric keys / plain style). */
function formatOptionList(options = [], { style = "emoji", vars = {}, keepUnknown = false } = {}) {
  return (options || [])
    .map((opt, i) => {
      const key = optionKey(opt, i);
      const title = interpolate(opt?.title || `Option ${i + 1}`, vars, { keepUnknown }).trim();
      const n = /^\d+$/.test(key) ? Number(key) : NaN;
      const bullet = style !== "plain" && n >= 0 && n <= 10 ? KEYCAPS[n] : `${key}.`;
      return `${bullet} ${title}`;
    })
    .join("\n");
}

/** Products from a product search as text (WhatsApp Web cannot send cards). */
function formatProductList(products = []) {
  return (products || [])
    .map((p) => {
      const lines = [`*${p.name}*`];
      const meta = [p.price, p.stock].filter(Boolean).join(" · ");
      if (meta) lines.push(meta);
      if (p.sku) lines.push(`SKU ${p.sku}`);
      if (p.url) lines.push(`View: ${p.url}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function tidy(text) {
  return String(text ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The exact text a menu step sends. The option list goes where the message says
 * `{{options}}`, otherwise at the end (unless `appendOptions` is false).
 * Product results (when `showProducts`) go just before the option list.
 */
function composeMenuText(data = {}, vars = {}, products = [], { keepUnknown = false } = {}) {
  const list = formatOptionList(data.options, { style: data.listStyle, vars, keepUnknown });
  const productText = data.showProducts && products?.length ? formatProductList(products) : "";
  const raw = String(data.text ?? "");
  const hasPlaceholder = OPTIONS_PLACEHOLDER.test(raw);
  OPTIONS_PLACEHOLDER.lastIndex = 0;
  const body = interpolate(raw.replace(OPTIONS_PLACEHOLDER, OPTIONS_SENTINEL), vars, { keepUnknown });

  if (hasPlaceholder) {
    const block = [productText, list].filter(Boolean).join("\n\n");
    return tidy(body.split(OPTIONS_SENTINEL).join(block));
  }
  const parts = [body, productText];
  if (data.appendOptions !== false) parts.push(list);
  return tidy(parts.filter((p) => String(p).trim()).join("\n\n"));
}

/**
 * Which option a customer reply picks, or null. Accepts the number ("2", "2.",
 * "2️⃣", "۲"), the title ("order status"), or a reply that clearly names one
 * option ("check my order status please").
 */
function matchOption(options = [], text) {
  const reply = normalizeReply(text);
  if (!reply) return null;
  const list = (options || []).map((opt, i) => ({
    opt,
    key: normalizeReply(optionKey(opt, i)),
    title: normalizeReply(opt?.title),
  }));

  const byKey = list.filter((o) => o.key && o.key === reply);
  if (byKey.length === 1) return byKey[0].opt;
  const byTitle = list.filter((o) => o.title && o.title === reply);
  if (byTitle.length === 1) return byTitle[0].opt;

  // "2 delivery" / "2 please" — leading key only when it is unambiguous
  const first = reply.split(" ")[0];
  const byLeadingKey = list.filter((o) => o.key && o.key === first);
  if (byLeadingKey.length === 1 && /^\d+$/.test(first)) return byLeadingKey[0].opt;

  if (reply.length >= 3) {
    const fuzzy = list.filter(
      (o) => o.title && o.title.length >= 3 && (reply.includes(o.title) || o.title.includes(reply)),
    );
    if (fuzzy.length === 1) return fuzzy[0].opt;
  }
  return null;
}

/** "1001", "#1001", "ord1001" → "ORD-1001"; other refs with a digit stay as typed. */
function normalizeOrderNumber(raw) {
  const s = toAsciiDigits(raw).trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^#?(?:ORD)?-?(\d{3,})$/);
  // POS numbers are ORD- plus at least 4 digits ("270" → "ORD-0270").
  if (m) return `ORD-${m[1].padStart(4, "0")}`;
  if (/^#?[A-Z0-9][A-Z0-9-]{2,29}$/.test(s) && /\d/.test(s)) return s.replace(/^#/, "");
  return null;
}

/** Ways an order reference may be stored: ORD-1001, 1001, #1001. */
function orderNumberCandidates(value) {
  const s = String(value ?? "").trim().toUpperCase();
  if (!s) return [];
  const set = new Set([s]);
  const digits = s.match(/^ORD-(\d+)$/)?.[1];
  if (digits) {
    // With and without the POS's zero padding, bare or with "#".
    const bare = digits.replace(/^0+(?=\d)/, "");
    for (const d of new Set([digits, bare, bare.padStart(4, "0")])) {
      set.add(`ORD-${d}`);
      set.add(d);
      set.add(`#${d}`);
    }
  }
  return [...set];
}

/** Phone typed by a customer → international digits (PK local 03xx → 923xx). */
function normalizePhoneInput(raw) {
  let digits = toAsciiDigits(raw).replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = `92${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("3")) digits = `92${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/** A WhatsApp sender id the extension captured is a real phone (not "unknown" or a group id). */
function isLikelyPhone(digits) {
  return /^\d{10,15}$/.test(String(digits ?? ""));
}

function evaluateCondition(data = {}, vars = {}) {
  const actual = String(vars[data.variable] ?? "").trim().toLowerCase();
  const expected = String(data.value ?? "").trim().toLowerCase();
  const list = expected
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  switch (data.operator) {
    case "not_equals":
      return actual !== expected;
    case "contains":
      return expected !== "" && actual.includes(expected);
    case "in":
      return list.includes(actual);
    case "not_in":
      return !list.includes(actual);
    case "is_empty":
      return actual === "";
    case "not_empty":
      return actual !== "";
    case "equals":
    default:
      return actual === expected;
  }
}

/** Business hours are kept in Pakistan time (UTC+5, no DST), like the chat API. */
const BUSINESS_TZ_OFFSET_MINUTES = 5 * 60;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toMinutes = (hhmm) => {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/** No hours configured means "always open". */
function isWithinBusinessHours(date, hours, offsetMinutes = BUSINESS_TZ_OFFSET_MINUTES) {
  if (!Array.isArray(hours) || hours.length === 0) return true;
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  const row = hours.find((h) => h?.day === DAY_NAMES[local.getUTCDay()]);
  if (!row || !row.open) return false;
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  const from = toMinutes(row.from);
  const to = toMinutes(row.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return now >= from && now < to;
}

/** Further ahead than this, a message's WhatsApp time is wrong, not clock drift. */
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * When the customer wrote a message, from the extension's `whatsapp_time` (null if
 * missing). The extension reads ambiguous dates day-first, so on a PC with US dates
 * "10/12/2026" (12 October) arrives as 10 December: a time in the future gets its
 * day and month swapped back when that gives a time that isn't.
 */
function whatsappTime(value, now = Date.now(), offsetMinutes = BUSINESS_TZ_OFFSET_MINUTES) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  if (at.getTime() - now <= FUTURE_TOLERANCE_MS) return at;
  const offset = offsetMinutes * 60000;
  const local = new Date(at.getTime() + offset);
  if (local.getUTCDate() > 12) return at;
  const swapped = new Date(
    Date.UTC(
      local.getUTCFullYear(),
      local.getUTCDate() - 1,
      local.getUTCMonth() + 1,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ) - offset,
  );
  return swapped.getTime() - now <= FUTURE_TOLERANCE_MS ? swapped : at;
}

/**
 * Turn the engine's items into what the customer receives. Consecutive sends that
 * go out at the same time are joined into one WhatsApp message when `combine` is
 * on (each separate message costs a full send cycle in the extension). Notes are
 * kept for the test chat; a note met inside a combined message is shown after it.
 * Returns `[{ type: "bubble", text, delaySeconds } | { type: "note", text, kind }]`.
 */
function planMessages(items = [], { combine = true } = {}) {
  const out = [];
  let group = null;
  let deferred = [];
  const close = () => {
    if (group) out.push({ type: "bubble", text: group.texts.join("\n\n"), delaySeconds: group.delaySeconds });
    out.push(...deferred);
    group = null;
    deferred = [];
  };
  for (const item of items) {
    if (item.type === "note") {
      if (group) deferred.push(item);
      else out.push(item);
      continue;
    }
    const text = String(item.text ?? "").trim();
    if (!text) continue;
    const delaySeconds = item.delaySeconds || 0;
    const joinedLength = group ? group.texts.join("\n\n").length + 2 + text.length : 0;
    if (combine && group && group.delaySeconds === delaySeconds && joinedLength <= MAX_TEXT_LENGTH) {
      group.texts.push(text);
    } else {
      close();
      group = { texts: [text], delaySeconds };
    }
  }
  close();
  return out;
}

module.exports = {
  MAX_TEXT_LENGTH,
  BUSINESS_TZ_OFFSET_MINUTES,
  FUTURE_TOLERANCE_MS,
  toAsciiDigits,
  normalizeReply,
  isClosingReply,
  parseKeywords,
  interpolate,
  optionKey,
  formatOptionList,
  formatProductList,
  composeMenuText,
  matchOption,
  normalizeOrderNumber,
  orderNumberCandidates,
  normalizePhoneInput,
  isLikelyPhone,
  evaluateCondition,
  isWithinBusinessHours,
  whatsappTime,
  planMessages,
};

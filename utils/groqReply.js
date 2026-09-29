const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
// Llama models on Groq are Enterprise-only; override with GROQ_MODEL in .env
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const GROQ_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT =
  "You are a helpful WhatsApp customer support assistant for a business. " +
  "Read the conversation and write the next message the business should send to the customer. " +
  "Always write the reply using English letters (Latin alphabet) only — never Hindi/Devanagari, " +
  "Urdu/Arabic or any other script. If the customer writes Roman Urdu (e.g. \"Kese hein ap?\"), " +
  "reply in Roman Urdu with English letters (e.g. \"Main theek hoon, shukriya! Aap kaise hain?\"); " +
  "otherwise reply in English. Keep it short and friendly, and return only the message text.";

/**
 * Suggests the next outbound WhatsApp message for a chat history.
 * `conversation` is oldest → newest: [{ message, type: "received" | "sent" }].
 * Returns { reply } on success or { error } — never throws.
 */
async function generateExpectedReply(conversation) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { error: "GROQ_API_KEY is not configured" };

  const messages = (conversation || [])
    .filter((c) => c && typeof c.message === "string" && c.message.trim() !== "")
    .map((c) => ({
      role: c.type === "sent" ? "assistant" : "user",
      content: c.message,
    }));
  if (messages.length === 0) return { error: "No messages to reply to" };

  try {
    const model = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
    const response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.5,
        // gpt-oss models reason before answering; keep it short and leave room for the reply
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: json?.error?.message || `Groq request failed (${response.status})`,
      };
    }
    const reply = json?.choices?.[0]?.message?.content?.trim();
    return reply ? { reply } : { error: "Groq returned an empty reply" };
  } catch (error) {
    return { error: error.message || "Groq request failed" };
  }
}

module.exports = { generateExpectedReply };

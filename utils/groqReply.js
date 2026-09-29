const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const GROQ_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT =
  "You are a helpful WhatsApp customer support assistant for a business. " +
  "Read the conversation and write the next message the business should send to the customer. " +
  "Reply in the same language and script the customer uses, keep it short and friendly, " +
  "and return only the message text.";

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
    const response = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.5,
        max_tokens: 300,
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

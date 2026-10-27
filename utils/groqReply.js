const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
// Llama models on Groq are Enterprise-only; override with GROQ_MODEL in .env
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const GROQ_TIMEOUT_MS = 15000;
const SYSTEM_PROMPT = `You write WhatsApp replies for a business's customer support. Read the conversation and write the next message the business should send, the way a friendly, experienced support person would type it on their phone.

Sound human, not like a bot:
- Write casually and warmly, like chatting. Short sentences, natural wording, contractions ("I'll", "don't").
- Keep it to 1–3 short lines. Many good replies are one line.
- Don't use robotic phrases like "As an AI", "I'm here to assist you", "How may I assist you today?", "Thank you for reaching out", "I understand your concern", "Is there anything else I can help you with?", "Feel free to ask".
- Don't use bullet points, headings, bold text, numbered lists or long explanations unless the customer asks for details, such as steps or a price list.
- Don't start every message with a greeting or the customer's name. Greet only at the start of a chat.
- Emojis are fine but use them rarely (at most one, and only when it fits, like 🙂 or 👍).
- Match the customer's tone and energy. If they're brief, be brief. If they're upset, apologise simply and sincerely and focus on fixing the problem.
- Vary your wording. Don't repeat the same phrases as your earlier messages.
- If you don't know something (price, stock, order status, which products you sell), say so in this same message. Never invent a product, a price or stock, and never say you will check and reply later — nothing is sent after this message.

Language:
- Always use English letters (Latin alphabet) only. Never use Hindi/Devanagari, Urdu/Arabic or any other script.
- If the customer writes in Roman Urdu (e.g. "Kese hein ap?"), reply in natural, casual Roman Urdu, the way people actually text (e.g. "Main theek hoon, shukriya! Aap sunaein?"). Otherwise reply in English.

Honesty:
- Don't bring up being automated. But if the customer sincerely asks whether they're talking to a bot or a real person, don't lie. Say you're the business's virtual assistant and offer to connect them with a team member.

Return only the message text, nothing else.`;

/**
 * Suggests the next outbound WhatsApp message for a chat history.
 * `conversation` is oldest → newest: [{ message, type: "received" | "sent" }].
 * Returns { reply } on success or { error } — never throws.
 */
async function generateExpectedReply(conversation) {
  const messages = (conversation || [])
    .filter((c) => c && typeof c.message === "string" && c.message.trim() !== "")
    .map((c) => ({
      role: c.type === "sent" ? "assistant" : "user",
      content: c.message,
    }));
  if (messages.length === 0) return { error: "No messages to reply to" };

  const { content, error } = await groqChat({
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    temperature: 0.5,
    // gpt-oss models reason before answering; keep it short and leave room for the reply
    reasoningEffort: "low",
    maxTokens: 1024,
  });
  if (error) return { error };
  return content ? { reply: content } : { error: "Groq returned an empty reply" };
}

/**
 * One Groq chat completion. `json: true` asks for a JSON object back.
 * Returns { content } or { error } — never throws.
 */
async function groqChat({ messages, temperature = 0.5, maxTokens = 1024, reasoningEffort = "low", json = false, timeoutMs = GROQ_TIMEOUT_MS }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { error: "GROQ_API_KEY is not configured" };
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
        messages,
        temperature,
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: reasoningEffort } : {}),
        ...(json ? { response_format: { type: "json_object" } } : {}),
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        error: body?.error?.message || `Groq request failed (${response.status})`,
      };
    }
    return { content: body?.choices?.[0]?.message?.content?.trim() || "" };
  } catch (error) {
    return { error: error.message || "Groq request failed" };
  }
}

/** Can the AI auto-reply answer at all (a Groq key is set)? */
const isAiReplyConfigured = () => Boolean(process.env.GROQ_API_KEY);

module.exports = { generateExpectedReply, groqChat, isAiReplyConfigured };

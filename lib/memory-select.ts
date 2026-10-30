/**
 * Which saved memories go into this reply's prompt.
 *
 * The prompt has room for a handful of short notes (the local model's whole window is 4,096
 * tokens), so this ranks them: notes sharing words with what the user has just been saying,
 * notes about how they want to be talked to, and, at the start of a conversation, the most
 * recent notes so FREYA can pick up an earlier thread. Pure and framework-free, so it is tested
 * directly.
 */
export type SelectableMemory = { id: string; text: string; createdAt?: string };

export const MEMORY_PROMPT_LIMIT = 5;
/** ~200 tokens: enough for five short notes, small enough for the local window. */
export const MEMORY_PROMPT_CHARS = 800;

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "are", "was", "were", "have", "has", "had",
  "what", "when", "where", "who", "how", "why", "can", "could", "would", "should", "from", "about", "into",
  "then", "them", "they", "will", "just", "like", "want", "please", "tell", "give", "make", "does", "did",
  "user", "their", "there", "been", "being", "really", "very", "some", "any", "but", "not", "all", "its",
  "it's", "i'm", "im", "yeah", "okay", "lol", "hey", "hi",
]);

/** Notes about how to address or talk to them apply to every topic. */
const STANDING = /\b(prefer(s|red|ence)?|name is|called|call (them|him|her|me)|pronouns?|repl(y|ies)|respond|tone|language|keep it|doesn'?t like|hates?|dislikes?)\b/i;

function words(text: string) {
  return new Set((text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((word) => !STOP_WORDS.has(word)));
}

/**
 * @param recentUserTexts the user's last few messages, newest last
 * @param openingTurn true while the conversation is just starting (one or two user messages)
 */
export function selectRelevantMemories<T extends SelectableMemory>(memories: T[], recentUserTexts: string[], openingTurn = false): T[] {
  const latest = words(recentUserTexts.at(-1) ?? "");
  const earlier = words(recentUserTexts.slice(-4, -1).join(" "));
  const newestFirst = [...memories].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const ranked = newestFirst.map((memory, index) => {
    let score = 0;
    for (const word of words(memory.text)) {
      if (latest.has(word)) score += 3;
      else if (earlier.has(word)) score += 1;
    }
    if (STANDING.test(memory.text)) score += 2;
    // A conversation that opens with "hey" still gets something to pick up from.
    if (openingTurn && index < 2) score += 1.5;
    return { memory, score, index };
  });

  const chosen: T[] = [];
  let used = 0;
  for (const { memory } of ranked.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.index - b.index)) {
    const size = memory.text.length + 3;
    if (chosen.length >= MEMORY_PROMPT_LIMIT || used + size > MEMORY_PROMPT_CHARS) continue;
    chosen.push(memory);
    used += size;
  }
  return chosen;
}

/**
 * Memories a browser keeps for itself (no account, or cloud memory not configured). They are
 * the user's own notes about themselves, so they are used, but as untrusted text: bounded,
 * credential-free, and never treated as instructions (the prompt frames them as notes).
 */
export function normalizeLocalMemories(input: unknown, isSensitive: (text: string) => boolean): SelectableMemory[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 60).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { id, text, createdAt } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof text !== "string") return [];
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!clean || isSensitive(clean)) return [];
    return [{ id: id.slice(0, 64), text: clean, ...(typeof createdAt === "string" ? { createdAt: createdAt.slice(0, 40) } : {}) }];
  });
}

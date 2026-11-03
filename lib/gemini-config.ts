/**
 * Which Gemini model to call, and how much it should think first. Shared by every Gemini caller
 * (chat, briefs, the reasoning panel, structured jobs, the health check) so they agree.
 */

/** Used when GEMINI_MODEL isn't set. gemini-2.5-* is retired for new keys (it returns 404). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function geminiModel() {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

/**
 * Gemini 3 Flash models think before answering unless told not to, which on a busy day took a
 * one-word reply from ~3s to 30s+ and past the app's timeouts. These are briefs, descriptions and
 * JSON jobs, not puzzles, so thinking is kept to a minimum. GEMINI_THINKING_LEVEL overrides it
 * (minimal | low | medium | high); "default" leaves it to Google.
 */
export function geminiThinking(model = geminiModel()): { thinkingConfig?: { thinkingLevel: string } } {
  const level = process.env.GEMINI_THINKING_LEVEL?.trim().toLowerCase() || "minimal";
  if (level === "default" || !/^gemini-3.*flash/i.test(model)) return {};
  return { thinkingConfig: { thinkingLevel: level } };
}

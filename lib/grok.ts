/**
 * xAI's Grok, for FREYA's logic work: the reasoning panel, research briefs and structured jobs
 * (memory, visualisation). It's used whenever XAI_API_KEY is set; without one, or when it fails,
 * those jobs stay on Groq. Grok never writes a reply to the user, so it isn't one of the voice
 * providers in lib/llm. Failures are logged by status only, never with provider text.
 */
import { isCoolingDown, markFailure, markSuccess, ProviderHttpError, retryAfterOf } from "@/lib/provider-health";

type GrokOptions = {
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
  effort?: "low" | "medium" | "high";
  json?: boolean;
  signal?: AbortSignal;
};

export function hasGrok() {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

export function grokModel() {
  return process.env.XAI_MODEL?.trim() || "grok-4.7";
}

/** One completion. Throws on any failure, so each caller can fall back to what it used before. */
export async function grokComplete(system: string, user: string, options: GrokOptions): Promise<string> {
  const key = process.env.XAI_API_KEY?.trim();
  const model = grokModel();
  const health = `grok:${model}`;
  if (!key) throw new Error("XAI_API_KEY is not set.");
  if (isCoolingDown(health)) throw new Error("cooling down");
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        // Grok can't turn reasoning off and defaults to "high", too slow to sit inside a chat reply.
        reasoning_effort: options.effort ?? (process.env.XAI_REASONING_EFFORT?.trim() || "low"),
        max_completion_tokens: options.maxTokens,
        temperature: options.temperature ?? 0.3,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderHttpError(`Grok request failed (${response.status}).`, response.status, retryAfterOf(response));
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("The model returned an empty response.");
    markSuccess(health);
    return text.trim();
  } catch (error) {
    // Too slow counts as a failure, so later jobs skip it for a while; the caller hanging up doesn't.
    if (!options.signal?.aborted) markFailure(health, error instanceof ProviderHttpError ? error.status : undefined, error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined);
    throw error;
  }
}

/**
 * Primes the local model's prompt cache with FREYA's persona when the server starts.
 *
 * Ollama caches the longest prompt prefix it has already read. The persona is the same
 * ~2,500 tokens at the start of every request, and reading it cold on a laptop CPU takes
 * about 50 seconds; read once, later requests begin in well under a second. Doing that read
 * at boot means the first message of a session is not the slow one.
 *
 * Fire-and-forget: a failed warm-up costs nothing but the speed-up.
 */

import { buildLocalSystemPrompt, buildSystemPrompt } from "@/lib/personality";
import { normalizeCharacterProfile } from "@/lib/character-profile";
import { ollamaThinking } from "@/lib/llm";

/** Next can bundle the caller twice (startup and the models route), so the guard is process-wide. */
const WARM_INTERVAL_MS = 10 * 60_000;
const warmState = globalThis as typeof globalThis & { __freyaWarmedAt?: number };

export async function warmOllama() {
  const mode = (process.env.AI_PROVIDER || "").trim().toLowerCase();
  // Only when the local model is the one that speaks; otherwise this would load it for nothing.
  if (mode !== "hybrid" && mode !== "ollama") return;
  if (Date.now() - (warmState.__freyaWarmedAt ?? 0) < WARM_INTERVAL_MS) return;
  warmState.__freyaWarmedAt = Date.now();

  const endpoint = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "freya";
  const contextLength = Math.max(1024, Math.min(8192, Number(process.env.OLLAMA_NUM_CTX) || 4096));
  // Defaults match an ordinary request, so the cached prefix covers the shared persona block.
  // Hybrid speaks with the compact persona; plain Ollama mode uses the full one.
  const system = mode === "hybrid"
    ? buildLocalSystemPrompt([], "adaptive", normalizeCharacterProfile(undefined), true)
    : buildSystemPrompt([], "adaptive", undefined, 1, false);

  try {
    const started = Date.now();
    const response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: process.env.OLLAMA_KEEP_ALIVE?.trim() || "30m",
        think: ollamaThinking(),
        messages: [{ role: "system", content: system }, { role: "user", content: "." }],
        // One token is enough: the point is reading the prompt, not the reply.
        options: { num_ctx: contextLength, num_predict: 1 },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (response.ok) console.info(`FREYA warmed ${model} in ${Math.round((Date.now() - started) / 1000)}s.`);
  } catch {
    // Ollama may simply not be running yet; the first real request will load it instead.
  }
}

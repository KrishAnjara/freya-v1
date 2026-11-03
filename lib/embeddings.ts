/**
 * Optional vector embeddings for memory retrieval (lib/memory-recall), from an Ollama
 * embedding model: FREYA_EMBED_MODEL (e.g. "embeddinggemma" or "nomic-embed-text") at
 * FREYA_EMBED_URL, or by default her remote voice server (the Colab gateway lets /api/embed
 * through). Nothing is downloaded on this machine unless you point it here yourself.
 *
 * Without it, or when the server is down, retrieval is lexical only (BM25), which still works:
 * embeddings add matches by meaning ("my exam" ↔ "the biology test"), not basic recall.
 */
import { isLoopback } from "@/lib/voice-chain";
import { describeFailure, isCoolingDown, markSuccess, recordFailure } from "@/lib/provider-health";

export type EmbeddingSetup = { url: string; key?: string; model: string };

export function embeddingSetup(): EmbeddingSetup | null {
  const model = process.env.FREYA_EMBED_MODEL?.trim();
  if (!model) return null;
  const explicit = process.env.FREYA_EMBED_URL?.trim();
  const voice = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
  const url = (explicit || voice).replace(/\/+$/, "");
  // The voice server's login applies only when the embeddings come from that same server.
  const key = !explicit || explicit.replace(/\/+$/, "") === voice.replace(/\/+$/, "") ? process.env.OLLAMA_API_KEY?.trim() : process.env.FREYA_EMBED_KEY?.trim();
  return { url, model, ...(key && !isLoopback(url) ? { key } : {}) };
}

const HEALTH = "embeddings";

/** One vector per text, or null when embeddings aren't set up or didn't answer in time. */
export async function embed(texts: string[], signal?: AbortSignal, timeoutMs = 3000): Promise<number[][] | null> {
  const setup = embeddingSetup();
  if (!setup || !texts.length || isCoolingDown(HEALTH)) return null;
  try {
    const response = await fetch(`${setup.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(setup.key ? { Authorization: `Bearer ${setup.key}` } : {}) },
      body: JSON.stringify({ model: setup.model, input: texts.map((text) => text.slice(0, 2000)), keep_alive: "30m" }),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as { embeddings?: unknown } | null;
    const vectors = payload?.embeddings;
    if (!response.ok || !Array.isArray(vectors) || vectors.length !== texts.length) throw new Error(`embedding request failed (${response.status})`);
    markSuccess(HEALTH);
    return vectors.map((vector) => Array.isArray(vector) ? vector.map(Number) : []);
  } catch (error) {
    if (!signal?.aborted) {
      recordFailure(HEALTH, error);
      console.warn(`FREYA memory: embeddings unavailable (${describeFailure(error)}); using word matching only.`);
    }
    return null;
  }
}

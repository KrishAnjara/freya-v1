export type InstalledOllamaModel = { name: string; size: number };

export function getOllamaEndpoint() {
  return (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

/** Headers for every Ollama call. A voice server elsewhere has a token; Ollama itself has no login. */
export function ollamaHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** True when the model runs on this machine rather than a voice server somewhere else. */
export function ollamaIsLocal() {
  try {
    const hostname = new URL(getOllamaEndpoint()).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** The context window to ask for: small on a laptop CPU, larger on a server's GPU. */
export function ollamaContextLength() {
  const local = ollamaIsLocal();
  const fallback = local ? 4096 : 8192;
  return Math.max(1024, Math.min(local ? 8192 : 32768, Number(process.env.OLLAMA_NUM_CTX) || fallback));
}

export async function listInstalledOllamaModels(): Promise<InstalledOllamaModel[]> {
  const response = await fetch(`${getOllamaEndpoint()}/api/tags`, {
    headers: ollamaHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(ollamaIsLocal() ? 3000 : 8000),
  });
  if (!response.ok) throw new Error("Ollama is not available.");
  const payload = await response.json().catch(() => null) as { models?: unknown } | null;
  if (!Array.isArray(payload?.models)) return [];
  return payload.models.flatMap((entry): InstalledOllamaModel[] => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !/^[\w./:-]{1,160}$/.test(candidate.name)) return [];
    return [{ name: candidate.name, size: typeof candidate.size === "number" ? candidate.size : 0 }];
  }).slice(0, 64);
}

export async function resolveOllamaModel(requested?: unknown): Promise<string> {
  const models = await listInstalledOllamaModels();
  if (typeof requested === "string" && requested.trim()) {
    const selected = requested.trim();
    if (!models.some((model) => model.name === selected)) throw new Error("Choose a model installed in Ollama.");
    return selected;
  }
  const configured = process.env.OLLAMA_MODEL || "freya";
  // Ollama lists untagged models as "name:latest"; "freya" and "freya:latest" are the same model.
  const installed = (name: string) => name === configured || name === `${configured}:latest`;
  return models.some((model) => installed(model.name)) ? configured : models[0]?.name || configured;
}

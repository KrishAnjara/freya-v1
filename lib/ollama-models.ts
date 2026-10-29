export type InstalledOllamaModel = { name: string; size: number };

export function getOllamaEndpoint() {
  return (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

export async function listInstalledOllamaModels(): Promise<InstalledOllamaModel[]> {
  const response = await fetch(`${getOllamaEndpoint()}/api/tags`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
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
  return models.some((model) => model.name === configured) ? configured : models[0]?.name || configured;
}

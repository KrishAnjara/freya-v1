import type { ChatMessage } from "@/lib/llm";

export type FreyaServiceConfig = { baseUrl: string; token: string };
export type ServiceReply = { reply: string; provider: "ollama" | "groq" | "gemini"; task: string };

export class FreyaServiceError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export function getFreyaServiceConfig(): FreyaServiceConfig | null {
  const rawUrl = process.env.FREYA_SERVICE_URL?.trim();
  if (!rawUrl) return null;
  const token = process.env.FREYA_SERVICE_TOKEN || "";
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new FreyaServiceError("FREYA_SERVICE_URL is invalid."); }
  // Loopback traffic never leaves the machine, so plain HTTP to it is fine in any environment.
  // This used to require a non-production NODE_ENV, but `next start` is production, so a local
  // service was refused on every request even though the startup check had accepted it.
  const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new FreyaServiceError("FREYA_SERVICE_URL must use HTTPS unless it points at this machine.");
  }
  if (token.length < 32) throw new FreyaServiceError("FREYA_SERVICE_TOKEN must contain at least 32 characters when the service URL is configured.");
  return { baseUrl: parsed.toString().replace(/\/+$/, ""), token };
}

function requestSignal(signal?: AbortSignal, timeoutMs = 30_000) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

async function post(config: FreyaServiceConfig, path: string, body: unknown, signal?: AbortSignal, timeoutMs = 30_000) {
  try {
    return await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: requestSignal(signal, timeoutMs), cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new FreyaServiceError("FREYA orchestration service is unavailable.");
  }
}

export async function requestServiceReply(
  config: FreyaServiceConfig,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  privacyMode = false,
  ollamaModel?: string,
): Promise<ServiceReply> {
  const response = await post(config, "/v1/chat", { system, messages, privacy_mode: privacyMode, ollama_model: ollamaModel }, signal);
  if (!response.ok) throw new FreyaServiceError("FREYA orchestration service rejected the request.", response.status);
  const payload = await response.json().catch(() => null) as Partial<ServiceReply> | null;
  if (!payload || typeof payload.reply !== "string" || !["ollama", "groq", "gemini"].includes(payload.provider || "")) {
    throw new FreyaServiceError("FREYA orchestration service returned an invalid response.");
  }
  return payload as ServiceReply;
}

export type ServiceStreamEvent = { type: "provider"; provider: string; task?: string }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

export async function* streamServiceReply(
  config: FreyaServiceConfig,
  system: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
  privacyMode = false,
  ollamaModel?: string,
): AsyncGenerator<ServiceStreamEvent> {
  const response = await post(config, "/v1/chat/stream", { system, messages, privacy_mode: privacyMode, ollama_model: ollamaModel }, signal, 120_000);
  if (!response.ok || !response.body) throw new FreyaServiceError("FREYA orchestration service rejected the stream.", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      // SSE servers may frame with CRLF (many Python SSE libraries do); normalise before splitting.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const type = block.match(/^event: (.+)$/m)?.[1];
        const raw = block.match(/^data: ([\s\S]*)$/m)?.[1];
        if (type && raw) {
          try {
            const data = JSON.parse(raw);
            if (type === "provider" && typeof data.provider === "string") yield { type, provider: data.provider, task: data.task };
            else if (type === "delta" && typeof data.text === "string") yield { type, text: data.text };
            else if (type === "done") yield { type };
            else if (type === "error") yield { type, error: typeof data.error === "string" ? data.error : "Provider failed." };
          } catch { /* Ignore malformed events; the service emits structured SSE. */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

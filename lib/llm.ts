import { getOllamaEndpoint, ollamaContextLength, ollamaHeaders, ollamaIsLocal } from "@/lib/ollama-models";
import { redactSensitiveCredentials } from "@/lib/sensitive-data";
import { isCoolingDown, markFailure, markSuccess, ProviderHttpError, retryAfterOf } from "@/lib/provider-health";

/** Image or PDF bytes for providers that can see them (Gemini). Others read only the text note. */
export type InlinePart = { mime: string; data: string };
export type ChatMessage = { role: "user" | "assistant"; content: string; inline?: InlinePart[] };

/**
 * Text-only providers get role and content; an unknown field can make them reject the request.
 *
 * When image bytes are dropped here (a vision request that fell back to Groq or Ollama), the
 * turn says so outright. Told only "[Attached image: x.png]" plus a system-prompt rule, Groq
 * described an image it never received in testing.
 */
const UNSEEN_ATTACHMENT =
  "[System note: the attached image, PDF or audio could not be passed to you. You cannot see or hear it. Say so plainly in one line; do not describe, guess at, or invent its contents.]";

function plainTurns(messages: ChatMessage[]) {
  return messages.map(({ role, content, inline }) => ({ role, content: inline?.length ? `${content}\n\n${UNSEEN_ATTACHMENT}` : content }));
}

function geminiContents(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }, ...(m.inline ?? []).map((part) => ({ inlineData: { mimeType: part.mime, data: part.data } }))],
  }));
}

const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6000;
/**
 * Ceiling for turns the chat route has already validated and then extended with attached
 * text files (up to 16,000 characters per turn). The 6,000 cap applies to what users type.
 */
const MAX_PREPARED_MESSAGE_CHARS = 24_000;
const PROVIDER_TIMEOUT_MS = 25000;
const VOICE_SERVER_TIMEOUT_MS = 90_000;
/**
 * How long to wait for an Ollama model to start responding. On a voice server elsewhere the model
 * is already loaded on a GPU, so a long silence means it's gone, and the fallback should answer.
 *
 * On this machine it's different.
 *
 * Ollama sends nothing, not even headers, until it has read the whole prompt. On a laptop CPU
 * that is about 50 tokens a second, so FREYA's ~2,500-token persona takes ~50s the first time.
 * The 25s cloud timeout therefore aborted every cold local request and fell back to the cloud.
 * Once read, the prompt prefix is cached and later requests start in well under a second.
 * Loading the model as well took 128s when measured on this laptop, so the limit leaves room
 * for a busy CPU: running out of it fails the message when the local model is FREYA's voice.
 */
function ollamaTimeoutMs() {
  return Math.max(10_000, Number(process.env.OLLAMA_TIMEOUT_MS) || (ollamaIsLocal() ? 300_000 : 90_000));
}
/** A voice server that just failed is skipped for a while instead of being waited on again. */
const VOICE_SERVER_HEALTH = "voice-server";
function voiceServerDown() {
  return !ollamaIsLocal() && isCoolingDown(VOICE_SERVER_HEALTH);
}
function noteVoiceServer(error: unknown, signal?: AbortSignal) {
  if (ollamaIsLocal() || signal?.aborted) return;
  const status = error instanceof ProviderHttpError ? error.status : undefined;
  markFailure(VOICE_SERVER_HEALTH, status);
  noteFailure(VOICE_SERVER_HEALTH, status ?? "network");
}
/** Keeps the model and its prompt cache loaded between messages (Ollama's default is 5m). */
function ollamaKeepAlive() {
  return process.env.OLLAMA_KEEP_ALIVE?.trim() || "2h";
}
/**
 * Hidden "thinking" for local models that have it (Qwen3.5). Off by default: on a laptop CPU a
 * thinking pass adds minutes before the first word, and hard reasoning goes to the cloud
 * reasoning panel (lib/council) instead. Models without thinking ignore `think: false`.
 */
export function ollamaThinking() {
  return (process.env.OLLAMA_THINK || "").trim().toLowerCase() === "true";
}
/** Per-request output ceiling. Replies longer than this are continued, not cut off. */
function maxOutputTokens() {
  return Number(process.env.AI_MAX_OUTPUT_TOKENS) || 1400;
}
/** How many extra passes a single reply may use before the user is asked to continue. */
function maxContinuations() {
  return Number(process.env.AI_MAX_CONTINUATIONS) || 4;
}
/** Tail of the reply so far handed back as context when continuing. */
const CONTINUATION_CONTEXT_CHARS = 2400;

const CONTINUE_INSTRUCTION =
  "Continue your previous message from exactly where it stopped. Do not repeat, restate, "
  + "summarise, re-introduce or apologise. If it stopped mid-sentence or mid-word, resume "
  + "mid-sentence. Produce only the continuation text.";

export class ChatInputError extends Error {}

export function validateMessages(input: unknown, maxChars = MAX_MESSAGE_CHARS): ChatMessage[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ChatInputError("Send at least one message.");
  }
  if (input.length > MAX_MESSAGES) {
    throw new ChatInputError(`A conversation can contain at most ${MAX_MESSAGES} messages.`);
  }
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ChatInputError(`Message ${index + 1} is invalid.`);
    }
    const candidate = item as Record<string, unknown>;
    if (candidate.role !== "user" && candidate.role !== "assistant") {
      throw new ChatInputError(`Message ${index + 1} has an unsupported role.`);
    }
    if (typeof candidate.content !== "string" || !candidate.content.trim()) {
      throw new ChatInputError(`Message ${index + 1} must contain text.`);
    }
    if (candidate.content.length > maxChars) {
      throw new ChatInputError(`Messages cannot exceed ${maxChars} characters.`);
    }
    const inline = validInline(candidate.inline);
    return { role: candidate.role, content: redactSensitiveCredentials(candidate.content.trim()), ...(inline.length ? { inline } : {}) };
  });
}

const INLINE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/aac", "audio/ogg", "audio/flac", "audio/aiff"]);

/** Inline bytes survive validation only in the shape and size the chat route produces. */
function validInline(input: unknown): InlinePart[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 4).filter((part): part is InlinePart => {
    const candidate = part as Record<string, unknown> | null;
    return Boolean(candidate)
      && typeof candidate!.mime === "string" && INLINE_MIMES.has(candidate!.mime)
      && typeof candidate!.data === "string" && candidate!.data.length <= 4_000_000
      && /^[A-Za-z0-9+/]+=*$/.test(candidate!.data);
  }).map(({ mime, data }) => ({ mime, data }));
}

async function providerRequest(url: string, init: RequestInit, requestSignal?: AbortSignal, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

/**
 * Groq models to try, in order. Each model has its own per-minute token bucket on Groq, so
 * chaining them multiplies throughput: when the first is rate-limited, the next still has
 * capacity. On this account each allows 8,000 input tokens a minute, and one search request
 * used to spend ~6,400 of them.
 */
export function groqModels(): string[] {
  const primary = process.env.GROQ_MODEL?.trim() || "qwen/qwen3.8-27b";
  const fallbacks = (process.env.GROQ_FALLBACK_MODELS ?? "openai/gpt-oss-120b,openai/gpt-oss-20b")
    .split(",").map((model) => model.trim()).filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

/**
 * Per-model reasoning setting. Qwen accepts "none" for fast conversational replies; gpt-oss
 * rejects "none" with HTTP 400 and needs "low", so one value for every model breaks fallback.
 */
export function groqReasoningEffort(model: string) {
  return /gpt-oss/i.test(model)
    ? process.env.GROQ_GPT_OSS_REASONING_EFFORT || "low"
    : process.env.GROQ_REASONING_EFFORT || "none";
}

function groqBody(model: string, system: string, messages: ChatMessage[], stream: boolean) {
  return JSON.stringify({
    model,
    reasoning_effort: groqReasoningEffort(model),
    messages: [{ role: "system", content: system }, ...plainTurns(messages)],
    temperature: 0.85,
    max_tokens: stream ? maxOutputTokens() : 900,
    ...(stream ? { stream: true } : {}),
  });
}

/** Logs an upstream failure by status only: never message text, which can echo account ids. */
function noteFailure(provider: string, status: number | string) {
  console.warn(`FREYA provider ${provider} unavailable (${status}); trying the next option.`);
}

async function groqChat(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing. Add it to .env.local and restart the dev server.");
  let lastError: unknown = new Error("Every Groq model is cooling down after recent failures.");
  for (const model of groqModels()) {
    const health = `groq:${model}`;
    if (isCoolingDown(health)) continue;
    try {
      const { response, payload } = await providerRequest("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: groqBody(model, system, messages, false),
      }, signal);
      if (!response.ok) {
        throw new ProviderHttpError(payload?.error?.message || `Groq request failed (${response.status}).`, response.status, retryAfterOf(response));
      }
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("The model returned an empty response.");
      markSuccess(health);
      return text.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = error instanceof ProviderHttpError ? error.status : "network";
      markFailure(health, typeof status === "number" ? status : undefined, error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined);
      noteFailure(health, status);
      lastError = error;
    }
  }
  throw lastError;
}

function geminiHealthKey() {
  return `gemini:${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`;
}

/** Error thrown immediately while an upstream is in cooldown, instead of waiting on it again. */
function coolingDownError(key: string) {
  return new Error(`${key} is cooling down after a recent failure.`);
}

async function geminiChat(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  const health = geminiHealthKey();
  if (isCoolingDown(health)) throw coolingDownError(health);
  try {
    const text = await geminiChatRaw(system, messages, signal);
    markSuccess(health);
    return text;
  } catch (error) {
    if (!signal?.aborted) {
      const status = error instanceof ProviderHttpError ? error.status : "network";
      markFailure(health, typeof status === "number" ? status : undefined);
      noteFailure(health, status);
    }
    throw error;
  }
}

async function geminiChatRaw(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local and restart the dev server.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const contents = geminiContents(messages);
  const { response, payload } = await providerRequest(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 900 }
    })
  }, signal);
  if (!response.ok) {
    throw new ProviderHttpError(payload?.error?.message || `Gemini request failed (${response.status}).`, response.status, retryAfterOf(response));
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("").trim();
  if (typeof text !== "string" || !text) throw new Error("Gemini returned no text. Check the model name and API key.");
  return text;
}

async function ollamaChat(system: string, messages: ChatMessage[], signal?: AbortSignal, modelOverride?: string) {
  if (voiceServerDown()) throw coolingDownError(VOICE_SERVER_HEALTH);
  const model = modelOverride || process.env.OLLAMA_MODEL || "freya";
  try {
    const { response, payload } = await providerRequest(`${getOllamaEndpoint()}/api/chat`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: ollamaKeepAlive(),
        think: ollamaThinking(),
        messages: [{ role: "system", content: system }, ...plainTurns(messages)],
        options: { num_ctx: ollamaContextLength(), num_predict: maxOutputTokens() },
      }),
    }, signal, ollamaTimeoutMs());
    if (!response.ok) throw new ProviderHttpError(`Ollama request failed (${response.status}).`, response.status);
    const text = payload?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Ollama returned no text.");
    return text.trim();
  } catch (error) {
    noteVoiceServer(error, signal);
    throw error;
  }
}

/**
 * Any OpenAI-compatible server as FREYA's voice (AI_PROVIDER=server): a rented GPU running vLLM or
 * llama.cpp, or a hosted API. VOICE_BASE_URL includes the /v1. Quick Cloudflare tunnels don't carry
 * server-sent events, so there the reply comes in one piece (VOICE_STREAM=false does the same).
 */
function voiceRequest(system: string, messages: ChatMessage[], stream: boolean) {
  const base = process.env.VOICE_BASE_URL?.trim().replace(/\/+$/, "");
  const model = process.env.VOICE_MODEL?.trim();
  if (!base || !model) throw new Error("VOICE_BASE_URL and VOICE_MODEL are needed for AI_PROVIDER=server.");
  const key = process.env.VOICE_API_KEY?.trim();
  return {
    url: `${base}/chat/completions`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...plainTurns(messages)], temperature: 0.85, max_tokens: maxOutputTokens(), ...(stream ? { stream: true } : {}) }),
    } satisfies RequestInit,
  };
}

function voiceCanStream() {
  return process.env.VOICE_STREAM?.trim().toLowerCase() !== "false" && !/trycloudflare\.com/i.test(process.env.VOICE_BASE_URL ?? "");
}

async function voiceChat(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  if (isCoolingDown(VOICE_SERVER_HEALTH)) throw coolingDownError(VOICE_SERVER_HEALTH);
  const { url, init } = voiceRequest(system, messages, false);
  try {
    const { response, payload } = await providerRequest(url, init, signal, VOICE_SERVER_TIMEOUT_MS);
    if (!response.ok) throw new ProviderHttpError(`Voice server request failed (${response.status}).`, response.status, retryAfterOf(response));
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("The voice server returned no text.");
    markSuccess(VOICE_SERVER_HEALTH);
    return text.trim();
  } catch (error) {
    if (!signal?.aborted) { markFailure(VOICE_SERVER_HEALTH, error instanceof ProviderHttpError ? error.status : undefined); noteFailure(VOICE_SERVER_HEALTH, error instanceof ProviderHttpError ? error.status : "network"); }
    throw error;
  }
}

async function* voiceStream(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  if (!voiceCanStream()) { yield await voiceChat(system, messages, signal); return; }
  if (isCoolingDown(VOICE_SERVER_HEALTH)) throw coolingDownError(VOICE_SERVER_HEALTH);
  const { url, init } = voiceRequest(system, messages, true);
  try {
    const { response, release } = await providerStream(url, init, signal, VOICE_SERVER_TIMEOUT_MS);
    try {
      if (!response.ok || !response.body) throw new ProviderHttpError(`Voice server request failed (${response.status}).`, response.status, retryAfterOf(response));
      yield* readServerSentDeltas(
        response.body,
        (payload) => (payload as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content || "",
        (payload) => {
          const reason = (payload as { choices?: { finish_reason?: string }[] })?.choices?.[0]?.finish_reason;
          if (reason && state) state.truncated = reason === "length";
        },
      );
    } finally {
      release();
    }
    markSuccess(VOICE_SERVER_HEALTH);
  } catch (error) {
    if (!signal?.aborted) { markFailure(VOICE_SERVER_HEALTH, error instanceof ProviderHttpError ? error.status : undefined); noteFailure(VOICE_SERVER_HEALTH, error instanceof ProviderHttpError ? error.status : "network"); }
    throw error;
  }
}

/** Set by a provider stream when the model stopped because it hit the token ceiling. */
type StreamState = { truncated: boolean };

/** Reads an SSE body and yields the text deltas carried by its `data:` lines. */
async function* readServerSentDeltas(
  body: ReadableStream<Uint8Array>,
  pickDelta: (payload: unknown) => string,
  noteFinish?: (payload: unknown) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Gemini frames its SSE with CRLF. Matching only "\n\n" found no events at all, so every
      // streamed Gemini reply came back empty. A "\r" split from its "\n" across two chunks
      // waits in the buffer and is joined on the next pass.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      // SSE events are separated by a blank line; keep the trailing partial in the buffer.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const payload = JSON.parse(data);
            noteFinish?.(payload);
            const text = pickDelta(payload);
            if (text) yield text;
          } catch {
            // A malformed chunk must not abort a reply that is otherwise arriving fine.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Time to wait for a cloud stream to start. Healthy upstreams send headers in about a second;
 * waiting 25s only meant a struggling one held the reply hostage before the fallback ran.
 * Ollama passes its own, much longer, limit.
 */
const CLOUD_STREAM_START_MS = 15_000;

async function providerStream(url: string, init: RequestInit, requestSignal?: AbortSignal, timeoutMs = CLOUD_STREAM_START_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  if (requestSignal?.aborted) abortFromRequest();
  else requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  // The timeout guards connection setup only; streaming bodies outlive it by design.
  clearTimeout(timeout);
  return {
    response,
    release: () => requestSignal?.removeEventListener("abort", abortFromRequest),
  };
}

async function* groqStream(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing. Add it to .env.local and restart the dev server.");
  let lastError: unknown = new Error("Every Groq model is cooling down after recent failures.");
  for (const model of groqModels()) {
    const health = `groq:${model}`;
    if (isCoolingDown(health)) continue;
    let emitted = false;
    try {
      const { response, release } = await providerStream("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: groqBody(model, system, messages, true),
      }, signal);
      try {
        if (!response.ok || !response.body) {
          const payload = await response.json().catch(() => ({}));
          throw new ProviderHttpError(payload?.error?.message || `Groq request failed (${response.status}).`, response.status, retryAfterOf(response));
        }
        for await (const delta of readServerSentDeltas(
          response.body,
          (payload) => (payload as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]?.delta?.content || "",
          (payload) => {
            const reason = (payload as { choices?: { finish_reason?: string }[] })?.choices?.[0]?.finish_reason;
            if (reason && state) state.truncated = reason === "length";
          },
        )) {
          emitted = true;
          yield delta;
        }
      } finally {
        release();
      }
      markSuccess(health);
      return;
    } catch (error) {
      // Once text has reached the reader, switching models would splice two answers together.
      if (emitted || signal?.aborted) throw error;
      const status = error instanceof ProviderHttpError ? error.status : "network";
      markFailure(health, typeof status === "number" ? status : undefined, error instanceof ProviderHttpError ? error.retryAfterSeconds : undefined);
      noteFailure(health, status);
      lastError = error;
    }
  }
  throw lastError;
}

async function* geminiStream(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  const health = geminiHealthKey();
  if (isCoolingDown(health)) throw coolingDownError(health);
  try {
    yield* geminiStreamRaw(system, messages, signal, state);
    markSuccess(health);
  } catch (error) {
    if (!signal?.aborted) {
      const status = error instanceof ProviderHttpError ? error.status : "network";
      markFailure(health, typeof status === "number" ? status : undefined);
      noteFailure(health, status);
    }
    throw error;
  }
}

async function* geminiStreamRaw(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local and restart the dev server.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const contents = geminiContents(messages);
  const { response, release } = await providerStream(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.85, maxOutputTokens: maxOutputTokens() },
      }),
    }, signal);
  try {
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new ProviderHttpError(payload?.error?.message || `Gemini request failed (${response.status}).`, response.status, retryAfterOf(response));
    }
    yield* readServerSentDeltas(
      response.body,
      (payload) => (payload as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
        ?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "",
      (payload) => {
        const reason = (payload as { candidates?: { finishReason?: string }[] })?.candidates?.[0]?.finishReason;
        if (reason && state) state.truncated = reason === "MAX_TOKENS";
      },
    );
  } finally {
    release();
  }
}

async function* ollamaStream(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState, modelOverride?: string) {
  if (voiceServerDown()) throw coolingDownError(VOICE_SERVER_HEALTH);
  const model = modelOverride || process.env.OLLAMA_MODEL || "freya";
  let release = () => {};
  let response: Response;
  try {
    ({ response, release } = await providerStream(`${getOllamaEndpoint()}/api/chat`, {
      method: "POST",
      headers: ollamaHeaders(),
      body: JSON.stringify({
        model, stream: true,
        keep_alive: ollamaKeepAlive(),
        think: ollamaThinking(),
        messages: [{ role: "system", content: system }, ...plainTurns(messages)],
        options: { num_ctx: ollamaContextLength(), num_predict: maxOutputTokens() },
      }),
    }, signal, ollamaTimeoutMs()));
    if (!response.ok || !response.body) throw new ProviderHttpError(`Ollama request failed (${response.status}).`, response.status);
  } catch (error) {
    release();
    noteVoiceServer(error, signal);
    throw error;
  }
  try {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const item = JSON.parse(line);
            const text = item?.message?.content;
            if (typeof text === "string" && text) yield text;
            if (item?.done && state) state.truncated = item?.done_reason === "length";
          }
          newline = buffer.indexOf("\n");
        }
      }
    } finally { reader.releaseLock(); }
  } finally { release(); }
}

/**
 * Streams the reply as it is produced. Falls back to the secondary provider the same way
 * generateReply does, but only while nothing has been emitted yet — once the client has
 * partial text, switching providers mid-reply would splice two different answers together.
 */
/** What a finished stream reports back to its caller. */
export type ProviderName = "groq" | "gemini" | "ollama" | "server";
export type ProviderOptions = {
  provider?: ProviderName; fallbackEnabled?: boolean; fallbackProvider?: ProviderName; ollamaModel?: string; onProvider?: (provider: ProviderName) => void;
  /** A different prompt for the fallback, when the main one holds things only the user's own model should see. */
  fallbackSystem?: string;
};

const CLOUD_PROVIDERS = new Set<ProviderName>(["groq", "gemini"]);

/**
 * Resolves AI_PROVIDER into a concrete primary and fallback.
 *
 * "hybrid" means the local Ollama model writes the reply — in FREYA's voice, on this machine —
 * while a cloud model stands behind it as the fallback. The cloud also supplies a factual
 * brief before the local model speaks (see lib/brief), which is what lets a small local model
 * answer beyond what it knows.
 */
export function resolveProviders(options: ProviderOptions = {}): { primary: ProviderName; fallback: ProviderName } {
  const configured = (options.provider || process.env.AI_PROVIDER || "groq").toLowerCase();
  const requestedFallback = (options.fallbackProvider || process.env.AI_FALLBACK_PROVIDER || "").toLowerCase() as ProviderName;

  if (configured === "hybrid") {
    // The fallback must be a cloud model: falling back from Ollama to Ollama achieves nothing.
    const fallback = CLOUD_PROVIDERS.has(requestedFallback) ? requestedFallback : "groq";
    return { primary: "ollama", fallback };
  }
  if (configured !== "groq" && configured !== "gemini" && configured !== "ollama" && configured !== "server") {
    throw new ChatInputError(`Unsupported AI_PROVIDER "${configured}". Use groq, gemini, ollama, server, or hybrid.`);
  }
  const primary = configured as ProviderName;
  const fallback = requestedFallback && requestedFallback !== primary && ["groq", "gemini", "ollama", "server"].includes(requestedFallback)
    ? requestedFallback
    : primary === "groq" ? "gemini" : "groq";
  return { primary, fallback };
}

/** True when the configured mode puts the local model in front. */
export function isHybridMode() {
  return (process.env.AI_PROVIDER || "").trim().toLowerCase() === "hybrid";
}

/** True when the voice is an OpenAI-compatible server of the user's own (AI_PROVIDER=server). */
export function isServerMode() {
  return (process.env.AI_PROVIDER || "").trim().toLowerCase() === "server";
}
export type StreamOutcome = { truncated: boolean; parts: number; provider?: ProviderName };

/**
 * Streams a reply, continuing it across the provider's output ceiling.
 *
 * A model that stops with a "length" finish reason has not finished its answer. Rather than
 * ending the stream mid-sentence, this re-asks with the text so far and keeps yielding into
 * the same stream, so the reader sees one continuous reply. After its continuation budget it
 * gives up and reports `truncated`, letting the UI offer the choice to the reader.
 *
 * Provider fallback applies only before anything has been emitted: once the reader has partial
 * text, switching providers mid-reply would splice two different answers together.
 */
export async function* streamReply(
  system: string,
  input: unknown,
  signal?: AbortSignal,
  outcome?: StreamOutcome,
  options: ProviderOptions = {},
) {
  const messages = validateMessages(input, MAX_PREPARED_MESSAGE_CHARS);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatInputError("Send at least one user message, ending with a user message.");
  }
  const { primary: provider, fallback: fallbackName } = resolveProviders(options);
  const fallbackEnabled = options.fallbackEnabled ?? ((process.env.AI_FALLBACK_ENABLED || "true").toLowerCase() !== "false");
  const providers = {
    groq: groqStream,
    gemini: geminiStream,
    server: voiceStream,
    ollama: (prompt: string, turns: ChatMessage[], requestSignal?: AbortSignal, state?: StreamState) =>
      ollamaStream(prompt, turns, requestSignal, state, options.ollamaModel),
  };
  const primary = providers[provider];
  const secondary = providers[fallbackName];

  let emitted = 0;
  let answer = "";
  let pass = 0;
  const budget = maxContinuations();

  while (pass <= budget) {
    if (signal?.aborted) break;
    const state: StreamState = { truncated: false };
    // Later passes carry the tail of the answer plus an explicit resume instruction.
    const turn: ChatMessage[] = pass === 0 ? messages : [
      ...messages,
      { role: "assistant", content: answer.slice(-CONTINUATION_CONTEXT_CHARS) },
      { role: "user", content: CONTINUE_INSTRUCTION },
    ];

    const startedThisPass = emitted;
    try {
      if (outcome) outcome.provider = provider;
      options.onProvider?.(provider);
      for await (const delta of primary(system, turn, signal, state)) {
        emitted += delta.length;
        answer += delta;
        yield delta;
      }
      // Nothing at all, with no error: a safety filter blocked it, or a server had a bad moment.
      if (!emitted) throw new Error("The model returned an empty response.");
    } catch (primaryError) {
      if (emitted || !fallbackEnabled || signal?.aborted) throw primaryError;
      if (outcome) outcome.provider = fallbackName;
      options.onProvider?.(fallbackName);
      for await (const delta of secondary(options.fallbackSystem ?? system, turn, signal, state)) {
        emitted += delta.length;
        answer += delta;
        yield delta;
      }
    }

    if (!state.truncated) break;
    // A pass that hit the ceiling without producing anything would loop forever.
    if (emitted === startedThisPass) break;
    pass += 1;
    if (pass > budget) {
      if (outcome) outcome.truncated = true;
      break;
    }
  }

  if (outcome) outcome.parts = pass + 1;
  if (!emitted) throw new Error("The model returned an empty response.");
}

export async function generateReply(system: string, input: unknown, signal?: AbortSignal, options: ProviderOptions = {}) {
  const messages = validateMessages(input, MAX_PREPARED_MESSAGE_CHARS);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatInputError("Send at least one user message, ending with a user message.");
  }
  const { primary: provider, fallback: fallbackName } = resolveProviders(options);
  const fallbackEnabled = options.fallbackEnabled ?? ((process.env.AI_FALLBACK_ENABLED || "true").toLowerCase() !== "false");
  const providers = {
    groq: groqChat,
    gemini: geminiChat,
    server: voiceChat,
    ollama: (prompt: string, turns: ChatMessage[], requestSignal?: AbortSignal) =>
      ollamaChat(prompt, turns, requestSignal, options.ollamaModel),
  };
  const primary = providers[provider];
  const secondary = providers[fallbackName];
  const providerLabels = { groq: "Groq", gemini: "Gemini", ollama: "Ollama", server: "Voice server" };
  const primaryName = providerLabels[provider];
  const secondaryName = providerLabels[fallbackName];

  try {
    options.onProvider?.(provider);
    return await primary(system, messages, signal);
  } catch (primaryError) {
    if (!fallbackEnabled || signal?.aborted) throw primaryError;
    try {
      options.onProvider?.(fallbackName);
      return await secondary(options.fallbackSystem ?? system, messages, signal);
    } catch (fallbackError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `Both AI providers failed. ${primaryName}: ${primaryMessage} Fallback ${secondaryName}: ${fallbackMessage}`
      );
    }
  }
}

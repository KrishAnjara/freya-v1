import { ollamaContextLength, ollamaIsLocal } from "@/lib/ollama-models";
import { redactSensitiveCredentials } from "@/lib/sensitive-data";
import { coolingDownMessage, describeFailure, isCoolingDown, markSuccess, ProviderHttpError, providerErrorDetail, recordFailure, retryAfterOf } from "@/lib/provider-health";
import { geminiModel, geminiThinking } from "@/lib/gemini-config";
import { grokModel, hasGrok } from "@/lib/grok";
import { ChainConfigError, planVoiceChain, resolvePair, VOICE_SERVER_HEALTH, type ChainOptions, type OllamaTier, type ProviderName, type Tier } from "@/lib/voice-chain";

export type { ProviderName } from "@/lib/voice-chain";

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

const UNSEEN_OTHER_ATTACHMENT =
  "[System note: the attached PDF or audio could not be passed to you (the images were). Say so plainly if it matters; never guess at what it says.]";

function plainTurns(messages: ChatMessage[]) {
  return messages.map(({ role, content, inline }) => ({ role, content: inline?.length ? `${content}\n\n${UNSEEN_ATTACHMENT}` : content }));
}

/** Images Ollama can read (it decodes JPEG and PNG); the browser sends photos as JPEG. */
const OLLAMA_IMAGE_MIMES = new Set(["image/jpeg", "image/png"]);

/**
 * Turns for Ollama. A model with vision (the Colab 27B, Qwen3.5) gets the images themselves in
 * Ollama's `images` field, so FREYA looks at them herself; anything it can't take is named as
 * unseen, the same as for a text-only model.
 */
function ollamaTurns(messages: ChatMessage[], vision: boolean) {
  return messages.map(({ role, content, inline }) => {
    const images = vision ? (inline ?? []).filter((part) => OLLAMA_IMAGE_MIMES.has(part.mime)).map((part) => part.data) : [];
    const unseen = (inline?.length ?? 0) - images.length;
    const note = unseen > 0 ? `\n\n${images.length ? UNSEEN_OTHER_ATTACHMENT : UNSEEN_ATTACHMENT}` : "";
    return { role, content: `${content}${note}`, ...(images.length ? { images } : {}) };
  });
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
function ollamaTimeoutMs(local = ollamaIsLocal()) {
  return Math.max(10_000, Number(process.env.OLLAMA_TIMEOUT_MS) || (local ? 300_000 : 90_000));
}

/** One Ollama endpoint and model: the Colab server, its fallback model, or the laptop. */
export type OllamaTarget = Pick<OllamaTier, "baseUrl" | "model" | "key" | "local" | "health" | "label"> & { vision?: boolean };

/** OLLAMA_BASE_URL / OLLAMA_MODEL, as every caller used before the chain existed. */
export function defaultOllamaTarget(model?: string): OllamaTarget {
  const tier = planVoiceChain({ provider: "ollama", fallbackEnabled: false, ollamaModel: model })[0] as OllamaTier;
  return { baseUrl: tier.baseUrl, model: tier.model, key: tier.key, local: tier.local, health: tier.health, label: tier.label };
}

function ollamaHeadersFor(target: OllamaTarget): Record<string, string> {
  return { "Content-Type": "application/json", ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) };
}

/** A remote model that just failed is skipped for a while instead of being waited on again. */
function noteOllamaFailure(target: OllamaTarget, error: unknown, signal?: AbortSignal) {
  if (!target.health || signal?.aborted) return;
  recordFailure(target.health, error);
  noteFailure(target.health, error);
}

function ollamaBody(system: string, messages: ChatMessage[], target: OllamaTarget, stream: boolean, think: boolean) {
  return JSON.stringify({
    model: target.model,
    stream,
    keep_alive: ollamaKeepAlive(),
    think,
    messages: [{ role: "system", content: system }, ...ollamaTurns(messages, Boolean(target.vision))],
    options: { num_ctx: ollamaContextLength(target.local), num_predict: maxOutputTokens() },
  });
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
  const timeout = setTimeout(() => controller.abort(new DOMException(`no response in ${Math.round(timeoutMs / 1000)}s`, "TimeoutError")), timeoutMs);
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

/** Logs why an upstream failed: status and the provider's reason, with keys redacted (lib/provider-health). */
function noteFailure(provider: string, error: unknown) {
  console.warn(`FREYA provider ${provider} unavailable (${describeFailure(error)}); trying the next option.`);
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
        throw new ProviderHttpError(`Groq request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
      }
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("The model returned an empty response.");
      markSuccess(health);
      return text.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      recordFailure(health, error);
      noteFailure(health, error);
      lastError = error;
    }
  }
  throw lastError;
}

function geminiHealthKey() {
  return `gemini:${geminiModel()}`;
}

/** Error thrown immediately while an upstream is in cooldown, instead of waiting on it again. */
function coolingDownError(key: string) {
  return new Error(`${key} is ${coolingDownMessage(key)}.`);
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
      recordFailure(health, error);
      noteFailure(health, error);
    }
    throw error;
  }
}

async function geminiChatRaw(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local and restart the dev server.");
  const model = geminiModel();
  const contents = geminiContents(messages);
  const { response, payload } = await providerRequest(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 900, ...geminiThinking(model) }
    })
  }, signal);
  if (!response.ok) {
    throw new ProviderHttpError(`Gemini request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("").trim();
  if (typeof text !== "string" || !text) throw new Error("Gemini returned no text. Check the model name and API key.");
  return text;
}

async function ollamaChat(system: string, messages: ChatMessage[], signal: AbortSignal | undefined, target: OllamaTarget, think = ollamaThinking()) {
  if (target.health && isCoolingDown(target.health)) throw coolingDownError(target.health);
  try {
    const { response, payload } = await providerRequest(`${target.baseUrl}/api/chat`, {
      method: "POST",
      headers: ollamaHeadersFor(target),
      body: ollamaBody(system, messages, target, false, think),
    }, signal, ollamaTimeoutMs(target.local));
    if (!response.ok) throw new ProviderHttpError(`Ollama request failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    const text = payload?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Ollama returned no text.");
    if (target.health) markSuccess(target.health);
    return text.trim();
  } catch (error) {
    noteOllamaFailure(target, error, signal);
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
    if (!response.ok) throw new ProviderHttpError(`Voice server request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("The voice server returned no text.");
    markSuccess(VOICE_SERVER_HEALTH);
    return text.trim();
  } catch (error) {
    if (!signal?.aborted) { recordFailure(VOICE_SERVER_HEALTH, error); noteFailure(VOICE_SERVER_HEALTH, error); }
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
    if (!signal?.aborted) { recordFailure(VOICE_SERVER_HEALTH, error); noteFailure(VOICE_SERVER_HEALTH, error); }
    throw error;
  }
}

/**
 * xAI's Grok as a voice: only as a fallback tier (AI_FALLBACK_PROVIDER=grok,...), never by
 * default. Same breaker key as lib/grok's logic jobs, so a refused key sidelines both at once.
 */
const GROK_CHAT_URL = "https://api.x.ai/v1/chat/completions";
const grokHealth = () => `grok:${grokModel()}`;

function grokVoiceInit(system: string, messages: ChatMessage[], stream: boolean): RequestInit {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) throw new Error("XAI_API_KEY is not set.");
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: grokModel(),
      messages: [{ role: "system", content: system }, ...plainTurns(messages)],
      temperature: 0.85,
      max_completion_tokens: maxOutputTokens(),
      reasoning_effort: process.env.XAI_REASONING_EFFORT?.trim() || "low",
      ...(stream ? { stream: true } : {}),
    }),
  };
}

async function grokChat(system: string, messages: ChatMessage[], signal?: AbortSignal) {
  const health = grokHealth();
  if (isCoolingDown(health)) throw coolingDownError(health);
  try {
    const { response, payload } = await providerRequest(GROK_CHAT_URL, grokVoiceInit(system, messages, false), signal);
    if (!response.ok) throw new ProviderHttpError(`Grok request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Grok returned no text.");
    markSuccess(health);
    return text.trim();
  } catch (error) {
    if (!signal?.aborted) { recordFailure(health, error); noteFailure(health, error); }
    throw error;
  }
}

async function* grokStream(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  const health = grokHealth();
  if (isCoolingDown(health)) throw coolingDownError(health);
  try {
    const { response, release } = await providerStream(GROK_CHAT_URL, grokVoiceInit(system, messages, true), signal);
    try {
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new ProviderHttpError(`Grok request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
      }
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
    markSuccess(health);
  } catch (error) {
    if (!signal?.aborted) { recordFailure(health, error); noteFailure(health, error); }
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
  const timeout = setTimeout(() => controller.abort(new DOMException(`no response in ${Math.round(timeoutMs / 1000)}s`, "TimeoutError")), timeoutMs);
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
          throw new ProviderHttpError(`Groq request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
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
      recordFailure(health, error);
      noteFailure(health, error);
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
      recordFailure(health, error);
      noteFailure(health, error);
    }
    throw error;
  }
}

async function* geminiStreamRaw(system: string, messages: ChatMessage[], signal?: AbortSignal, state?: StreamState) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing. Add it to .env.local and restart the dev server.");
  const model = geminiModel();
  const contents = geminiContents(messages);
  const { response, release } = await providerStream(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.85, maxOutputTokens: maxOutputTokens(), ...geminiThinking(model) },
      }),
    }, signal);
  try {
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new ProviderHttpError(`Gemini request failed (${response.status}).`, response.status, retryAfterOf(response), providerErrorDetail(payload));
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

async function* ollamaStream(system: string, messages: ChatMessage[], signal: AbortSignal | undefined, state: StreamState | undefined, target: OllamaTarget, think = ollamaThinking()) {
  if (target.health && isCoolingDown(target.health)) throw coolingDownError(target.health);
  let release = () => {};
  let response: Response;
  try {
    ({ response, release } = await providerStream(`${target.baseUrl}/api/chat`, {
      method: "POST",
      headers: ollamaHeadersFor(target),
      body: ollamaBody(system, messages, target, true, think),
    }, signal, ollamaTimeoutMs(target.local)));
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => null);
      throw new ProviderHttpError(`Ollama request failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    }
  } catch (error) {
    release();
    noteOllamaFailure(target, error, signal);
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
            if (typeof item?.error === "string") throw new ProviderHttpError("Ollama stream failed.", 500, undefined, providerErrorDetail(item));
            const text = item?.message?.content;
            if (typeof text === "string" && text) yield text;
            if (item?.done && state) state.truncated = item?.done_reason === "length";
          }
          newline = buffer.indexOf("\n");
        }
      }
    } finally { reader.releaseLock(); }
    if (target.health) markSuccess(target.health);
  } catch (error) {
    // A stream that broke part-way (a dropped tunnel) makes the next message skip this model.
    noteOllamaFailure(target, error, signal);
    throw error;
  } finally { release(); }
}

export type ProviderOptions = ChainOptions & {
  /** Called with the label of each tier as it is tried, last call = who answered. */
  onProvider?: (provider: string) => void;
  /** Hidden thinking for this reply, in place of OLLAMA_THINK. */
  think?: boolean;
  /** A different prompt for cloud tiers, when the main one holds things only the user's own model should see. */
  fallbackSystem?: string;
  /** Her own model can see images: send them to it (the chat route checks the model's capabilities). */
  ownVision?: boolean;
  /** False keeps attachment bytes away from cloud tiers (externalFiles off): they get the note only. */
  cloudSeesFiles?: boolean;
};

/** A turn's attachment bytes removed, with the note that it couldn't be passed on. */
const withoutFiles = (turns: ChatMessage[]): ChatMessage[] =>
  turns.map(({ inline, ...turn }) => inline?.length ? { ...turn, content: `${turn.content}\n\n${UNSEEN_ATTACHMENT}` } : turn);

/**
 * Resolves AI_PROVIDER into a concrete primary and first fallback (the start of the voice chain).
 *
 * "hybrid" means the Ollama model writes the reply — in FREYA's voice, on this machine or on the
 * Colab server — while cloud models stand behind it. The cloud also supplies a factual brief
 * before her model speaks (see lib/brief), which lets a small model answer beyond what it knows.
 */
export function resolveProviders(options: ProviderOptions = {}): { primary: ProviderName; fallback: ProviderName } {
  try {
    return resolvePair(options, process.env);
  } catch (error) {
    if (error instanceof ChainConfigError) throw new ChatInputError(error.message);
    throw error;
  }
}

/** True when the configured mode puts the local model in front. */
export function isHybridMode() {
  return (process.env.AI_PROVIDER || "").trim().toLowerCase() === "hybrid";
}

/** True when the voice is an OpenAI-compatible server of the user's own (AI_PROVIDER=server). */
export function isServerMode() {
  return (process.env.AI_PROVIDER || "").trim().toLowerCase() === "server";
}
export type StreamOutcome = { truncated: boolean; parts: number; provider?: string };

type Link = {
  tier: Tier;
  stream: (system: string, turns: ChatMessage[], signal?: AbortSignal, state?: StreamState) => AsyncIterable<string>;
  chat: (system: string, turns: ChatMessage[], signal?: AbortSignal) => Promise<string>;
};

/** The voice chain for this reply (lib/voice-chain), each tier bound to its adapter. */
export function voiceLinks(options: ProviderOptions = {}): Link[] {
  let tiers: Tier[];
  try {
    tiers = planVoiceChain(options, process.env, hasGrok());
  } catch (error) {
    if (error instanceof ChainConfigError) throw new ChatInputError(error.message);
    throw error;
  }
  return tiers.map((tier): Link => {
    if (tier.kind === "ollama") {
      // Only the configured voice gets the images: the chat route checked that model can see.
      const target: OllamaTarget = { ...tier, vision: Boolean(options.ownVision) && tier.label === "ollama" };
      return {
        tier,
        stream: (system, turns, signal, state) => ollamaStream(system, turns, signal, state, target, options.think),
        chat: (system, turns, signal) => ollamaChat(system, turns, signal, target, options.think),
      };
    }
    const adapters = {
      server: { stream: voiceStream, chat: voiceChat },
      groq: { stream: groqStream, chat: groqChat },
      gemini: { stream: geminiStream, chat: geminiChat },
      grok: { stream: grokStream, chat: grokChat },
    } as const;
    const { stream, chat } = adapters[tier.kind];
    if (tier.own || options.cloudSeesFiles !== false) return { tier, stream, chat };
    return {
      tier,
      stream: (system, turns, signal, state) => stream(system, withoutFiles(turns), signal, state),
      chat: (system, turns, signal) => chat(system, withoutFiles(turns), signal),
    };
  });
}

/** Her own model gets the whole prompt; a cloud tier gets the version written for it, if any. */
const promptFor = (link: Link, system: string, options: ProviderOptions) => link.tier.own ? system : options.fallbackSystem ?? system;

/**
 * Streams a reply, continuing it across the provider's output ceiling.
 *
 * A model that stops with a "length" finish reason has not finished its answer. Rather than
 * ending the stream mid-sentence, this re-asks with the text so far and keeps yielding into
 * the same stream, so the reader sees one continuous reply. After its continuation budget it
 * gives up and reports `truncated`, letting the UI offer the choice to the reader.
 *
 * The voice chain is walked only before anything has been emitted: once the reader has partial
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
  const links = voiceLinks(options);

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
    let lastError: unknown = null;
    let answered = false;
    for (const link of links) {
      try {
        if (outcome) outcome.provider = link.tier.label;
        options.onProvider?.(link.tier.label);
        for await (const delta of link.stream(promptFor(link, system, options), turn, signal, state)) {
          emitted += delta.length;
          answer += delta;
          yield delta;
        }
        // Nothing at all, with no error: a safety filter blocked it, or a server had a bad moment.
        if (!emitted) throw new Error("The model returned an empty response.");
        answered = true;
        break;
      } catch (error) {
        if (emitted > startedThisPass || signal?.aborted) throw error;
        lastError = error;
      }
    }
    if (!answered) throw lastError ?? new Error("No AI provider is configured.");

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

const TIER_NAMES: Record<string, string> = { groq: "Groq", gemini: "Gemini", ollama: "Ollama", server: "Voice server", grok: "Grok", "server-fallback": "Voice server fallback", laptop: "Laptop Ollama" };

export async function generateReply(system: string, input: unknown, signal?: AbortSignal, options: ProviderOptions = {}) {
  const messages = validateMessages(input, MAX_PREPARED_MESSAGE_CHARS);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatInputError("Send at least one user message, ending with a user message.");
  }
  const links = voiceLinks(options);
  const failures: string[] = [];
  let firstError: unknown = null;
  for (const link of links) {
    try {
      options.onProvider?.(link.tier.label);
      return await link.chat(promptFor(link, system, options), messages, signal);
    } catch (error) {
      if (signal?.aborted || links.length === 1) throw error;
      firstError ??= error;
      failures.push(`${TIER_NAMES[link.tier.label] ?? link.tier.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!failures.length) throw firstError;
  throw new Error(`${links.length === 2 ? "Both" : "All"} AI providers failed. ${failures.join(" ")}`);
}

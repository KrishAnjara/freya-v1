/**
 * Seeing what they sent: images, screenshots, charts, documents and voice notes.
 *
 * Two ways, used together:
 *   1. FREYA's own model looks at the images itself when it can. Ollama says so: a model with
 *      a vision projector lists "vision" in /api/show (the Colab Qwen3.8 27B and Qwen3.5 do; a
 *      text-only fine-tune does not). Checked per model, cached, never assumed.
 *   2. A describer writes notes first, for the voice to answer from: in FREYA_VISION_ORDER
 *      (default grok, own, gemini). "own" is a vision model on her own server
 *      (FREYA_VISION_MODEL). Grok and Gemini only when external file processing is allowed
 *      (externalFiles in freya.config.json, and never in Local-only mode).
 *
 * Grok and the own vision model read images; Gemini also reads PDFs and audio. A describer that
 * can read everything attached is tried before one that can read only part of it, and partial
 * notes say what couldn't be opened. Nothing is guessed: on total failure the voice is told it
 * can't see the attachment and says so.
 */
import { generateReply, type ChatMessage, type InlinePart, type OllamaTarget } from "@/lib/llm";
import { grokModel, hasGrok } from "@/lib/grok";
import { coolingDownMessage, describeFailure, isCoolingDown, markSuccess, ProviderHttpError, providerErrorDetail, recordFailure } from "@/lib/provider-health";

export const DESCRIBER_PROMPT = `You are a vision assistant preparing notes for another model that will write the reply and cannot see or hear attachments.
Describe exactly what the user's latest attachments contain: for an image, the subject, setting, people (appearance, expression, clothing; never identify real people by name), text visible in it (transcribe it), charts and diagrams (what they show, axes, key numbers), colours and mood; for several images, number them and say how they relate; for a document, its type and the key content relevant to their message; for audio, what is said and how it sounds (tone, background noise, silence).
Focus on what matters for their message. Be concrete and factual, 60-220 words, no persona, no greeting, no advice. If something is unclear, say so.`;

export type Describer = "grok" | "own" | "gemini";
type Kind = "image" | "pdf" | "audio";
const READS: Record<Describer, Kind[]> = { grok: ["image"], own: ["image"], gemini: ["image", "pdf", "audio"] };

const kindOf = (part: InlinePart): Kind => part.mime.startsWith("image/") ? "image" : part.mime === "application/pdf" ? "pdf" : "audio";

// --- capability detection ---------------------------------------------------------------

const CAPABILITY_TTL_MS = 10 * 60_000;
const CAPABILITY_MISS_TTL_MS = 60_000;
const capabilities = new Map<string, { until: number; list: string[] }>();

/** What an Ollama model can do ("completion", "vision", "thinking", "tools", ...). Empty when unknown. */
export async function modelCapabilities(target: Pick<OllamaTarget, "baseUrl" | "model" | "key">, signal?: AbortSignal): Promise<string[]> {
  const cacheKey = `${target.baseUrl}|${target.model}`;
  const cached = capabilities.get(cacheKey);
  if (cached && cached.until > Date.now()) return cached.list;
  let list: string[] = [];
  try {
    const response = await fetch(`${target.baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}) },
      body: JSON.stringify({ model: target.model }),
      signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null) as { capabilities?: unknown } | null;
    if (response.ok && Array.isArray(payload?.capabilities)) list = payload.capabilities.filter((item): item is string => typeof item === "string");
  } catch {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  }
  capabilities.set(cacheKey, { until: Date.now() + (list.length ? CAPABILITY_TTL_MS : CAPABILITY_MISS_TTL_MS), list });
  return list;
}

/** Whether this model looks at images itself. FREYA_OWN_VISION=true|false overrides the check. */
export async function canSeeImages(target: Pick<OllamaTarget, "baseUrl" | "model" | "key">, signal?: AbortSignal) {
  const forced = process.env.FREYA_OWN_VISION?.trim().toLowerCase();
  if (forced === "true") return true;
  if (forced === "false") return false;
  return (await modelCapabilities(target, signal)).includes("vision");
}

export function resetVisionForTests() {
  capabilities.clear();
}

// --- describers --------------------------------------------------------------------------

/** The attachments on the latest user turns, and the words they came with. */
function latestAttachments(messages: ChatMessage[]) {
  const parts: InlinePart[] = [];
  const words: string[] = [];
  for (let index = messages.length - 1; index >= 0 && messages[index].role === "user"; index -= 1) {
    parts.unshift(...(messages[index].inline ?? []));
    words.unshift(messages[index].content);
  }
  return { parts, question: words.join("\n").slice(0, 2000) };
}

async function grokDescribe(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) throw new Error("XAI_API_KEY is not set.");
  const model = process.env.XAI_VISION_MODEL?.trim() || grokModel();
  const health = `grok-vision:${model}`;
  if (isCoolingDown(health)) throw new Error(coolingDownMessage(health));
  const { parts, question } = latestAttachments(messages);
  const images = parts.filter((part) => kindOf(part) === "image");
  try {
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: DESCRIBER_PROMPT },
          { role: "user", content: [
            { type: "text", text: `Their message: ${question}` },
            ...images.map((part) => ({ type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}`, detail: "high" } })),
          ] },
        ],
        max_completion_tokens: 900,
        temperature: 0.2,
      }),
      signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderHttpError(`Grok vision failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Grok returned no description.");
    markSuccess(health);
    return text.trim();
  } catch (error) {
    if (!signal.aborted) recordFailure(health, error);
    throw error;
  }
}

/** A vision model on her own server (FREYA_VISION_MODEL), e.g. when her voice model is text-only. */
async function ownDescribe(messages: ChatMessage[], signal: AbortSignal, server: OllamaTarget | null): Promise<string> {
  const model = process.env.FREYA_VISION_MODEL?.trim();
  if (!model || !server) throw new Error("No vision model on her own server (FREYA_VISION_MODEL).");
  const health = `vision-model:${model}`;
  if (isCoolingDown(health)) throw new Error(coolingDownMessage(health));
  const { parts, question } = latestAttachments(messages);
  const images = parts.filter((part) => part.mime === "image/jpeg" || part.mime === "image/png").map((part) => part.data);
  try {
    const response = await fetch(`${server.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(server.key ? { Authorization: `Bearer ${server.key}` } : {}) },
      body: JSON.stringify({
        model, stream: false, think: false, keep_alive: "10m",
        messages: [{ role: "system", content: DESCRIBER_PROMPT }, { role: "user", content: `Their message: ${question}`, images }],
        options: { num_predict: 700, temperature: 0.2 },
      }),
      signal,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new ProviderHttpError(`Vision model failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    const text = payload?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("The vision model returned no description.");
    markSuccess(health);
    return text.trim();
  } catch (error) {
    if (!signal.aborted) recordFailure(health, error);
    throw error;
  }
}

async function geminiDescribe(messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error("GEMINI_API_KEY is not set.");
  return generateReply(DESCRIBER_PROMPT, messages.slice(-6), signal, { provider: "gemini", fallbackEnabled: false });
}

export type Description = { text: string; describer: Describer; partial: boolean };

export function visionOrder(): Describer[] {
  const names = (process.env.FREYA_VISION_ORDER || "grok,own,gemini").toLowerCase().split(",").map((name) => name.trim());
  return [...new Set(names.filter((name): name is Describer => name === "grok" || name === "own" || name === "gemini"))];
}

const MAX_DESCRIPTION_CHARS = 1800;
/** A cold vision model on a T4 may first have to swap in, so the own server gets longer. */
const DESCRIBE_TIMEOUT_MS: Record<Describer, number> = { grok: 25_000, own: 60_000, gemini: 20_000 };

/**
 * Notes on what they attached, from the first describer that can read it, or null.
 * `allowExternal: false` keeps Grok and Gemini out entirely.
 */
export async function describeAttachments(
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  { allowExternal, server, ownSees = false }: { allowExternal: boolean; server: OllamaTarget | null; ownSees?: boolean },
): Promise<Description | null> {
  const { parts } = latestAttachments(messages);
  if (!parts.length) return null;
  const needs = new Set(parts.map(kindOf));
  // When her own model sees the images itself, a separate vision model adds nothing, and Gemini
  // is only needed for what she can't open (PDFs, audio). Grok's reading still helps (text in
  // screenshots, charts), so it stays when it's allowed.
  const imagesOnly = [...needs].every((kind) => kind === "image");
  const available = visionOrder().filter((name) => {
    if (ownSees && (name === "own" || (name === "gemini" && imagesOnly))) return false;
    if (name === "own") return Boolean(process.env.FREYA_VISION_MODEL?.trim() && server);
    return allowExternal && (name === "grok" ? hasGrok() : Boolean(process.env.GEMINI_API_KEY?.trim()));
  });
  const full = available.filter((name) => [...needs].every((kind) => READS[name].includes(kind)));
  const partial = available.filter((name) => !full.includes(name) && READS[name].some((kind) => needs.has(kind)));

  for (const name of [...full, ...partial]) {
    if (signal?.aborted) return null;
    const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS[name]);
    const scoped = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const text = name === "grok" ? await grokDescribe(messages, scoped)
        : name === "own" ? await ownDescribe(messages, scoped, server)
          : await geminiDescribe(messages, scoped);
      const clean = text.trim().slice(0, MAX_DESCRIPTION_CHARS);
      if (clean.length <= 20) continue;
      const isPartial = !full.includes(name);
      const missing = [...needs].filter((kind) => !READS[name].includes(kind));
      return { text: isPartial ? `${clean}\n(Only the images could be read; the attached ${missing.join(" and ")} could not be opened.)` : clean, describer: name, partial: isPartial };
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn(`FREYA vision: ${name} couldn't describe the attachment (${describeFailure(error)}); trying the next option.`);
    }
  }
  return null;
}

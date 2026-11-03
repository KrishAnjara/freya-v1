/**
 * Pictures in the chat, from the first of these that can make one:
 *   1. her own image server: the Colab gateway's /v1/images (SDXL + SDXL-Lightning, see
 *      training/serve_remote.py), at FREYA_IMAGE_URL or, by default, the same address as her
 *      remote voice model. Text-to-image, edits of the last picture (image-to-image), variations.
 *   2. Gemini's image models (generateContent with IMAGE in responseModalities). On a free-tier
 *      key they often have no quota (429); that is reported as the reason, never hidden.
 *   3. an SVG drawing by a text model, labelled as such by the browser.
 * Server-only (keys). Nothing is stored here.
 */
import { generateJson } from "@/lib/structured";
import { mentionsMinors } from "@/lib/intimacy";
import { sanitizeSvg } from "@/lib/svg-safety";
import { coolingDownMessage, describeFailure, isCoolingDown, markSuccess, ProviderHttpError, providerErrorDetail, recordFailure } from "@/lib/provider-health";
import { isLoopback } from "@/lib/voice-chain";

export { sanitizeSvg };

export type ImageResult =
  | { kind: "generated"; mime: string; data: string; model: string; seed?: number }
  | { kind: "svg"; svg: string; reason: "quota" | "unavailable" | "not-configured" | "blocked" };

export const IMAGE_STYLES = {
  photo: { label: "Photo", prompt: "natural light photograph, 35mm, realistic detail, shallow depth of field", negative: "illustration, cartoon, painting, text, watermark" },
  cinematic: { label: "Cinematic", prompt: "cinematic film still, dramatic lighting, anamorphic, colour graded", negative: "cartoon, text, watermark" },
  illustration: { label: "Illustration", prompt: "detailed digital illustration, clean lines, rich colour", negative: "photo, text, watermark" },
  anime: { label: "Anime", prompt: "anime style, cel shading, expressive, studio quality", negative: "photo, realistic, text, watermark" },
  watercolor: { label: "Watercolour", prompt: "watercolour painting, soft washes, paper texture, loose brushwork", negative: "photo, 3d, text, watermark" },
  oil: { label: "Oil painting", prompt: "oil painting on canvas, visible brushstrokes, classical lighting", negative: "photo, flat, text, watermark" },
  render: { label: "3D render", prompt: "3D render, soft global illumination, physically based materials", negative: "flat, sketch, text, watermark" },
  pixel: { label: "Pixel art", prompt: "pixel art, limited palette, crisp pixels, retro game", negative: "blurry, photo, smooth gradients, text" },
  sketch: { label: "Sketch", prompt: "pencil sketch, graphite shading, hand-drawn on paper", negative: "colour, photo, text, watermark" },
} as const;
export type ImageStyle = keyof typeof IMAGE_STYLES;
export const isImageStyle = (value: unknown): value is ImageStyle => typeof value === "string" && value in IMAGE_STYLES;

export type ImageRequest = {
  prompt: string;
  previous?: { prompt: string; mime?: string; data?: string };
  style?: ImageStyle;
  /** Another take on the previous picture: same idea, new seed, close to the original. */
  variation?: boolean;
};

const SEXUAL = /\b(nude|naked|nsfw|porn\w*|sex\w*|explicit|lingerie|topless|genitals?|erotic)\b/i;

/** Requests no provider is asked to draw. */
export function imageRequestBlocked(prompt: string) {
  return SEXUAL.test(prompt) && mentionsMinors(prompt);
}

export function imageModel() {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
}

type Failure = { failed: "quota" | "unavailable" | "not-configured" | "blocked" };

/** The words sent to a model: the idea, a change to the last one, and the style. */
function promptText(request: ImageRequest) {
  const base = request.variation && request.previous ? request.previous.prompt
    : request.previous ? `${request.previous.prompt}. Change: ${request.prompt}` : request.prompt;
  return request.style ? `${base}, ${IMAGE_STYLES[request.style].prompt}` : base;
}

/** Where her own image server is: FREYA_IMAGE_URL, or the Colab gateway that serves her voice. */
export function imageServer(): { url: string; key?: string } | null {
  if ((process.env.FREYA_IMAGE_GENERATION || "true").toLowerCase() === "false") return null;
  const explicit = process.env.FREYA_IMAGE_URL?.trim();
  const voice = process.env.OLLAMA_BASE_URL?.trim();
  const url = explicit || (voice && !isLoopback(voice) ? voice : "");
  if (!url) return null;
  const key = process.env.FREYA_IMAGE_KEY?.trim() || process.env.OLLAMA_API_KEY?.trim();
  return { url: url.replace(/\/+$/, ""), ...(key ? { key } : {}) };
}

const IMAGE_SERVER_HEALTH = "image-server";

async function ownImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult | Failure> {
  const server = imageServer();
  if (!server) return { failed: "not-configured" };
  if (isCoolingDown(IMAGE_SERVER_HEALTH)) {
    console.warn(`FREYA image server skipped (${coolingDownMessage(IMAGE_SERVER_HEALTH)}).`);
    return { failed: "unavailable" };
  }
  const edit = request.previous?.data && request.previous.mime;
  try {
    const response = await fetch(`${server.url}/v1/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(server.key ? { Authorization: `Bearer ${server.key}` } : {}) },
      body: JSON.stringify({
        prompt: promptText(request),
        negative_prompt: request.style ? IMAGE_STYLES[request.style].negative : "text, watermark, deformed, blurry",
        // How far from the last picture: a variation stays close, a restyle needs room to change.
        ...(edit ? { image: request.previous!.data, strength: request.variation ? (request.style ? 0.7 : 0.45) : 0.65 } : {}),
      }),
      // The first picture of a session loads the model (and may unload her text model) on a T4.
      signal: AbortSignal.any([AbortSignal.timeout(150_000), ...(signal ? [signal] : [])]),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 404) {
      // A gateway without the image server: stop asking it for a while, quietly.
      recordFailure(IMAGE_SERVER_HEALTH, new ProviderHttpError("no image server", 404, 600));
      return { failed: "not-configured" };
    }
    if (!response.ok) throw new ProviderHttpError(`Image server failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    if (typeof payload?.image !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(payload.image)) throw new Error("The image server returned no image.");
    markSuccess(IMAGE_SERVER_HEALTH);
    const mime = typeof payload.mime === "string" && /^image\/(png|jpeg|webp)$/.test(payload.mime) ? payload.mime : "image/png";
    return { kind: "generated", mime, data: payload.image, model: typeof payload.model === "string" ? payload.model : "own image server", ...(Number.isFinite(payload.seed) ? { seed: payload.seed } : {}) };
  } catch (error) {
    if (signal?.aborted) throw error;
    recordFailure(IMAGE_SERVER_HEALTH, error);
    console.warn(`FREYA image server unavailable (${describeFailure(error)}); trying Gemini.`);
    return { failed: "unavailable" };
  }
}

async function geminiImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult | Failure> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || (process.env.FREYA_IMAGE_GENERATION || "true").toLowerCase() === "false") return { failed: "not-configured" };
  const parts: Record<string, unknown>[] = [];
  if (request.previous?.data && request.previous.mime) {
    // Refining a real picture: the model edits it rather than starting over.
    parts.push({ inlineData: { mimeType: request.previous.mime, data: request.previous.data } });
    const style = request.style ? ` in this style: ${IMAGE_STYLES[request.style].prompt}` : "";
    parts.push({ text: request.variation ? `Make a variation of this image: same subject and composition, different details${style}.` : `Edit this image: ${request.prompt}${style}` });
  } else {
    parts.push({ text: promptText(request) });
  }
  const model = imageModel();
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
      signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
    });
    if (response.status === 429) return { failed: "quota" };
    if (!response.ok) {
      console.warn(`FREYA Gemini image failed (${describeFailure(new ProviderHttpError("", response.status, undefined, providerErrorDetail(await response.json().catch(() => null))))}).`);
      return { failed: "unavailable" };
    }
    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const image = (candidate?.content?.parts ?? []).find((part: { inlineData?: { mimeType?: string; data?: string } }) => part.inlineData?.data);
    if (!image) return { failed: candidate?.finishReason && candidate.finishReason !== "STOP" ? "blocked" : "unavailable" };
    return { kind: "generated", mime: image.inlineData.mimeType || "image/png", data: image.inlineData.data, model };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { failed: "unavailable" };
  }
}

const SVG_PROMPT = `You draw illustrations as SVG code. Return JSON {"svg":"<svg ...>...</svg>"}.
- One standalone SVG: viewBox="0 0 512 512", xmlns="http://www.w3.org/2000/svg". Shapes, paths, gradients and text only. No <script>, <image>, <foreignObject>, event attributes or external links.
- Make it a real, recognisable illustration of the request, not an icon: a coloured background with some depth, the subject large and centred with correct proportions, details that identify it, highlights and shadows (gradients help). Typically 30-80 elements, under 16,000 characters.
- If the request is sexual or explicit, return {"svg":""}.`;

async function svgDrawing(request: ImageRequest, signal?: AbortSignal) {
  const description = promptText(request);
  // A drawing occasionally comes back malformed or cut off, which a second attempt usually fixes.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await generateJson(SVG_PROMPT, `Draw: ${description}`, {
        groqModel: process.env.FREYA_SVG_MODEL?.trim() || "openai/gpt-oss-120b",
        maxTokens: 8000,
        temperature: 0.5,
        signal,
        timeoutMs: 60_000,
      });
      const svg = sanitizeSvg((result.data as { svg?: unknown } | null)?.svg);
      if (svg) return svg;
    } catch (error) {
      if (signal?.aborted || attempt === 1) throw error;
    }
  }
  return null;
}

export async function makeImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult | null> {
  const own = await ownImage(request, signal);
  if ("kind" in own) return own;
  const generated = await geminiImage(request, signal);
  if ("kind" in generated) return generated;
  // A refusal by the image model is not something to route around with a drawing.
  if (generated.failed === "blocked") return null;
  const svg = await svgDrawing(request, signal);
  // The reason shown is Gemini's, unless her own server was the one set up and it failed.
  const reason = own.failed === "unavailable" && generated.failed === "not-configured" ? "unavailable" : generated.failed;
  return svg ? { kind: "svg", svg, reason } : null;
}

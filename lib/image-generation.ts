/**
 * Pictures in the chat, from the first of these that can make one:
 *   1. her own image server: the Colab gateway's /v1/images (training/serve_puter.py: Qwen-Image
 *      draws, SDXL puts her face right; or training/serve_remote.py: RealVisXL + IP-Adapter Face), at
 *      FREYA_IMAGE_URL or, by default, the same address as her remote voice model. A picture of her
 *      carries her expression (asked for, or her mood's: lib/freya-face) and her portrait photo. A
 *      prompt maker there writes the full prompt first. Pictures run as jobs, polled.
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
import { faceExpression, faceReference } from "@/lib/freya-face";
import type { MoodName } from "@/lib/mood";

export { sanitizeSvg };

export type ImageResult =
  | { kind: "generated"; mime: string; data: string; model: string; seed?: number; refined?: string }
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
  /** Her mood when asked, for the face a picture of her shows (lib/freya-face). */
  mood?: MoodName;
};

const SEXUAL = /\b(nude|naked|nsfw|porn\w*|sex\w*|explicit|lingerie|topless|genitals?|erotic)\b/i;

/**
 * What every picture avoids: the usual photo faults, and the ones that give a generated picture of
 * her away (a second copy of her face, extra people nobody asked for, a plastic look).
 */
export const NEGATIVE_PROMPT = "duplicate face, two faces, cloned face, multiple heads, extra people, twins, deformed face, asymmetric eyes, cross-eyed, "
  + "extra limbs, extra fingers, missing fingers, fused fingers, bad hands, bad anatomy, distorted body, "
  + "blurry, out of focus, low quality, jpeg artifacts, oversaturated, plastic skin, airbrushed, doll, cartoon, illustration, 3d render, cgi, "
  + "text, caption, watermark, logo, signature, frame, border";

/** Requests no provider is asked to draw. */
export function imageRequestBlocked(prompt: string) {
  return SEXUAL.test(prompt) && mentionsMinors(prompt);
}

export function imageModel() {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
}

type Failure = { failed: "quota" | "unavailable" | "not-configured" | "blocked" };

/**
 * For an edit model, the change itself: what to do to the picture it's given. A variation and a
 * restyle are edits too ("same picture, other details" / "same picture, this style").
 */
function editInstruction(request: ImageRequest) {
  const style = request.style ? ` in this style: ${IMAGE_STYLES[request.style].prompt}` : "";
  if (request.variation) return request.style ? `Redraw this picture${style}, keeping the subject and composition.` : "Make a variation of this picture: the same subject and composition, with different details.";
  return `${request.prompt}${style}`;
}

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
  // Every picture is a photo from her phone; whether she's in it, and whether her face shows, is the
  // server's prompt maker's call. So her real photo for how she feels right now (the expression asked
  // for, or her mood's) always goes along, and is used wherever her face is in the shot.
  const expression = !edit ? faceExpression(request.prompt, request.mood) : null;
  const reference = expression ? await faceReference(expression) : null;
  const headers = { "Content-Type": "application/json", ...(server.key ? { Authorization: `Bearer ${server.key}` } : {}) };
  try {
    const response = await fetch(`${server.url}/v1/images`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: promptText(request),
        ...(reference && expression ? { reference, expression } : {}),
        negative_prompt: request.style ? `${IMAGE_STYLES[request.style].negative}, ${NEGATIVE_PROMPT}` : NEGATIVE_PROMPT,
        // How far from the last picture: a variation stays close, a restyle needs room to change.
        ...(edit ? { image: request.previous!.data, instruction: editInstruction(request), strength: request.variation ? (request.style ? 0.7 : 0.45) : 0.65 } : {}),
      }),
      signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]),
      cache: "no-store",
    });
    let payload = await response.json().catch(() => null);
    // Refused on the server (the hard limit, checked there again on the refined prompt): not
    // something to route around with another model.
    if (response.status === 400) return { failed: "blocked" };
    if (response.status === 404) {
      // A gateway without the image server: stop asking it for a while, quietly.
      recordFailure(IMAGE_SERVER_HEALTH, new ProviderHttpError("no image server", 404, 600));
      return { failed: "not-configured" };
    }
    if (!response.ok) throw new ProviderHttpError(`Image server failed (${response.status}).`, response.status, undefined, providerErrorDetail(payload));
    // A picture is a background job (it takes minutes; a quick tunnel cuts requests at ~100 s).
    if (response.status === 202 && typeof payload?.job === "string") payload = await waitForPicture(server, headers, payload.job, signal);
    if (typeof payload?.image !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(payload.image)) throw new Error("The image server returned no image.");
    markSuccess(IMAGE_SERVER_HEALTH);
    const mime = typeof payload.mime === "string" && /^image\/(png|jpeg|webp)$/.test(payload.mime) ? payload.mime : "image/png";
    return {
      kind: "generated", mime, data: payload.image, model: typeof payload.model === "string" ? payload.model : "own image server",
      ...(Number.isFinite(payload.seed) ? { seed: payload.seed } : {}),
      ...(typeof payload.refined === "string" && payload.refined.trim() ? { refined: payload.refined.trim().slice(0, 1500) } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    // The hard limit, checked again on what the prompt maker wrote: final, never routed elsewhere.
    if (error instanceof PictureRefused) return { failed: "blocked" };
    recordFailure(IMAGE_SERVER_HEALTH, error);
    console.warn(`FREYA image server unavailable (${describeFailure(error)}); trying Gemini.`);
    return { failed: "unavailable" };
  }
}

const POLL_MS = 4000;
const PICTURE_LIMIT_MS = 20 * 60_000;

class PictureRefused extends Error {}

/** Asks the image server how a picture is going until it's done or failed. */
async function waitForPicture(server: { url: string }, headers: Record<string, string>, job: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{16}$/.test(job)) throw new Error("The image server returned an unreadable job.");
  const deadline = Date.now() + PICTURE_LIMIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const response = await fetch(`${server.url}/v1/images/${job}`, { headers, cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) }).catch(() => null);
    if (!response) continue; // a dropped poll; the job carries on
    if (response.status === 404) throw new Error("The image server lost the picture (it may have restarted).");
    const status = await response.json().catch(() => null);
    if (status?.status === "done") return status;
    if (status?.status === "error") {
      const reason = String(status.error || "");
      if (/not something I'll draw/i.test(reason)) throw new PictureRefused();
      throw new Error(`The picture failed: ${reason.slice(0, 200)}`);
    }
  }
  throw new Error("The picture took longer than 20 minutes.");
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
  if (own.failed === "blocked") return null;
  const generated = await geminiImage(request, signal);
  if ("kind" in generated) return generated;
  // A refusal by the image model is not something to route around with a drawing.
  if (generated.failed === "blocked") return null;
  const svg = await svgDrawing(request, signal);
  // The reason shown is Gemini's, unless her own server was the one set up and it failed.
  const reason = own.failed === "unavailable" && generated.failed === "not-configured" ? "unavailable" : generated.failed;
  return svg ? { kind: "svg", svg, reason } : null;
}

/**
 * Pictures in the chat: a real generated image when an image model is available, otherwise
 * an SVG drawing made by a text model, clearly labelled as such by the browser.
 *
 * Gemini's image models answer through generateContent with IMAGE in responseModalities. On a
 * free-tier key they often have no quota (429); that is reported as the reason for falling
 * back, never hidden. Server-only (keys).
 */
import { generateJson } from "@/lib/structured";
import { mentionsMinors } from "@/lib/intimacy";
import { sanitizeSvg } from "@/lib/svg-safety";

export { sanitizeSvg };

export type ImageResult =
  | { kind: "generated"; mime: string; data: string; model: string }
  | { kind: "svg"; svg: string; reason: "quota" | "unavailable" | "not-configured" | "blocked" };

export type ImageRequest = { prompt: string; previous?: { prompt: string; mime?: string; data?: string } };

const SEXUAL = /\b(nude|naked|nsfw|porn\w*|sex\w*|explicit|lingerie|topless|genitals?|erotic)\b/i;

/** Requests no provider is asked to draw. */
export function imageRequestBlocked(prompt: string) {
  return SEXUAL.test(prompt) && mentionsMinors(prompt);
}

export function imageModel() {
  return process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
}

async function geminiImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult | { failed: "quota" | "unavailable" | "not-configured" | "blocked" }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || (process.env.FREYA_IMAGE_GENERATION || "true").toLowerCase() === "false") return { failed: "not-configured" };
  const parts: Record<string, unknown>[] = [];
  if (request.previous?.data && request.previous.mime) {
    // Refining a real picture: the model edits it rather than starting over.
    parts.push({ inlineData: { mimeType: request.previous.mime, data: request.previous.data } });
    parts.push({ text: `Edit this image: ${request.prompt}` });
  } else {
    parts.push({ text: request.previous ? `${request.previous.prompt}. Change: ${request.prompt}` : request.prompt });
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
    if (!response.ok) return { failed: "unavailable" };
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
  const description = request.previous ? `${request.previous.prompt}. Now change it: ${request.prompt}` : request.prompt;
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
  const generated = await geminiImage(request, signal);
  if ("kind" in generated) return generated;
  // A refusal by the image model is not something to route around with a drawing.
  if (generated.failed === "blocked") return null;
  const svg = await svgDrawing(request, signal);
  return svg ? { kind: "svg", svg, reason: generated.failed } : null;
}

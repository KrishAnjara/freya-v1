import { NextResponse } from "next/server";
import { guardRequest, hostedProvidersAllowed } from "@/lib/route-guard";
import { imageRequestBlocked, isImageStyle, makeImage, pictureStatus, startPicture } from "@/lib/image-generation";
import { describeFailure } from "@/lib/provider-health";
import { isMoodName } from "@/lib/mood";

/**
 * Pictures in the chat (/image, or asking FREYA to draw something). Returns a generated image
 * or a labelled SVG drawing; never claims one is the other. Nothing is stored server-side.
 *
 * With `async: true`, a picture on her own image server comes back at once as `{ pending: job }`,
 * and GET /api/image?job=<job> says how it's going until it returns the picture: the browser keeps
 * the job, so a picture that takes many minutes, or outlasts a refresh, still lands in the chat.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A previous generated image sent back for an edit: ~4 MB of base64. */
const MAX_BODY = 5_500_000;

export async function POST(request: Request) {
  const stop = await guardRequest(request, MAX_BODY, "Pictures are unavailable right now.");
  if (stop) return stop;
  if (!hostedProvidersAllowed()) return NextResponse.json({ error: "Pictures need a cloud model, which is off in Local-only mode." }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const prompt = typeof body.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  if (prompt.length < 2) return NextResponse.json({ error: "Say what to draw, e.g. /image a lighthouse at night." }, { status: 400 });
  const raw = body.previous as Record<string, unknown> | undefined;
  const previous = raw && typeof raw.prompt === "string"
    ? {
      prompt: raw.prompt.slice(0, 600),
      ...(typeof raw.data === "string" && /^[A-Za-z0-9+/]+=*$/.test(raw.data) && typeof raw.mime === "string" && /^image\/(png|jpeg|webp)$/.test(raw.mime) ? { data: raw.data, mime: raw.mime } : {}),
    }
    : undefined;
  if (imageRequestBlocked(`${previous?.prompt ?? ""} ${prompt}`)) return NextResponse.json({ error: "That's not something I'll draw." }, { status: 400 });
  const style = isImageStyle(body.style) ? body.style : undefined;
  // A variation needs something to vary.
  const variation = body.variation === true && Boolean(previous);
  // Her mood, for the face a picture of her shows (lib/freya-face).
  const mood = isMoodName(body.mood) ? body.mood : undefined;

  try {
    if (body.async === true) {
      const started = await startPicture({ prompt, previous, style, variation, mood }, request.signal);
      if ("job" in started) return NextResponse.json({ pending: started.job, ...(started.eta ? { eta: started.eta } : {}) }, { headers: { "Cache-Control": "no-store" } });
      if (started.failed === "blocked") return NextResponse.json({ error: "That's not something I'll draw." }, { status: 400 });
      const result = await makeImage({ prompt, previous, style, variation, mood }, request.signal, started);
      if (!result) return NextResponse.json({ error: "That picture couldn't be made. Try describing it differently." }, { status: 422 });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    const result = await makeImage({ prompt, previous, style, variation, mood }, request.signal);
    if (!result) return NextResponse.json({ error: "That picture couldn't be made. Try describing it differently." }, { status: 422 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    console.warn(`FREYA image failed (${describeFailure(error)}).`);
    return NextResponse.json({ error: "Pictures aren't working right now. Try again in a moment." }, { status: 503 });
  }
}

/** How a picture started with `async: true` is going (see above). */
export async function GET(request: Request) {
  // Checked every few seconds, so not counted against the chat's rate limit; the sign-in and
  // owner checks (middleware.ts) still apply.
  const job = new URL(request.url).searchParams.get("job") ?? "";
  if (!/^[a-f0-9]{16}$/.test(job)) return NextResponse.json({ error: "No such picture." }, { status: 400 });
  const status = await pictureStatus(job, request.signal);
  if ("kind" in status) return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  if (status.status === "error") return NextResponse.json({ error: status.refused ? "That's not something I'll draw." : status.error, failed: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

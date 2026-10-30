import { NextResponse } from "next/server";
import { guardRequest, hostedProvidersAllowed } from "@/lib/route-guard";
import { imageRequestBlocked, makeImage } from "@/lib/image-generation";

/**
 * Pictures in the chat (/image, or asking FREYA to draw something). Returns a generated image
 * or a labelled SVG drawing; never claims one is the other. Nothing is stored server-side.
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

  try {
    const result = await makeImage({ prompt, previous }, request.signal);
    if (!result) return NextResponse.json({ error: "That picture couldn't be made. Try describing it differently." }, { status: 422 });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    console.warn(`FREYA image failed (${error instanceof Error ? error.message.slice(0, 40) : "error"}).`);
    return NextResponse.json({ error: "Pictures aren't working right now. Try again in a moment." }, { status: 503 });
  }
}

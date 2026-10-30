import { NextResponse } from "next/server";
import { guardRequest, hostedProvidersAllowed } from "@/lib/route-guard";
import { generateJson } from "@/lib/structured";
import { REFINE_PROMPT, validateSpec, VISUALIZE_PROMPT } from "@/lib/visualize";

/**
 * Turns a description into a validated spec of solids for the canvas to scatter particles over.
 * /visualize always starts from nothing; only a refinement (mode "refine") sees a form, the one
 * whose Refine button was used.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const stop = await guardRequest(request, 60_000, "Visualisation is unavailable right now.");
  if (stop) return stop;
  if (!hostedProvidersAllowed()) return NextResponse.json({ error: "Visualisation needs a cloud model, which is off in Local-only mode." }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const description = typeof body.description === "string" ? body.description.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  if (description.length < 2) return NextResponse.json({ error: "Describe what to visualise, e.g. /visualize a red fox." }, { status: 400 });
  const refining = body.mode === "refine";
  const current = refining ? validateSpec(body.current) : null;
  if (refining && !current) return NextResponse.json({ error: "There's nothing to refine yet. Make something with /visualize first." }, { status: 400 });
  // The portrait relief is drawn from an image, so there are no parts to change.
  if (current?.technique === "portrait") return NextResponse.json({ error: "That one's made from her portrait, so it can't be reshaped. Use /visualize for a new form." }, { status: 422 });

  const input = current
    ? `CURRENT FORM (${current.title}):\n${JSON.stringify({ parts: current.parts })}\n\nCHANGE: ${description}`
    : `REQUEST: ${description}`;
  try {
    const result = await generateJson(refining ? REFINE_PROMPT : VISUALIZE_PROMPT, input, {
      groqModel: process.env.FREYA_VISUALIZE_MODEL?.trim() || "openai/gpt-oss-120b",
      maxTokens: 6000,
      temperature: 0.3,
      signal: request.signal,
      timeoutMs: 60_000,
      reasoningEffort: "medium",
    });
    const spec = validateSpec(result.data);
    if (!spec) return NextResponse.json({ error: "That one didn't come out as a shape. Try describing it differently." }, { status: 502 });
    return NextResponse.json({ spec, provider: result.provider }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    console.warn(`FREYA visualize failed (${error instanceof Error ? error.message.slice(0, 40) : "error"}).`);
    return NextResponse.json({ error: "The visualisation couldn't be made right now. Try again in a moment." }, { status: 503 });
  }
}

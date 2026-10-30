import { NextResponse } from "next/server";
import { guardRequest, hostedProvidersAllowed } from "@/lib/route-guard";
import { generateJson } from "@/lib/structured";
import { containsSensitiveCredential, redactSensitiveCredentials } from "@/lib/sensitive-data";
import { MAX_REFLECTION_TURNS, REFLECTION_PROMPT, reflectionInput, validateChanges, type KnownMemory, type ReflectionTurn } from "@/lib/memory-reflection";

/**
 * Automatic memory: reads a stretch of conversation and proposes changes to the user's notes.
 *
 * It only proposes. The browser applies the result to wherever the notes live (this browser,
 * or the signed-in account) and tells the user what was saved. Nothing is stored here. The
 * browser never calls this in Local-only mode, and a Local-only deployment refuses it, since it
 * sends conversation text to a hosted model.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readTurns(value: unknown): ReflectionTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_REFLECTION_TURNS).flatMap((item) => {
    const turn = item as Record<string, unknown> | null;
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.content !== "string") return [];
    const content = redactSensitiveCredentials(turn.content).slice(0, 4000);
    return content.trim() ? [{ role: turn.role, content }] : [];
  });
}

function readMemories(value: unknown): KnownMemory[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((item) => {
    const memory = item as Record<string, unknown> | null;
    if (!memory || typeof memory.id !== "string" || typeof memory.text !== "string") return [];
    return [{ id: memory.id.slice(0, 64), text: memory.text.replace(/\s+/g, " ").slice(0, 240) }];
  });
}

export async function POST(request: Request) {
  const stop = await guardRequest(request, 120_000, "Automatic memory is unavailable right now.");
  if (stop) return stop;
  if (!hostedProvidersAllowed()) return NextResponse.json({ error: "Automatic memory is off in Local-only mode." }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const turns = readTurns(body.turns);
  if (!turns.some((turn) => turn.role === "user")) return NextResponse.json({ add: [], update: [], remove: [] });
  const memories = readMemories(body.memories);
  const forgotten = (Array.isArray(body.forgotten) ? body.forgotten : [])
    .filter((text): text is string => typeof text === "string").slice(0, 60).map((text) => text.slice(0, 240));
  const today = typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}/.test(body.today) ? body.today.slice(0, 10) : new Date().toISOString().slice(0, 10);

  try {
    const result = await generateJson(REFLECTION_PROMPT, reflectionInput(turns, memories, forgotten, today), {
      groqModel: process.env.FREYA_MEMORY_MODEL?.trim() || "openai/gpt-oss-120b",
      maxTokens: 1500,
      temperature: 0.1,
      signal: request.signal,
    });
    const changes = validateChanges(result.data, memories, forgotten, containsSensitiveCredential);
    return NextResponse.json({ ...changes, provider: result.provider }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    console.warn(`FREYA memory reflection failed (${error instanceof Error ? error.message.slice(0, 40) : "error"}).`);
    return NextResponse.json({ error: "Automatic memory couldn't run this time." }, { status: 503 });
  }
}

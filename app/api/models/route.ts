import { NextResponse } from "next/server";
import { listInstalledOllamaModels, resolveOllamaModel } from "@/lib/ollama-models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const models = await listInstalledOllamaModels();
    const defaultModel = await resolveOllamaModel();
    return NextResponse.json({ models, defaultModel }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Ollama is unavailable on the configured endpoint." }, { status: 503 });
  }
}

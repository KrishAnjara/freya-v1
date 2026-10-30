import { NextResponse } from "next/server";
import { isServerMode } from "@/lib/llm";
import { listInstalledOllamaModels, ollamaIsLocal, resolveOllamaModel } from "@/lib/ollama-models";
import { configuredReasoningMode } from "@/lib/reasoning-signal";
import { warmOllama } from "@/lib/warm-ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The server-owned AI setup, for display only: which local model Local-only mode uses and the
 * reasoning setting. Requests cannot change either; they come from the server's environment.
 * Ollama being down is a normal state on a cloud-only setup, so this always answers 200.
 */
export async function GET() {
  const reasoning = configuredReasoningMode();
  // Where private turns go, so the Settings wording stays true.
  const voiceOnThisMachine = ollamaIsLocal() && !isServerMode();
  // Opening the app loads the local voice (when it is the voice), so the first message doesn't
  // wait minutes for a cold start. warmOllama does nothing in cloud modes.
  void warmOllama();
  try {
    const models = await listInstalledOllamaModels();
    const defaultModel = await resolveOllamaModel();
    return NextResponse.json({ models, defaultModel, ollama: "ready", reasoning, voiceOnThisMachine }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ models: [], defaultModel: null, ollama: "unavailable", reasoning, voiceOnThisMachine }, { headers: { "Cache-Control": "no-store" } });
  }
}

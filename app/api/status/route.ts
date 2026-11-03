import { NextResponse } from "next/server";
import { planVoiceChain, type Tier } from "@/lib/voice-chain";
import { healthOf } from "@/lib/provider-health";
import { grokModel, hasGrok } from "@/lib/grok";
import { groqModels } from "@/lib/llm";
import { geminiModel } from "@/lib/gemini-config";
import { modelCapabilities, visionOrder } from "@/lib/vision";
import { imageServer } from "@/lib/image-generation";
import { embeddingSetup } from "@/lib/embeddings";
import { getMemoryStore } from "@/lib/memory-store";
import { loadConfig } from "@/lib/freya-config";
import { isSelfHosted } from "@/lib/rate-limit";

/**
 * What's answering right now, for Settings → Models and status: the voice chain in order, each
 * tier reachable or not (and why not), what her own models can do, and the memory store.
 * No keys, tokens or provider text beyond the redacted reason. Her own servers are probed with a
 * cheap listing call (cached 15 s); cloud tiers report only whether they're being skipped, so
 * opening the panel never spends quota.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TierStatus = { label: string; kind: Tier["kind"]; own: boolean; model?: string; where?: string; state: "ready" | "down" | "cooling" | "unknown"; detail?: string; vision?: boolean };

const PROBE_CACHE_MS = 15_000;
const probes = new Map<string, { at: number; ok: boolean; detail?: string }>();

async function probe(tier: Extract<Tier, { kind: "ollama" }>) {
  const cacheKey = `${tier.baseUrl}|${tier.model}`;
  const cached = probes.get(cacheKey);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached;
  let result: { at: number; ok: boolean; detail?: string };
  try {
    const response = await fetch(`${tier.baseUrl}/api/tags`, { headers: tier.key ? { Authorization: `Bearer ${tier.key}` } : {}, signal: AbortSignal.timeout(3000), cache: "no-store" });
    const payload = await response.json().catch(() => null) as { models?: { name?: string }[] } | null;
    const names = (payload?.models ?? []).map((model) => model.name ?? "");
    const has = names.some((name) => name === tier.model || name === `${tier.model}:latest`);
    result = { at: Date.now(), ok: response.ok && has, detail: !response.ok ? `HTTP ${response.status}` : has ? undefined : `model "${tier.model}" isn't on that server` };
  } catch (error) {
    result = { at: Date.now(), ok: false, detail: error instanceof Error && error.name === "TimeoutError" ? "no answer in 3 s" : "not reachable" };
  }
  probes.set(cacheKey, result);
  return result;
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };

async function tierStatus(tier: Tier): Promise<TierStatus> {
  if (tier.kind === "ollama") {
    const cooling = tier.health ? healthOf(tier.health) : null;
    const reached = await probe(tier);
    const vision = reached.ok ? (await modelCapabilities(tier)).includes("vision") : undefined;
    return {
      label: tier.label, kind: tier.kind, own: true, model: tier.model, where: tier.local ? "this computer" : hostOf(tier.baseUrl),
      state: cooling ? "cooling" : reached.ok ? "ready" : "down",
      ...(cooling?.reason || reached.detail ? { detail: cooling?.reason ?? reached.detail } : {}),
      ...(vision !== undefined ? { vision } : {}),
    };
  }
  const keys = tier.kind === "grok" ? [`grok:${grokModel()}`] : tier.kind === "gemini" ? [`gemini:${geminiModel()}`] : tier.kind === "groq" ? groqModels().map((model) => `groq:${model}`) : ["voice-server"];
  const cooling = keys.map((key) => healthOf(key)).filter(Boolean);
  const configured = tier.kind === "grok" ? hasGrok() : tier.kind === "gemini" ? Boolean(process.env.GEMINI_API_KEY?.trim()) : tier.kind === "groq" ? Boolean(process.env.GROQ_API_KEY?.trim()) : Boolean(process.env.VOICE_BASE_URL?.trim());
  const model = tier.kind === "grok" ? grokModel() : tier.kind === "gemini" ? geminiModel() : tier.kind === "groq" ? groqModels()[0] : process.env.VOICE_MODEL;
  return {
    label: tier.label, kind: tier.kind, own: tier.own, model,
    state: !configured ? "down" : cooling.length === keys.length ? "cooling" : "unknown",
    ...(!configured ? { detail: "no API key" } : cooling[0]?.reason ? { detail: cooling[0].reason } : {}),
  };
}

export async function GET() {
  // Hostnames and model names are for the owner, not for every visitor of a public deployment.
  if (!isSelfHosted() && process.env.NODE_ENV === "production") return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  const config = loadConfig();
  const chain = planVoiceChain({ cloud: config.cloudFallback !== false });
  const tiers = await Promise.all(chain.map(tierStatus));
  const images = imageServer();
  const embeddings = embeddingSetup();
  const store = getMemoryStore();
  return NextResponse.json({
    available: true,
    chain: tiers,
    vision: { order: visionOrder(), externalFiles: config.externalFiles !== false, ownVisionModel: process.env.FREYA_VISION_MODEL?.trim() || null },
    images: { ownServer: images ? hostOf(images.url) : null, cooling: healthOf("image-server"), gemini: Boolean(process.env.GEMINI_API_KEY?.trim()) },
    memory: { store: store?.kind ?? null, embeddings: embeddings ? embeddings.model : null, embeddingsCooling: healthOf("embeddings") },
    switches: { cloudFallback: config.cloudFallback !== false, externalFiles: config.externalFiles !== false },
  }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";
import { groqModels, groqReasoningEffort, ollamaThinking } from "@/lib/llm";
import { getFreyaServiceConfig, requestServiceReply } from "@/lib/freya-service";
import { isSelfHosted } from "@/lib/rate-limit";

/**
 * Detailed health: can each model, API and service actually respond right now?
 *
 * Every check sends one tiny real request and passes only if a proper answer comes back, so
 * "working" means usable, not merely reachable. Results say only working / not working /
 * not configured: no keys, error text, account ids or model output ever leave the server.
 *
 * Probes spend provider quota, so results are cached for a minute, and outside local
 * development or self-hosting the route needs `Authorization: Bearer $FREYA_HEALTH_TOKEN`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type CheckStatus = "working" | "not working" | "not configured";
type Check = () => Promise<CheckStatus>;

const CACHE_MS = 60_000;
/** A forced refresh still waits this long, so the route cannot be used to burn quota. */
const MIN_REFRESH_MS = 15_000;
const PROBE_TIMEOUT_MS = 20_000;
/** A cold local model reads its prompt before answering; give it longer. */
const OLLAMA_TIMEOUT_MS = 90_000;
const PROMPT = "Reply with the single word: ready";

let cached: { at: number; body: HealthReport } | null = null;
let running: Promise<HealthReport> | null = null;

type HealthReport = {
  overall: "working" | "degraded" | "not working";
  checkedAt: string;
  services: Record<string, CheckStatus>;
};

function allowed(request: Request) {
  if (process.env.NODE_ENV !== "production" || isSelfHosted()) return true;
  const token = process.env.FREYA_HEALTH_TOKEN || "";
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  return token.length >= 24 && supplied === token;
}

/** Runs a probe; any throw or timeout is simply "not working". */
async function settle(check: Check): Promise<CheckStatus> {
  try {
    return await check();
  } catch {
    return "not working";
  }
}

const said = (text: unknown) => typeof text === "string" && text.trim().length > 0;

function groqCheck(model: string): Check {
  return async () => {
    const key = process.env.GROQ_API_KEY;
    if (!key) return "not configured";
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, reasoning_effort: groqReasoningEffort(model), max_tokens: 200,
        messages: [{ role: "user", content: PROMPT }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
    });
    const payload = await response.json().catch(() => null);
    return response.ok && said(payload?.choices?.[0]?.message?.content) ? "working" : "not working";
  };
}

const geminiCheck: Check = async () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "not configured";
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 400 } }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  const text = payload?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("");
  return response.ok && said(text) ? "working" : "not working";
};

const ollamaCheck: Check = async () => {
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "freya";
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE?.trim() || "30m", think: ollamaThinking(),
      messages: [{ role: "user", content: PROMPT }], options: { num_predict: 16 },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS), cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  return response.ok && said(payload?.message?.content) ? "working" : "not working";
};

const tavilyCheck: Check = async () => {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return "not configured";
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Same auth as lib/search, so a pass here means search itself will work.
    body: JSON.stringify({ api_key: key, query: "today's date", max_results: 1, search_depth: "basic" }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  return response.ok && Array.isArray(payload?.results) ? "working" : "not working";
};

/** Half a second of silent 16 kHz WAV: enough for Whisper to accept and return a result. */
function silentWav() {
  const samples = 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + samples * 2, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

const whisperCheck: Check = async () => {
  const key = process.env.GROQ_API_KEY;
  if (!key) return "not configured";
  const form = new FormData();
  form.append("file", new Blob([silentWav()], { type: "audio/wav" }), "probe.wav");
  form.append("model", process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3");
  form.append("response_format", "json");
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  // Silence transcribes to little or nothing; a well-formed result is the pass condition.
  return response.ok && typeof payload?.text === "string" ? "working" : "not working";
};

const orchestrationCheck: Check = async () => {
  const config = getFreyaServiceConfig();
  if (!config) return "not configured";
  const reply = await requestServiceReply(config, "Answer briefly.", [{ role: "user", content: PROMPT }], AbortSignal.timeout(OLLAMA_TIMEOUT_MS));
  return said(reply.reply) ? "working" : "not working";
};

const supabaseCheck: Check = async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return "not configured";
  const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/health`, {
    headers: { apikey: key }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
  });
  return response.ok ? "working" : "not working";
};

const rateLimiterCheck: Check = async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return "not configured";
  const response = await fetch(`${url.replace(/\/+$/, "")}/ping`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  return response.ok && payload?.result === "PONG" ? "working" : "not working";
};

async function runChecks(): Promise<HealthReport> {
  const checks: [string, Check][] = [
    ...groqModels().map((model): [string, Check] => [`cloud: groq ${model}`, groqCheck(model)]),
    [`cloud: gemini ${process.env.GEMINI_MODEL || "gemini-2.5-flash"}`, geminiCheck],
    [`local: ollama ${process.env.OLLAMA_MODEL || "freya"}`, ollamaCheck],
    ["api: tavily search", tavilyCheck],
    ["api: groq whisper (voice transcription)", whisperCheck],
    ["service: orchestration", orchestrationCheck],
    ["service: supabase", supabaseCheck],
    ["service: rate limiter (upstash)", rateLimiterCheck],
  ];
  const results = await Promise.all(checks.map(async ([name, check]) => [name, await settle(check)] as const));
  const services = Object.fromEntries(results);
  const configured = results.filter(([, status]) => status !== "not configured");
  const working = configured.filter(([, status]) => status === "working").length;
  const overall = working === configured.length ? "working" : working === 0 ? "not working" : "degraded";
  return { overall, checkedAt: new Date().toISOString(), services };
}

export async function GET(request: Request) {
  if (!allowed(request)) return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && (age < (fresh ? MIN_REFRESH_MS : CACHE_MS))) {
    return NextResponse.json({ ...cached.body, cached: true }, { headers: { "Cache-Control": "no-store" } });
  }
  // Concurrent requests share one round of probes.
  running ??= runChecks().finally(() => { running = null; });
  const body = await running;
  cached = { at: Date.now(), body };
  return NextResponse.json({ ...body, cached: false }, { status: body.overall === "not working" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}

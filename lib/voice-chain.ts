/**
 * Who answers, in order: FREYA's voice chain.
 *
 *   1. her model on the Colab server (OLLAMA_BASE_URL, or an OpenAI-compatible VOICE_BASE_URL)
 *   2. a smaller model on the same server (FREYA_FALLBACK_MODEL), for when the big one fails
 *      inside a live session: out of memory on a long prompt, a crash, a timeout
 *   3. the laptop's own Ollama (LOCAL_OLLAMA_URL), only when it is set: nothing is downloaded
 *   4. cloud models, in AI_FALLBACK_PROVIDER order (e.g. "grok,gemini,groq")
 *
 * Pure: it reads the environment it's given and returns a plan; lib/llm turns the plan into
 * calls. The rules that keep turns private live here, so they are tested in one place:
 *   - `cloud: false` (intimate turns, or cloudFallback off) keeps every cloud tier out;
 *   - `privacy: true` (Local-only) keeps only models on this machine;
 *   - `fallbackEnabled: false` means the first tier only.
 */

export type ProviderName = "groq" | "gemini" | "ollama" | "server" | "grok";

export type OllamaTier = {
  kind: "ollama";
  /** What the reply's label says: "ollama" (relabelled "server" when remote), "server-fallback", "laptop". */
  label: "ollama" | "server-fallback" | "laptop";
  baseUrl: string;
  model: string;
  key?: string;
  local: boolean;
  own: true;
  /** Circuit-breaker key; empty for the primary model on this machine, which is never skipped. */
  health: string;
};
export type OtherTier = { kind: "server" | "groq" | "gemini" | "grok"; label: ProviderName; own: boolean; local: false; health: string };
export type Tier = OllamaTier | OtherTier;

export type ChainOptions = {
  provider?: ProviderName;
  fallbackProvider?: ProviderName;
  fallbackEnabled?: boolean;
  /** False keeps every cloud tier out (intimate turns, or `cloudFallback: false`). */
  cloud?: boolean;
  /** Local-only mode: models on this machine only. */
  privacy?: boolean;
  ollamaModel?: string;
};

type Env = Record<string, string | undefined>;

const CLOUD = new Set<ProviderName>(["groq", "gemini", "grok"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class ChainConfigError extends Error {}

export function isLoopback(url: string) {
  try { return LOOPBACK.has(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** The voice server that failed is skipped for a while; this key is shared with older code. */
export const VOICE_SERVER_HEALTH = "voice-server";

/** "grok, gemini ,groq" → ["grok","gemini","groq"]; unknown names are dropped, order kept, no repeats. */
export function parseFallbacks(value: string | undefined, allowed: Set<string>): ProviderName[] {
  const names = (value ?? "").toLowerCase().split(",").map((name) => name.trim()).filter((name) => allowed.has(name));
  return [...new Set(names)] as ProviderName[];
}

/** Cloud adapters keep their own breaker keys (per Groq model, per Gemini model, Grok's). */
function cloudTier(name: ProviderName): OtherTier {
  return { kind: name as OtherTier["kind"], label: name, own: false, local: false, health: "" };
}

function primaryOllama(env: Env, model?: string): OllamaTier {
  const baseUrl = trimUrl(env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  const local = isLoopback(baseUrl);
  return {
    kind: "ollama", label: "ollama", baseUrl, model: model || env.OLLAMA_MODEL || "freya",
    ...(env.OLLAMA_API_KEY?.trim() ? { key: env.OLLAMA_API_KEY.trim() } : {}),
    local, own: true, health: local ? "" : VOICE_SERVER_HEALTH,
  };
}

/**
 * The extra own-model tiers behind a remote primary: the server's smaller model, then the laptop.
 * The laptop's Ollama is in the chain when LOCAL_OLLAMA_URL is set, or when "ollama" is listed in
 * AI_FALLBACK_PROVIDER ("ollama,groq,gemini": this machine's model before any cloud one).
 */
function ownFallbacks(env: Env, primary: Tier, options: ChainOptions = {}): OllamaTier[] {
  const tiers: OllamaTier[] = [];
  const fallbackModel = env.FREYA_FALLBACK_MODEL?.trim();
  if (primary.kind === "ollama" && !primary.local && fallbackModel && fallbackModel !== primary.model) {
    tiers.push({ ...primary, label: "server-fallback", model: fallbackModel, health: `${VOICE_SERVER_HEALTH}:${fallbackModel}` });
  }
  const listed = parseFallbacks(options.fallbackProvider || env.AI_FALLBACK_PROVIDER, new Set(["ollama"])).length > 0;
  const laptopUrl = env.LOCAL_OLLAMA_URL?.trim() || (listed ? "http://127.0.0.1:11434" : "");
  if (laptopUrl && isLoopback(laptopUrl) && !(primary.kind === "ollama" && primary.local)) {
    tiers.push({ kind: "ollama", label: "laptop", baseUrl: trimUrl(laptopUrl), model: env.LOCAL_OLLAMA_MODEL?.trim() || "freya", local: true, own: true, health: "laptop-ollama" });
  }
  return tiers;
}

/** The plain primary + fallback pair, as before the chain existed (kept for callers and tests). */
export function resolvePair(options: ChainOptions, env: Env): { primary: ProviderName; fallback: ProviderName } {
  const configured = (options.provider || env.AI_PROVIDER || "groq").toLowerCase();
  const requested = parseFallbacks(options.fallbackProvider || env.AI_FALLBACK_PROVIDER, new Set(["groq", "gemini", "grok", "ollama", "server"]));
  if (configured === "hybrid") {
    // The fallback must be a cloud model: falling back from Ollama to Ollama achieves nothing.
    const fallback = requested.find((name) => CLOUD.has(name)) ?? "groq";
    return { primary: "ollama", fallback };
  }
  if (!["groq", "gemini", "ollama", "server", "grok"].includes(configured)) {
    throw new ChainConfigError(`Unsupported AI_PROVIDER "${configured}". Use groq, gemini, ollama, server, or hybrid.`);
  }
  const primary = configured as ProviderName;
  const fallback = requested.find((name) => name !== primary) ?? (primary === "groq" ? "gemini" : "groq");
  return { primary, fallback };
}

/**
 * The ordered tiers for one reply. Always at least one; the first is the configured voice
 * (or, in Local-only mode with a remote voice, the laptop if it is set up).
 */
export function planVoiceChain(options: ChainOptions = {}, env: Env = process.env, hasGrok = Boolean(env.XAI_API_KEY?.trim())): Tier[] {
  const { primary: primaryName } = resolvePair(options, env);
  const configured = (options.provider || env.AI_PROVIDER || "groq").toLowerCase();
  const primary: Tier = primaryName === "ollama" ? primaryOllama(env, options.ollamaModel)
    : primaryName === "server" ? { kind: "server", label: "server", own: true, local: false, health: VOICE_SERVER_HEALTH }
      : cloudTier(primaryName);

  if (options.privacy) {
    // Only this machine. A remote voice is replaced by the laptop's model when there is one.
    if (primary.local) return [primary];
    const laptop = ownFallbacks(env, primary, options).find((tier) => tier.label === "laptop");
    return laptop ? [laptop] : [primary];
  }

  const fallbackEnabled = options.fallbackEnabled ?? (env.AI_FALLBACK_ENABLED || "true").toLowerCase() !== "false";
  if (!fallbackEnabled) return [primary];

  const tiers: Tier[] = [primary, ...(primary.own ? ownFallbacks(env, primary, options) : [])];
  if (options.cloud === false) return tiers;

  const requested = parseFallbacks(options.fallbackProvider || env.AI_FALLBACK_PROVIDER, new Set(["groq", "gemini", "grok", "ollama", "server"]));
  let rest: ProviderName[];
  if (configured === "hybrid") {
    rest = requested.filter((name) => CLOUD.has(name));
    if (!rest.length) rest = ["groq"];
  } else {
    rest = requested.filter((name) => name !== primaryName);
    if (!rest.length) rest = [primaryName === "groq" ? "gemini" : "groq"];
  }
  let added = 0;
  for (const name of rest) {
    if (name === "grok" && !hasGrok) continue;
    if (name === "ollama") tiers.push(primaryOllama(env, options.ollamaModel));
    else if (name === "server") tiers.push({ kind: "server", label: "server", own: true, local: false, health: VOICE_SERVER_HEALTH });
    else tiers.push(cloudTier(name));
    added += 1;
  }
  // A configured fallback that can't run (only grok, with no key) still leaves the old default.
  if (!added) tiers.push(cloudTier(primaryName === "groq" ? "gemini" : "groq"));
  return tiers;
}

/** True when Local-only mode has a model on this machine to use. */
export function localVoiceAvailable(env: Env = process.env) {
  return planVoiceChain({ provider: "ollama", privacy: true }, env).every((tier) => tier.local);
}

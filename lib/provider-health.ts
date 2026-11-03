/**
 * A small circuit breaker for upstream model and service endpoints.
 *
 * Without it, a rate-limited or overloaded upstream was retried on every request: Groq's
 * per-minute token limit returned 429 for the rest of the minute, and the Gemini fallback,
 * during its high-demand periods, hung for the full timeout each time. Remembering a recent
 * failure for a short cooldown means a request skips straight to something that can answer.
 *
 * Process-local by design: one server process, one view of upstream health.
 */

const cooldowns = new Map<string, number>();
/** Why each upstream last failed, so "cooling down" can say what it is cooling down from. */
const reasons = new Map<string, string>();

/** Cooldown after an upstream rejects for load (429) when it gives no Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 20_000;
/** Cooldown after a timeout, network error, or 5xx. */
const OUTAGE_COOLDOWN_MS = 45_000;
/** Upper bound, so a bogus Retry-After cannot sideline a provider for an hour. */
const MAX_COOLDOWN_MS = 120_000;
/** A rejected key won't start working by itself: stop knocking for a while (a restart clears it). */
const AUTH_COOLDOWN_MS = 10 * 60_000;

export function isCoolingDown(key: string, now = Date.now()) {
  const until = cooldowns.get(key);
  if (!until) return false;
  if (now >= until) {
    cooldowns.delete(key);
    return false;
  }
  return true;
}

/** Records a failure. `status` 429 uses `retryAfterSeconds` when the upstream supplied one. */
export function markFailure(key: string, status?: number, retryAfterSeconds?: number, now = Date.now()) {
  if (status === 401 || status === 403) { cooldowns.set(key, now + AUTH_COOLDOWN_MS); return; }
  const fromHeader = retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
  const base = status === 429 ? (fromHeader || RATE_LIMIT_COOLDOWN_MS) : OUTAGE_COOLDOWN_MS;
  cooldowns.set(key, now + Math.min(MAX_COOLDOWN_MS, Math.max(1000, base)));
}

/**
 * Records any failure: the cooldown (a rejected key counts as 401 whatever status it came with;
 * xAI answers a bad key with 400) and the reason, for logs and later "cooling down" messages.
 */
export function recordFailure(key: string, error: unknown, now = Date.now()) {
  reasons.set(key, describeFailure(error));
  if (error instanceof ProviderHttpError) markFailure(key, error.auth ? 401 : error.status, error.retryAfterSeconds, now);
  else markFailure(key, undefined, undefined, now);
}

/** "cooling down for 42s after: HTTP 503: …", for an upstream that is being skipped. */
export function coolingDownMessage(key: string, now = Date.now()) {
  const until = cooldowns.get(key) ?? now;
  const seconds = Math.max(1, Math.round((until - now) / 1000));
  const left = seconds >= 120 ? `${Math.round(seconds / 60)}m` : `${seconds}s`;
  const reason = reasons.get(key);
  return `cooling down for ${left}${reason ? ` after: ${reason}` : ""}`;
}

/** For the status panel: how long a key is still skipped, and why. Null when it's fine. */
export function healthOf(key: string, now = Date.now()): { coolingForSeconds: number; reason?: string } | null {
  if (!isCoolingDown(key, now)) return null;
  const until = cooldowns.get(key) ?? now;
  return { coolingForSeconds: Math.max(1, Math.round((until - now) / 1000)), ...(reasons.get(key) ? { reason: reasons.get(key) } : {}) };
}

export function markSuccess(key: string) {
  cooldowns.delete(key);
  reasons.delete(key);
}

/** For deterministic tests. */
export function resetProviderHealthForTests() {
  cooldowns.clear();
  reasons.clear();
}

/** Messages that mean the key itself was refused, whatever HTTP status carried them. */
const AUTH_TEXT = /api[ _-]?key|unauthori[sz]ed|unauthenticated|permission[ _-]denied|invalid[ _-](x-api-)?key|authentication/i;

/** An upstream HTTP failure, carrying what the breaker needs and a redacted reason for logs. */
export class ProviderHttpError extends Error {
  /** The provider's own explanation, redacted and shortened: safe for server logs, never sent to the browser. */
  readonly detail: string;
  /** The key was missing, wrong or not allowed: retrying won't help until it's changed. */
  readonly auth: boolean;
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    detail = "",
  ) {
    super(message);
    this.detail = detail;
    this.auth = status === 401 || status === 403 || AUTH_TEXT.test(detail);
  }
}

/** Removes anything that looks like a credential from provider text, and keeps it to one short line. */
export function redact(text: string, limit = 240) {
  return text
    .replace(/\b(AIza[\w-]{10,}|xai-[\w-]{10,}|gsk_[\w-]{10,}|sk-[\w-]{10,}|tvly-[\w-]{10,})/g, "[key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [key]")
    .replace(/([?&](key|api_key|token)=)[^&\s"]+/gi, "$1[key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * The provider's reason from an error body. Covers OpenAI-style `{error: {message}}` (Groq),
 * xAI's `{code, error: "text"}`, Google's `{error: {message, status}}` and its array form.
 */
export function providerErrorDetail(payload: unknown): string {
  const body = Array.isArray(payload) ? payload[0] : payload;
  if (!body || typeof body !== "object") return typeof body === "string" ? redact(body) : "";
  const record = body as Record<string, unknown>;
  const error = record.error;
  let message = "";
  let code = "";
  if (typeof error === "string") message = error;
  else if (error && typeof error === "object") {
    const inner = error as Record<string, unknown>;
    message = typeof inner.message === "string" ? inner.message : "";
    code = typeof inner.status === "string" ? inner.status : typeof inner.code === "string" ? inner.code : typeof inner.type === "string" ? inner.type : "";
  }
  if (!message && typeof record.message === "string") message = record.message;
  if (!code && typeof record.code === "string") code = record.code;
  return redact([code, message].filter(Boolean).join(": "));
}

/** One line on why a call failed, for server logs: HTTP status and reason, timeout, or network code. */
export function describeFailure(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    return `HTTP ${error.status}${error.detail ? `: ${error.detail}` : ""}${error.auth ? " (the API key was refused: check it in .env / .env.local)" : ""}`;
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return `no answer in time (${redact(error.message, 80)})`;
    if (error.name === "AbortError") return "aborted before it answered";
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    if (cause && (cause.code || cause.message)) return redact(`network error ${String(cause.code ?? "")} ${String(cause.message ?? "")}`, 160);
    return redact(error.message || error.name, 360);
  }
  return redact(String(error), 360);
}

/** Parses Retry-After (seconds form) from a response. */
export function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

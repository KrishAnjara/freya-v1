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

/** Cooldown after an upstream rejects for load (429) when it gives no Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 20_000;
/** Cooldown after a timeout, network error, or 5xx. */
const OUTAGE_COOLDOWN_MS = 45_000;
/** Upper bound, so a bogus Retry-After cannot sideline a provider for an hour. */
const MAX_COOLDOWN_MS = 120_000;

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
  const fromHeader = retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
  const base = status === 429 ? (fromHeader || RATE_LIMIT_COOLDOWN_MS) : OUTAGE_COOLDOWN_MS;
  cooldowns.set(key, now + Math.min(MAX_COOLDOWN_MS, Math.max(1000, base)));
}

export function markSuccess(key: string) {
  cooldowns.delete(key);
}

/** For deterministic tests. */
export function resetProviderHealthForTests() {
  cooldowns.clear();
}

/** An upstream HTTP failure, carrying what the breaker needs and nothing sensitive. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Parses Retry-After (seconds form) from a response. */
export function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

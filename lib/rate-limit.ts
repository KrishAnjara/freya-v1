import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { loadConfig } from "@/lib/freya-config";

export type ChatIdentity = {
  type: "edge" | "anonymous" | "authenticated" | "owner";
  subject: string;
};

/**
 * Self-hosted: one owner running FREYA on their own machine, with their own API keys.
 *
 * A hosted deployment identifies each visitor from a header its edge proxy writes, and refuses
 * to serve without one. Run locally there is no proxy, so that header never exists and every
 * request was refused. Self-hosted mode replaces per-visitor identity with a single owner
 * budget. Limiting still applies, unless the owner switches it off in freya.config.json: if the app
 * were exposed by mistake, all traffic would share that one budget, which caps the damage to the
 * owner's API quota.
 */
export function isSelfHosted() {
  return process.env.FREYA_SELF_HOSTED?.trim().toLowerCase() === "true";
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  backend: "upstash" | "local";
};

export class RateLimitUnavailableError extends Error {}

const POLICY = {
  edge: [
    { limit: 60, window: "10 m", label: "short" },
    { limit: 1000, window: "1 d", label: "daily" },
  ],
  anonymous: [
    { limit: 5, window: "10 m", label: "short" },
    { limit: 20, window: "1 d", label: "daily" },
  ],
  authenticated: [
    { limit: 20, window: "10 m", label: "short" },
    { limit: 120, window: "1 d", label: "daily" },
  ],
  // The owner's own keys and quota; generous, but still a ceiling.
  owner: [
    { limit: 60, window: "10 m", label: "short" },
    { limit: 600, window: "1 d", label: "daily" },
  ],
} as const;

type PolicyKey = keyof typeof POLICY;
const localHits = new Map<string, number[]>();
const windowsMs: Record<string, number> = { "10 m": 10 * 60_000, "1 d": 24 * 60 * 60_000 };
let redisLimiters: Record<string, Ratelimit> | undefined;

function getRedisLimiters(): Record<string, Ratelimit> {
  if (redisLimiters) return redisLimiters;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RateLimitUnavailableError("Shared rate limiter is not configured.");
  }

  const redis = new Redis({ url, token });
  redisLimiters = {};
  for (const type of ["edge", "anonymous", "authenticated", "owner"] as const) {
    for (const item of POLICY[type]) {
      redisLimiters[`${type}:${item.label}`] = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(item.limit, item.window),
        analytics: false,
        prefix: `freya:chat:${type}:${item.label}`,
      });
    }
  }
  return redisLimiters;
}

function localLimit(key: string, limit: number, windowMs: number, now: number): RateLimitResult {
  const retained = (localHits.get(key) ?? []).filter((timestamp) => timestamp > now - windowMs);
  if (retained.length >= limit) {
    localHits.set(key, retained);
    const resetAt = retained[0] + windowMs;
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      backend: "local",
    };
  }

  retained.push(now);
  localHits.set(key, retained);
  return {
    allowed: true,
    limit,
    remaining: limit - retained.length,
    resetAt: now + windowMs,
    retryAfterSeconds: 0,
    backend: "local",
  };
}

/**
 * Uses shared Upstash sliding windows in production. Local memory is an explicitly
 * non-distributed development/test fallback and must never be used in production.
 */
export async function consumeChatRateLimit(
  identity: ChatIdentity,
  now = Date.now(),
): Promise<RateLimitResult> {
  // The "rateLimit" switch is for your own machine: a public deployment keeps its limits.
  if (loadConfig().rateLimit === false && (process.env.NODE_ENV !== "production" || isSelfHosted())) {
    return { allowed: true, limit: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER, resetAt: now, retryAfterSeconds: 0, backend: "local" };
  }
  const policyKey: PolicyKey = identity.type;
  const subjectHash = createHash("sha256").update(identity.subject).digest("hex");
  const policy = POLICY[policyKey];
  const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

  if (!configured) {
    // A single self-hosted process has nothing to share limits with, so local is correct there.
    if (process.env.NODE_ENV === "production" && !isSelfHosted()) {
      throw new RateLimitUnavailableError("Shared rate limiter is not configured.");
    }
    const local = policy.map((item) =>
      localLimit(`${identity.type}:${subjectHash}:${item.label}`, item.limit, windowsMs[item.window], now),
    );
    const rejected = local.find((result) => !result.allowed);
    const minimumRemaining = Math.min(...local.map((result) => result.remaining));
    const earliestReset = Math.min(...local.map((result) => result.resetAt));
    return rejected ?? {
      allowed: true,
      limit: Math.min(...local.map((result) => result.limit)),
      remaining: minimumRemaining,
      resetAt: earliestReset,
      retryAfterSeconds: 0,
      backend: "local",
    };
  }

  try {
    const limiters = getRedisLimiters();
    let combined: RateLimitResult | undefined;
    for (const item of policy) {
      const result = await limiters[`${identity.type}:${item.label}`].limit(subjectHash);
      const converted: RateLimitResult = {
        allowed: result.success,
        limit: result.limit,
        remaining: result.remaining,
        resetAt: result.reset,
        retryAfterSeconds: result.success ? 0 : Math.max(1, Math.ceil((result.reset - now) / 1000)),
        backend: "upstash",
      };
      if (!result.success) return converted;
      if (!combined || result.remaining < combined.remaining) combined = converted;
    }
    return combined ?? {
      allowed: true,
      limit: 0,
      remaining: 0,
      resetAt: now,
      retryAfterSeconds: 0,
      backend: "upstash",
    };
  } catch {
    if (process.env.NODE_ENV !== "production" || isSelfHosted()) {
      const local = policy.map((item) =>
        localLimit(`${identity.type}:${subjectHash}:${item.label}`, item.limit, windowsMs[item.window], now),
      );
      const rejected = local.find((result) => !result.allowed);
      const minimumRemaining = Math.min(...local.map((result) => result.remaining));
      const earliestReset = Math.min(...local.map((result) => result.resetAt));
      return rejected ?? {
        allowed: true,
        limit: Math.min(...local.map((result) => result.limit)),
        remaining: minimumRemaining,
        resetAt: earliestReset,
        retryAfterSeconds: 0,
        backend: "local",
      };
    }
    throw new RateLimitUnavailableError("Shared rate limiter is unavailable.");
  }
}

/** Reset only the process-local fallback; intended for deterministic tests. */
export function resetLocalRateLimitsForTests(): void {
  localHits.clear();
}

import { NextResponse } from "next/server";
import { isIP } from "node:net";
import { consumeChatRateLimit, isSelfHosted, RateLimitUnavailableError } from "@/lib/rate-limit";

/**
 * Abuse protection for the smaller AI routes (memory reflection, visualisation, images): the
 * same identity rules and shared limits as chat, since each call spends provider quota.
 * Returns a response to send when the request must stop, or null to carry on.
 */
export function clientSubject(request: Request): string | null {
  if (isSelfHosted()) return "self-hosted-owner";
  const header = process.env.FREYA_TRUSTED_IP_HEADER?.trim().toLowerCase() || (process.env.NODE_ENV === "production" ? "" : "x-real-ip");
  const candidate = header ? request.headers.get(header)?.trim() : undefined;
  if (candidate && isIP(candidate)) return candidate;
  return process.env.NODE_ENV === "production" ? null : "local-development";
}

export async function guardRequest(request: Request, maxBytes: number, unavailable: string): Promise<NextResponse | null> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) {
    return NextResponse.json({ error: "That request is too large." }, { status: 413 });
  }
  const subject = clientSubject(request);
  if (!subject) return NextResponse.json({ error: unavailable }, { status: 503 });
  try {
    const limit = await consumeChatRateLimit({ type: "edge", subject });
    if (!limit.allowed) {
      return NextResponse.json({ error: "Too many requests. Wait a moment and try again." }, { status: 429, headers: { "Retry-After": String(Math.max(1, limit.retryAfterSeconds)) } });
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) return NextResponse.json({ error: unavailable }, { status: 503 });
    throw error;
  }
  return null;
}

/** Hosted providers are off in Local-only deployments (FREYA_LOCAL_ONLY=true). */
export function hostedProvidersAllowed() {
  return (process.env.FREYA_LOCAL_ONLY || "false").toLowerCase() !== "true";
}

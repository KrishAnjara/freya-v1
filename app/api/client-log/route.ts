import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_000;
const MAX_FIELD_CHARS = 1_000;

/** Simple per-process throttle so a looping client cannot flood the log. */
const recent = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;

function throttled(key: string) {
  const now = Date.now();
  const entry = recent.get(key);
  if (!entry || now > entry.resetAt) {
    recent.set(key, { count: 1, resetAt: now + WINDOW_MS });
    // Opportunistic cleanup; this map only ever holds a handful of keys.
    if (recent.size > 500) {
      for (const [existing, value] of recent) if (now > value.resetAt) recent.delete(existing);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.slice(0, MAX_FIELD_CHARS) : "";
}

/**
 * Receives client-side failures so they are recorded on the server instead of shown to the
 * reader. The browser shows a calm, generic message; the detail lands here.
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

    const key = request.headers.get("x-real-ip")?.trim() || "local";
    if (throttled(key)) return new NextResponse(null, { status: 429 });

    const body = JSON.parse(raw) as Record<string, unknown>;
    const scope = clean(body.scope) || "unknown";
    const message = clean(body.message);
    const detail = clean(body.detail);

    // Logged, never echoed back: the response body stays empty by design.
    console.error(
      `[freya:client] ${scope}: ${message}${detail ? ` | ${detail}` : ""}`,
    );
  } catch {
    // A malformed report must not become an error of its own.
  }
  return new NextResponse(null, { status: 204 });
}

import { NextResponse } from "next/server";

/**
 * An id for this run of the server, which the browser compares with the one stored beside
 * FREYA's mood: a restarted server means she starts again at neutral. Kept on globalThis so
 * hot reloads in development don't count as a restart. Reveals nothing but a random id.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const server = globalThis as typeof globalThis & { __freyaBootId?: string };

export async function GET() {
  server.__freyaBootId ??= crypto.randomUUID();
  return NextResponse.json({ bootId: server.__freyaBootId }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse } from "next/server";

/**
 * "May this browser use FREYA?" The answer is middleware.ts's (lib/access): reaching this route at
 * all means signed in, allowed, and the account's device. app/components/AuthGate asks before the
 * app loads.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

import { NextResponse, type NextRequest } from "next/server";
import { checkAccess, isOpenRoute } from "@/lib/access";
import { loadConfig } from "@/lib/freya-config";

/**
 * Every /api route goes through here first (lib/access): owner-only and one-browser-session, as
 * freya.config.json says. Runs on Node so it can read that file; a change applies at once.
 */
export const config = { matcher: ["/api/:path*"], runtime: "nodejs" };

export async function middleware(request: NextRequest) {
  if (isOpenRoute(request.nextUrl.pathname)) return NextResponse.next();
  const switches = loadConfig();
  const result = await checkAccess(request.headers, { ownerOnly: switches.ownerOnly === true, oneSession: switches.oneSession === true });
  if (result.ok) return NextResponse.next();
  return NextResponse.json({ error: result.error, access: result.code }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

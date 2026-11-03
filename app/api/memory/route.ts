import { NextResponse } from "next/server";
import { clientSubject, guardRequest } from "@/lib/route-guard";
import { getMemoryStore, normalizeEpisode, normalizeNotes } from "@/lib/memory-store";

/**
 * FREYA's memory on this machine (lib/memory-store): read it, sync notes, keep and delete
 * conversation recaps, forget everything.
 *
 *   GET                       → { enabled, notes, episodes }
 *   PUT    { notes }          → replaces the notes (the browser is where they're edited)
 *   POST   { episode }        → keeps or updates one conversation's recap
 *   DELETE ?episode=ID        → forgets one recap
 *   DELETE ?scope=all|notes|episodes
 *
 * Only on an install with one owner (self-hosted or development); elsewhere `enabled: false`
 * and the browser keeps using its own storage. Same-origin only: another site open in the
 * browser can't read or change it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 200_000;
const NO_STORE = { "Cache-Control": "no-store" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

async function open(request: Request) {
  if (!sameOrigin(request)) return { stop: NextResponse.json({ error: "Not allowed." }, { status: 403 }) };
  const stop = await guardRequest(request, MAX_BODY, "Memory is unavailable right now.");
  if (stop) return { stop };
  const store = getMemoryStore();
  const owner = clientSubject(request);
  if (!store || !owner) return { stop: NextResponse.json({ enabled: false }, { headers: NO_STORE }) };
  return { store, owner };
}

export async function GET(request: Request) {
  const opened = await open(request);
  if ("stop" in opened) return opened.stop;
  const { store, owner } = opened;
  return NextResponse.json({ enabled: true, kind: store.kind, notes: store.notes(owner), episodes: store.episodes(owner) }, { headers: NO_STORE });
}

export async function PUT(request: Request) {
  const opened = await open(request);
  if ("stop" in opened) return opened.stop;
  const body = await request.json().catch(() => null) as { notes?: unknown } | null;
  if (!body || !Array.isArray(body.notes)) return NextResponse.json({ error: "Send { notes: [...] }." }, { status: 400 });
  const notes = opened.store.replaceNotes(opened.owner, normalizeNotes(body.notes));
  return NextResponse.json({ enabled: true, notes }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const opened = await open(request);
  if ("stop" in opened) return opened.stop;
  const body = await request.json().catch(() => null) as { episode?: unknown } | null;
  const episode = normalizeEpisode(body?.episode);
  if (!episode) return NextResponse.json({ error: "Send { episode: { id, title, recap } }." }, { status: 400 });
  return NextResponse.json({ enabled: true, episode: opened.store.upsertEpisode(opened.owner, episode) }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const opened = await open(request);
  if ("stop" in opened) return opened.stop;
  const params = new URL(request.url).searchParams;
  const episode = params.get("episode");
  if (episode) {
    opened.store.deleteEpisode(opened.owner, episode.slice(0, 64));
    return NextResponse.json({ enabled: true, deleted: episode }, { headers: NO_STORE });
  }
  const scope = params.get("scope");
  if (scope !== "all" && scope !== "notes" && scope !== "episodes") return NextResponse.json({ error: "Say what to forget: ?scope=all, notes or episodes, or ?episode=ID." }, { status: 400 });
  opened.store.clear(opened.owner, scope);
  return NextResponse.json({ enabled: true, cleared: scope }, { headers: NO_STORE });
}

/**
 * One device at a time per account, handed over with permission, like WhatsApp Web:
 *
 *   - The device using FREYA keeps a heartbeat in freya_sessions (last_seen, every 30 s).
 *   - A sign-in on another browser or device doesn't take over: it asks (pending_id), and waits.
 *   - The device in use sees "someone wants to use FREYA on <device>" and allows or refuses.
 *     Allowed: the account's session becomes the new device's, and this one signs out. Refused:
 *     the new device is told, and signs out.
 *   - If the device in use has gone quiet (closed, offline: no heartbeat for STALE_MS), there's
 *     nobody to ask, so the new sign-in gets in straight away.
 * The server refuses every request from anything but the account's current session (lib/access),
 * so a device waiting for permission can't use FREYA meanwhile. `decide` is pure and tested.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type SessionRow = {
  session_id: string;
  last_seen?: string | null;
  pending_id?: string | null;
  pending_label?: string | null;
  pending_at?: string | null;
  decision?: string | null;
};

/** Quiet this long, the device in use is taken to be closed. */
export const STALE_MS = 90_000;
/** A request to switch devices is answered within this, or it lapses. */
export const PENDING_TTL_MS = 3 * 60_000;
export const HEARTBEAT_MS = 30_000;

const TABLE = "freya_sessions";
const at = (value?: string | null) => (value ? Date.parse(value) : NaN);

export type SessionState =
  | "current"      // this device is the account's session
  | "replaced"     // another device has it now
  | "unclaimed"    // nobody has it (no row, or no table): this device can take it
  | "stale"        // the device that had it has gone quiet: this device can take it
  | "waiting"      // this device asked, and is waiting for an answer
  | "denied"       // this device asked, and was refused
  | "expired";     // this device asked, and nobody answered in time

/** Where this device stands, from the account's row. Pure. */
export function decide(row: SessionRow | null, localId: string, now = Date.now()): SessionState {
  if (!row?.session_id) return "unclaimed";
  if (localId && row.session_id === localId) return "current";
  if (localId && row.pending_id === localId) {
    if (row.decision === "denied") return "denied";
    if (now - at(row.pending_at) > PENDING_TTL_MS) return "expired";
    // The device that would have to answer is gone: nobody to wait for.
    if (!(now - at(row.last_seen) < STALE_MS)) return "stale";
    return "waiting";
  }
  if (!(now - at(row.last_seen) < STALE_MS)) return "stale";
  return "replaced";
}

/** A request from another device that the device in use should answer, if any. Pure. */
export function pendingRequest(row: SessionRow | null, localId: string, now = Date.now()): { id: string; label: string } | null {
  if (!row || row.session_id !== localId || !row.pending_id || row.decision) return null;
  if (now - at(row.pending_at) > PENDING_TTL_MS) return null;
  return { id: row.pending_id, label: row.pending_label || "another device" };
}

/** "Chrome on Windows", "Safari on iPhone": enough to recognise a device, nothing more. */
export function deviceLabel(userAgent: string) {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "a browser";
  const system = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android"
    : /Windows/.test(userAgent) ? "Windows" : /Mac OS X|Macintosh/.test(userAgent) ? "Mac" : /Linux/.test(userAgent) ? "Linux" : "a device";
  return `${browser} on ${system}`;
}

export async function readSession(client: SupabaseClient, userId: string): Promise<SessionRow | null> {
  const { data, error } = await client.from(TABLE).select("session_id, last_seen, pending_id, pending_label, pending_at, decision").eq("user_id", userId).maybeSingle();
  return error ? null : (data as SessionRow | null);
}

/** This device takes the account's session (nobody else is using it). */
export async function takeSession(client: SupabaseClient, userId: string, sessionId: string) {
  const now = new Date().toISOString();
  const { error } = await client.from(TABLE).upsert({ user_id: userId, session_id: sessionId, last_seen: now, pending_id: null, pending_label: null, pending_at: null, decision: null, updated_at: now }, { onConflict: "user_id" });
  return !error || error.code === "PGRST205" || error.code === "42P01";
}

/** This device asks the one in use for the account. */
export async function askForSession(client: SupabaseClient, userId: string, sessionId: string, label: string) {
  const { error } = await client.from(TABLE).update({ pending_id: sessionId, pending_label: label.slice(0, 60), pending_at: new Date().toISOString(), decision: null }).eq("user_id", userId);
  return !error;
}

/** The device in use answers: allowed hands the account over; refused tells the other device. */
export async function answerRequest(client: SupabaseClient, userId: string, pendingId: string, allow: boolean) {
  const now = new Date().toISOString();
  const change = allow
    ? { session_id: pendingId, last_seen: now, pending_id: null, pending_label: null, pending_at: null, decision: null, updated_at: now }
    : { decision: "denied" };
  const { error } = await client.from(TABLE).update(change).eq("user_id", userId).eq("pending_id", pendingId);
  return !error;
}

/** "Still here": only the device in use writes it. */
export async function heartbeat(client: SupabaseClient, userId: string, sessionId: string) {
  await client.from(TABLE).update({ last_seen: new Date().toISOString() }).eq("user_id", userId).eq("session_id", sessionId);
}

/** A refused or lapsed request is cleared by the device that made it. */
export async function withdrawRequest(client: SupabaseClient, userId: string, sessionId: string) {
  await client.from(TABLE).update({ pending_id: null, pending_label: null, pending_at: null, decision: null }).eq("user_id", userId).eq("pending_id", sessionId);
}

/**
 * The relationship, kept in Supabase by the server as well as the browser (freya_state.bond):
 * each message the chat route reads the account's saved bond, uses the newer of that and the
 * browser's copy (so a stale or cleared browser can't reset it, and one device can't drift from
 * another), and writes the result back. Uses the caller's own token, so row-level security still
 * limits it to their own row; no service key. Failing to reach Supabase never stops a reply.
 */
import { normalizeBond, type Bond } from "@/lib/relationship";

const config = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && key ? { url, key } : null;
};

const users = new Map<string, { id: string; at: number }>();

async function userId(token: string, fetchImpl: typeof fetch): Promise<string | null> {
  const known = users.get(token);
  if (known && Date.now() - known.at < 60_000) return known.id;
  const supabase = config();
  if (!supabase) return null;
  const response = await fetchImpl(`${supabase.url}/auth/v1/user`, { headers: { apikey: supabase.key, Authorization: `Bearer ${token}` }, cache: "no-store" });
  const body = response.ok ? await response.json().catch(() => null) as { id?: unknown } | null : null;
  if (typeof body?.id !== "string") return null;
  users.set(token, { id: body.id, at: Date.now() });
  return body.id;
}

/** The account's saved bond, or null (not signed in, no row yet, table missing, unreachable). */
export async function loadCloudBond(token: string, fetchImpl: typeof fetch = fetch): Promise<{ userId: string; bond: Bond | null } | null> {
  const supabase = config();
  if (!supabase || !token) return null;
  try {
    const id = await userId(token, fetchImpl);
    if (!id) return null;
    const response = await fetchImpl(`${supabase.url}/rest/v1/freya_state?select=bond&user_id=eq.${encodeURIComponent(id)}`, {
      headers: { apikey: supabase.key, Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const rows = await response.json().catch(() => []) as { bond?: unknown }[];
    return { userId: id, bond: Array.isArray(rows) ? normalizeBond(rows[0]?.bond) : null };
  } catch {
    return null;
  }
}

/** Writes the bond back, leaving the row's other columns (her mood) as they are. */
export async function saveCloudBond(token: string, userIdValue: string, bond: Bond, fetchImpl: typeof fetch = fetch) {
  const supabase = config();
  if (!supabase) return false;
  try {
    const response = await fetchImpl(`${supabase.url}/rest/v1/freya_state?on_conflict=user_id`, {
      method: "POST",
      headers: { apikey: supabase.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userIdValue, bond, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Which copy to keep: the one with more history, so a fresh browser's untouched copy never resets
 * the relationship; with the same history, the one changed last.
 */
export function newerBond(local: Bond | null, cloud: Bond | null): Bond | null {
  if (!local) return cloud;
  if (!cloud) return local;
  if (cloud.messages !== local.messages) return cloud.messages > local.messages ? cloud : local;
  return cloud.updatedAt > local.updatedAt ? cloud : local;
}

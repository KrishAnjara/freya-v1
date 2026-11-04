/**
 * Who may use FREYA's API, checked in front of every /api route (middleware.ts):
 *
 *   ownerOnly   only the owner's Supabase account (FREYA_OWNER_EMAIL, by default
 *               krishanjara@zohomail.in). Everyone else, signed in or not, is refused.
 *   oneSession  one browser at a time per account: each sign-in claims the account's row in
 *               freya_sessions (supabase/freya-sessions.sql), and a request from any other browser
 *               session is refused, so that browser signs itself out.
 *
 * Both are switches in freya.config.json. The check uses the caller's own Supabase token against
 * Supabase's REST API (no service key), and caches answers briefly so chat isn't slowed.
 */

export type AccessOptions = { ownerOnly: boolean; oneSession: boolean };
export type AccessCode = "sign-in" | "not-allowed" | "session-replaced" | "unavailable";
export type AccessResult = { ok: true; userId?: string } | { ok: false; status: number; code: AccessCode; error: string };

export const SESSION_HEADER = "x-freya-session";

export function ownerEmail() {
  return (process.env.FREYA_OWNER_EMAIL || "krishanjara@zohomail.in").trim().toLowerCase();
}

/** Routes anyone can reach: liveness, error reports, which switches are on (so the page knows to ask for sign-in), portrait files. */
export function isOpenRoute(path: string) {
  return path === "/api/health" || path === "/api/client-log" || path === "/api/session" || path.startsWith("/api/portrait/");
}

const USER_TTL_MS = 60_000;
const SESSION_TTL_MS = 15_000;
const users = new Map<string, { at: number; id: string; email: string }>();
const sessions = new Map<string, { at: number; current: string | null }>();
let missingTableWarned = false;

const refuse = (status: number, code: AccessCode, error: string): AccessResult => ({ ok: false, status, code, error });

export function resetAccessCacheForTests() {
  users.clear();
  sessions.clear();
}

export async function checkAccess(headers: Headers, options: AccessOptions, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<AccessResult> {
  if (!options.ownerOnly && !options.oneSession) return { ok: true };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return refuse(503, "unavailable", "Sign-in isn't set up on this server (NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY).");
  const token = headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return refuse(401, "sign-in", "Sign in to use FREYA.");

  let user = users.get(token);
  if (!user || now - user.at > USER_TTL_MS) {
    let response: Response;
    try {
      response = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, cache: "no-store" });
    } catch {
      return refuse(503, "unavailable", "Couldn't check your sign-in just now. Try again in a moment.");
    }
    if (response.status === 401 || response.status === 403) return refuse(401, "sign-in", "Your sign-in has expired. Sign in again.");
    const body = await response.json().catch(() => null) as { id?: unknown; email?: unknown } | null;
    if (!response.ok || typeof body?.id !== "string") return refuse(503, "unavailable", "Couldn't check your sign-in just now. Try again in a moment.");
    user = { at: now, id: body.id, email: typeof body.email === "string" ? body.email.toLowerCase() : "" };
    users.set(token, user);
  }
  if (options.ownerOnly && user.email !== ownerEmail()) return refuse(403, "not-allowed", "This account doesn't have access to FREYA.");

  if (options.oneSession) {
    const claimed = headers.get(SESSION_HEADER) ?? "";
    let known = sessions.get(user.id);
    if (!known || now - known.at > SESSION_TTL_MS) {
      try {
        const response = await fetchImpl(`${url}/rest/v1/freya_sessions?select=session_id&user_id=eq.${encodeURIComponent(user.id)}`, {
          headers: { apikey: key, Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store",
        });
        if (response.status === 404) {
          // The table hasn't been created: one-session can't be enforced yet; say so once.
          if (!missingTableWarned) { missingTableWarned = true; console.warn("FREYA: run supabase/freya-sessions.sql to allow one browser session per account."); }
          known = { at: now, current: null };
        } else {
          const rows = await response.json().catch(() => []) as { session_id?: unknown }[];
          known = { at: now, current: Array.isArray(rows) && typeof rows[0]?.session_id === "string" ? rows[0].session_id : null };
        }
      } catch {
        known = { at: now, current: null };
      }
      sessions.set(user.id, known);
    }
    if (known.current && claimed !== known.current) return refuse(409, "session-replaced", "You signed in on another browser, so this one was signed out.");
  }
  return { ok: true, userId: user.id };
}

/** A new sign-in claimed the account: forget the cached session so the change applies at once. */
export function forgetSession(userId: string) {
  sessions.delete(userId);
}

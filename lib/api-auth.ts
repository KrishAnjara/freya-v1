/**
 * The browser half of lib/access. Every request to this site's /api carries the signed-in
 * account's token and this browser's session id, added in one place (a wrapper around fetch), so
 * no call can forget them. A refusal (signed out, not the owner, signed in elsewhere) is announced
 * as a "freya:access" event, which the page turns into its sign-in screen.
 *
 * One session per account: signing in here writes a new random id to freya_sessions; any other
 * browser of the account is refused from then on and signs itself out.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const SESSION_HEADER = "x-freya-session";
export type AccessCode = "sign-in" | "not-allowed" | "session-replaced" | "unavailable";

let token = "";
let installed = false;
const sessionKey = (userId: string) => `freya.v1.session.${userId}`;
let sessionId = "";

export function setApiToken(value: string | null | undefined) {
  token = value ?? "";
}

export function localSessionId(userId: string) {
  try { return localStorage.getItem(sessionKey(userId)) ?? ""; } catch { return ""; }
}

function isOwnApi(input: RequestInfo | URL) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Wraps fetch once. Requests elsewhere (Supabase, Hugging Face...) are left exactly as they were. */
export function installApiAuth() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!isOwnApi(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    if (sessionId) headers.set(SESSION_HEADER, sessionId);
    const response = await original(input, { ...init, headers });
    if (response.status === 401 || response.status === 403 || response.status === 409) {
      const code = await response.clone().json().then((body) => body?.access).catch(() => undefined);
      if (code) window.dispatchEvent(new CustomEvent("freya:access", { detail: code as AccessCode }));
    }
    return response;
  };
}

/** A fresh sign-in: this browser becomes the account's one session. */
export async function claimSession(client: SupabaseClient, userId: string) {
  const id = crypto.randomUUID().replace(/-/g, "");
  try { localStorage.setItem(sessionKey(userId), id); } catch { /* still claimed for this page */ }
  sessionId = id;
  const { error } = await client.from("freya_sessions").upsert({ user_id: userId, session_id: id, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  // No table yet: one-session can't be enforced, and the app carries on as before.
  return !error || error.code === "PGRST205" || error.code === "42P01";
}

/**
 * Is this browser still the account's session? "replaced" when another browser signed in since;
 * "unclaimed" when there's no row (or table) yet, so this one should claim it.
 */
export async function checkSession(client: SupabaseClient, userId: string): Promise<"current" | "replaced" | "unclaimed"> {
  sessionId = localSessionId(userId);
  const { data, error } = await client.from("freya_sessions").select("session_id").eq("user_id", userId).maybeSingle();
  if (error || !data?.session_id) return "unclaimed";
  // Only a fresh sign-in takes the account over; a browser that merely still had a sign-in doesn't.
  return data.session_id === sessionId ? "current" : "replaced";
}

export function forgetLocalSession(userId: string) {
  sessionId = "";
  try { localStorage.removeItem(sessionKey(userId)); } catch { /* nothing kept */ }
}

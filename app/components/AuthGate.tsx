"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { adoptSessionId, forgetLocalSession, installApiAuth, localSessionId, newSessionId, setApiToken, type AccessCode } from "@/lib/api-auth";
import { askForSession, decide, deviceLabel, readSession, takeSession, withdrawRequest } from "@/lib/device-session";

/**
 * Nobody gets FREYA without signing in: no guest mode, whatever the switches say. The app itself
 * (children) loads only once this browser is signed in, allowed (lib/access), and the account's
 * device (lib/device-session):
 *
 *   - a browser that is already signed in goes straight in, with no sign-in page;
 *   - a new browser or device signs in; if FREYA is in use elsewhere it asks that device and waits;
 *   - a browser that FREYA moved away from keeps its sign-in and offers "Use here" (asking again),
 *     rather than signing out.
 *
 * The app hands control back with a "freya:leave" event (moved away, signed out, refused).
 */
type GateState = "checking" | "signed-out" | "elsewhere" | "waiting" | "not-allowed" | "no-auth" | "ready";

export const LEAVE_EVENT = "freya:leave";

const MESSAGES: Partial<Record<AccessCode | "signed-out", string>> = {
  "sign-in": "Your sign-in has expired. Sign in again.",
  "session-replaced": "FREYA moved to your other device.",
  "switch-denied": "Your other device didn't allow the switch, so FREYA stays there.",
  "switch-expired": "Your other device didn't answer in time.",
  "unavailable": "Sign-in couldn't be checked just now. Try again in a moment.",
  "signed-out": "Signed out.",
};

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const userRef = useRef("");
  const oneSessionRef = useRef(true);
  const supabase = getSupabaseBrowserClient();

  /** Is this account allowed in (owner-only)? The server's own check, through /api/access. */
  const verify = useCallback(async () => {
    const response = await fetch("/api/access", { cache: "no-store" }).catch(() => null);
    if (!response || response.ok) { setState("ready"); return; }
    const code = await response.json().then((body) => body?.access as AccessCode | undefined).catch(() => undefined);
    if (code === "not-allowed") setState("not-allowed");
    else if (code === "sign-in") { await supabase?.auth.signOut({ scope: "local" }).catch(() => undefined); setNote(MESSAGES["sign-in"]!); setState("signed-out"); }
    else if (code === "session-replaced") { setNote(MESSAGES["session-replaced"]!); setState("elsewhere"); }
    else { setNote(MESSAGES.unavailable!); setState("elsewhere"); }
  }, [supabase]);

  /**
   * Where this browser stands for the account. `fresh`: it has just signed in (or asked to "use
   * here"), so it asks the device in use rather than giving up.
   */
  const enter = useCallback(async (userId: string, fresh: boolean) => {
    if (!supabase) return;
    userRef.current = userId;
    if (!oneSessionRef.current) {
      const id = localSessionId(userId) || newSessionId();
      adoptSessionId(userId, id);
      await takeSession(supabase, userId, id);
      return verify();
    }
    const localId = fresh ? newSessionId() : localSessionId(userId);
    const row = await readSession(supabase, userId).catch(() => null);
    const where = decide(row, localId);
    if (where === "current") { adoptSessionId(userId, localId); return verify(); }
    if (where === "unclaimed" || where === "stale") {
      const id = localId || newSessionId();
      adoptSessionId(userId, id);
      await takeSession(supabase, userId, id);
      return verify();
    }
    if (where === "waiting") { adoptSessionId(userId, localId); setState("waiting"); return; }
    if (where === "denied" || where === "expired") {
      await withdrawRequest(supabase, userId, localId).catch(() => undefined);
      setNote(MESSAGES[where === "denied" ? "switch-denied" : "switch-expired"]!);
      setState("elsewhere");
      return;
    }
    // In use on another device.
    if (!fresh) { setNote("FREYA is open on your other device."); setState("elsewhere"); return; }
    adoptSessionId(userId, localId);
    await askForSession(supabase, userId, localId, deviceLabel(navigator.userAgent));
    setState("waiting");
  }, [supabase, verify]);

  // Opening: switches, then the sign-in this browser already has, if any.
  useEffect(() => {
    if (!supabase) { setState("no-auth"); return; }
    installApiAuth();
    let active = true;
    (async () => {
      const switches = await fetch("/api/session", { cache: "no-store" }).then((response) => response.json()).catch(() => null);
      oneSessionRef.current = switches?.switches?.oneSession !== false;
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setApiToken(data.session?.access_token);
      if (data.session?.user) await enter(data.session.user.id, false);
      else setState("signed-out");
    })().catch(() => { if (active) { setNote(MESSAGES.unavailable!); setState("signed-out"); } });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => setApiToken(session?.access_token));
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [supabase, enter]);

  // Waiting for the other device's answer.
  useEffect(() => {
    if (state !== "waiting" || !supabase) return;
    const timer = window.setInterval(async () => {
      const userId = userRef.current;
      const row = await readSession(supabase, userId).catch(() => null);
      const where = decide(row, localSessionId(userId));
      if (where === "current") void verify();
      else if (where === "stale" || where === "unclaimed") void enter(userId, false);
      else if (where === "denied" || where === "expired") void enter(userId, false);
      else if (where === "replaced") { setNote(MESSAGES["session-replaced"]!); setState("elsewhere"); }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [state, supabase, enter, verify]);

  // The app gives control back: moved to another device, signed out, refused.
  useEffect(() => {
    const onLeave = (event: Event) => {
      const why = (event as CustomEvent<AccessCode | "signed-out">).detail;
      setNote(MESSAGES[why] ?? "");
      if (why === "not-allowed") setState("not-allowed");
      else if (why === "signed-out" || why === "sign-in") setState("signed-out");
      else setState("elsewhere");
    };
    window.addEventListener(LEAVE_EVENT, onLeave);
    return () => window.removeEventListener(LEAVE_EVENT, onLeave);
  }, []);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true);
    setNote("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      setApiToken(data.session?.access_token);
      setPassword("");
      if (data.user) await enter(data.user.id, true);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (userRef.current && supabase && state === "waiting") await withdrawRequest(supabase, userRef.current, localSessionId(userRef.current)).catch(() => undefined);
    if (userRef.current) forgetLocalSession(userRef.current);
    await supabase?.auth.signOut({ scope: "local" }).catch(() => undefined);
    setApiToken("");
    setNote("");
    setState("signed-out");
  }

  if (state === "ready") return <>{children}</>;
  if (state === "checking") return <main className="access-lock" aria-busy="true" />;
  return (
    <main className="access-lock">
      {state === "signed-out" ? (
        <form className="access-card" onSubmit={(event) => void signIn(event)}>
          <h1>FREYA</h1>
          <p>{note || "FREYA is private. Sign in to continue."}</p>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email" autoComplete="email" required />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" autoComplete="current-password" minLength={6} required />
          <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      ) : (
        <div className="access-card">
          <h1>FREYA</h1>
          {state === "no-auth" && <p>Sign-in isn&apos;t set up on this server (NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY), and FREYA has no guest mode.</p>}
          {state === "not-allowed" && <p>This account doesn&apos;t have access to FREYA.</p>}
          {state === "waiting" && <p>FREYA is in use on your other device. Asking it to let you switch here… Allow it there.</p>}
          {state === "elsewhere" && <p>{note || "FREYA is open on your other device."}</p>}
          {state === "elsewhere" && (
            <button type="button" disabled={busy} onClick={() => { setBusy(true); void enter(userRef.current, true).finally(() => setBusy(false)); }}>
              Use here
            </button>
          )}
          {(state === "elsewhere" || state === "not-allowed" || state === "waiting") && (
            <button type="button" className="access-secondary" onClick={() => void signOut()}>Sign out</button>
          )}
        </div>
      )}
    </main>
  );
}

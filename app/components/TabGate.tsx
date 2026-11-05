"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * FREYA open in one tab at a time, like WhatsApp Web. The tab that has her holds a browser lock
 * (the Web Locks API); another tab of the same browser shows "open in another tab" and never loads
 * the app, so it can't send twice or pick up replies twice. "Use here" takes the lock: the old tab
 * shows the same notice and lets go of everything.
 */
export default function TabGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "mine" | "elsewhere" | "moved">("checking");
  const release = useRef<(() => void) | null>(null);

  const claim = useCallback((steal: boolean, retried = false) => {
    if (typeof navigator === "undefined" || !("locks" in navigator)) { setState("mine"); return; }
    const options: LockOptions = steal ? { steal: true } : { ifAvailable: true };
    navigator.locks.request("freya-open", options, (lock) => {
      if (!lock) {
        // In development React mounts twice, and the first mount's lock is let go a moment later.
        if (!retried) window.setTimeout(() => claim(false, true), 400);
        else setState("elsewhere");
        return undefined;
      }
      setState("mine");
      return new Promise<void>((resolve) => { release.current = resolve; });
    }).catch((error: unknown) => {
      // Taken by another tab's "Use here".
      if ((error as { name?: string })?.name === "AbortError") setState("moved");
    });
  }, []);

  useEffect(() => {
    claim(false);
    return () => { release.current?.(); release.current = null; };
  }, [claim]);

  if (state === "mine") return <>{children}</>;
  if (state === "checking") return <main className="access-lock" aria-busy="true" />;
  return (
    <main className="access-lock">
      <div className="access-card">
        <h1>FREYA</h1>
        <p>{state === "moved" ? "FREYA was opened in another tab." : "FREYA is open in another tab."} Use her here instead? The other tab will step aside.</p>
        <button type="button" onClick={() => { setState("checking"); claim(true); }}>Use here</button>
      </div>
    </main>
  );
}

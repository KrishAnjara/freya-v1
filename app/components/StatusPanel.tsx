"use client";

import { useCallback, useEffect, useState } from "react";

type TierStatus = { label: string; kind: string; own: boolean; model?: string; where?: string; state: "ready" | "down" | "cooling" | "unknown"; detail?: string; vision?: boolean };
type Status = {
  available: boolean;
  chain?: TierStatus[];
  vision?: { order: string[]; externalFiles: boolean; ownVisionModel: string | null };
  images?: { ownServer: string | null; cooling: { coolingForSeconds: number; reason?: string } | null; gemini: boolean };
  memory?: { store: "sqlite" | "json" | null; embeddings: string | null };
};

const TIER_NAMES: Record<string, string> = {
  ollama: "Her model", "server-fallback": "Her fallback model", laptop: "This laptop", server: "Her server", grok: "Grok", gemini: "Gemini", groq: "Groq",
};
const STATE_TEXT = { ready: "ready", down: "not reachable", cooling: "skipped for now", unknown: "standing by" } as const;

/**
 * Settings → Models and status: who answers, in what order, and whether each is reachable right
 * now (from /api/status, which probes only her own servers so opening it costs no quota).
 */
export default function StatusPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatus(response.ok ? await response.json() as Status : { available: false });
    } catch {
      setStatus({ available: false });
    } finally {
      setLoading(false);
    }
  }, []);
  // Loads once when the panel opens; the button refreshes it.
  useEffect(() => { void load(); }, [load]);

  if (!status) return <p className="memory-description" role="status">Checking who&apos;s available…</p>;
  if (!status.available) return <p className="memory-description">Status is shown only on your own install.</p>;
  return <div className="status-panel">
    <ol className="status-chain" aria-label="Who answers, in order">
      {status.chain?.map((tier, index) => <li key={`${tier.label}-${index}`} className={`status-tier state-${tier.state}`}>
        <span className="status-dot" aria-hidden="true"/>
        <span className="status-tier-name"><strong>{index + 1}. {TIER_NAMES[tier.label] ?? tier.label}</strong>{tier.model ? ` · ${tier.model}` : ""}{tier.where ? ` · ${tier.where}` : ""}{tier.vision ? " · sees images" : ""}</span>
        <span className="status-tier-state">{STATE_TEXT[tier.state]}{tier.detail ? `: ${tier.detail}` : ""}</span>
      </li>)}
    </ol>
    <p className="memory-description">
      Images: {status.images?.ownServer ? `her image server (${status.images.ownServer})${status.images.cooling ? ", skipped for now" : ""}, then ` : ""}{status.images?.gemini ? "Gemini, then " : ""}a labelled drawing.
      {" "}Reading attachments: {status.vision?.order.filter((name) => name === "own" ? status.vision?.ownVisionModel : status.vision?.externalFiles).map((name) => name === "own" ? `her vision model (${status.vision?.ownVisionModel})` : name[0].toUpperCase() + name.slice(1)).join(", ") || "her own model only"}.
      {" "}Memory: {status.memory?.store ? `kept on this computer (${status.memory.store === "sqlite" ? "SQLite" : "JSON file"})` : "kept in this browser"}{status.memory?.embeddings ? `, matched by meaning with ${status.memory.embeddings}` : ", matched by words"}.
    </p>
    <button type="button" className="dialog-inline-button" onClick={() => void load()} disabled={loading}>{loading ? "Checking…" : "Check again"}</button>
  </div>;
}

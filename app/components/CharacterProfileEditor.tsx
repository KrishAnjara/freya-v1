"use client";

import { useState, type FormEvent } from "react";
import {
  addCharacterPreference,
  MAX_PROFILE_ENTRIES,
  type CharacterPreference,
  type CharacterPreferenceKind,
  type CharacterProfile,
} from "@/lib/character-profile";

type Revision = { revision: number; summary: string; created_at: string; rollback_from: number | null };
type Proposal = { id: string; category: string; description: string; confidence: number; evidence: string[]; origin: string; status: string; created_at: string };

export default function CharacterProfileEditor({
  profile,
  onChange,
  revisions = [],
  proposals = [],
  canReflect = false,
  onRollback,
  onReview,
  onReflect,
}: {
  profile: CharacterProfile;
  onChange: (profile: CharacterProfile) => void;
  revisions?: Revision[];
  proposals?: Proposal[];
  canReflect?: boolean;
  onRollback?: (revision: number) => void;
  onReview?: (id: string, decision: "approved" | "rejected") => void;
  onReflect?: () => void;
}) {
  const [kind, setKind] = useState<CharacterPreferenceKind>("taste");
  const [text, setText] = useState("");
  const [tentative, setTentative] = useState(true);
  const [notice, setNotice] = useState("");

  function update(id: string, changes: Partial<CharacterPreference>) {
    onChange({
      ...profile,
      preferences: profile.preferences.map((item) => item.id === id ? {
        ...item,
        ...changes,
        ...(changes.text !== undefined ? { evidence: ["Explicit user edit; earlier evidence may no longer apply."], origin: "Explicit user feedback" } : {}),
        updatedAt: new Date().toISOString(),
      } : item),
    });
    setNotice("Character profile updated and saved on this device.");
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    if (profile.preferences.length >= MAX_PROFILE_ENTRIES) {
      setNotice(`Keep the dossier to ${MAX_PROFILE_ENTRIES} entries.`);
      return;
    }
    onChange(addCharacterPreference(profile, {
      kind,
      text,
      status: tentative ? "tentative" : "established",
      origin: "Explicit user feedback",
    }));
    setText("");
    setNotice("Added to FREYA's character dossier.");
  }

  return (
    <section className="character-panel" aria-labelledby="character-title">
      <div className="character-heading">
        <div>
          <h2 id="character-title">THE CURSED MUSE</h2>
          <p>FREYA&apos;s editable fictional tastes—not your memories or lived experiences.</p>
        </div>
        <span className="profile-version">PROFILE v{profile.version}</span>
      </div>

      <div className="character-list">
        {profile.preferences.map((item) => (
          <article className="character-item" key={item.id}>
            <div className="character-item-meta">
              <span>{item.kind}</span>
              <span className={item.status === "tentative" ? "tentative-tag" : "established-tag"}>{item.status}</span>
            </div>
            <input
              aria-label={`Edit ${item.kind}: ${item.text}`}
              value={item.text}
              maxLength={240}
              onChange={(event) => update(item.id, { text: event.target.value })}
            />
            <div className="character-item-controls">
              <label>
                Confidence
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(item.confidence * 100)}
                  aria-label={`Confidence for ${item.text}`}
                  onChange={(event) => update(item.id, { confidence: Number(event.target.value) / 100 })}
                />
                <span>{Math.round(item.confidence * 100)}%</span>
              </label>
              <button type="button" onClick={() => update(item.id, { status: item.status === "tentative" ? "established" : "tentative" })}>
                {item.status === "tentative" ? "Set established" : "Make tentative"}
              </button>
              <button type="button" aria-label={`Remove preference: ${item.text}`} onClick={() => {
                onChange({ ...profile, preferences: profile.preferences.filter((entry) => entry.id !== item.id) });
                setNotice("Removed from the character dossier.");
              }}>Remove</button>
            </div>
            <small>Origin: {item.origin}</small>
            <small>Evidence: {item.evidence.join("; ")}</small>
            <small>Revision {item.revision} · Updated {new Date(item.updatedAt).toLocaleDateString()}</small>
          </article>
        ))}
      </div>

      {onReflect && <div className="reflection-controls">
        <button type="button" onClick={onReflect} disabled={!canReflect}>Reflect on this conversation</button>
        <small>Checks repeated, allowlisted low-risk topics locally. Only counts are stored, not message text. The server enforces the daily per-account proposal budget.</small>
      </div>}
      {proposals.length > 0 && <div className="personality-proposals">
        <h3>REFLECTION PROPOSALS</h3>
        {proposals.map((proposal) => <article className="character-item" key={proposal.id}>
          <div className="character-item-meta"><span>{proposal.category}</span><span className={proposal.status === "proposed" ? "tentative-tag" : "established-tag"}>{proposal.status}</span></div>
          <strong>{proposal.description}</strong>
          <small>{proposal.origin}; confidence {Math.round(proposal.confidence * 100)}%</small>
          {proposal.evidence.map((item) => <small key={item}>{item}</small>)}
          {proposal.status === "proposed" && onReview && <div className="character-item-controls">
            <button type="button" onClick={() => onReview(proposal.id, "approved")}>Approve as tentative</button>
            <button type="button" onClick={() => onReview(proposal.id, "rejected")}>Reject</button>
          </div>}
        </article>)}
      </div>}
      {revisions.length > 0 && <div className="personality-history">
        <h3>PROFILE HISTORY</h3>
        {revisions.slice(0, 10).map((revision, index) => <div className="personality-revision" key={revision.revision}>
          <span>v{revision.revision} · {revision.summary || "Profile update"}{revision.rollback_from ? ` · rollback from v${revision.rollback_from}` : ""}</span>
          {index > 0 && onRollback && <button type="button" onClick={() => onRollback(revision.revision)}>Restore</button>}
        </div>)}
      </div>}

      <form className="character-add-form" onSubmit={add}>
        <label className="sr-only" htmlFor="character-kind">Preference type</label>
        <select id="character-kind" value={kind} onChange={(event) => setKind(event.target.value as CharacterPreferenceKind)}>
          <option value="taste">Taste</option>
          <option value="dislike">Dislike</option>
          <option value="opinion">Opinion</option>
        </select>
        <input value={text} onChange={(event) => setText(event.target.value)} maxLength={240} placeholder="Add a taste or an idea to explore…" aria-label="New character preference" />
        <label className="tentative-checkbox"><input type="checkbox" checked={tentative} onChange={(event) => setTentative(event.target.checked)} /> Try tentatively</label>
        <button type="submit" disabled={!text.trim() || profile.preferences.length >= MAX_PROFILE_ENTRIES}>Add</button>
      </form>
      <p className="character-notice" role="status" aria-live="polite">{notice || "Edits save in this browser. User feedback can revise or remove any preference."}</p>
    </section>
  );
}

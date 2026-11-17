"use client";

import { useEffect, useState } from "react";
import { normalizeUserProfile, PROFILE_LIMITS, type Pronouns, type UserProfile } from "@/lib/user-profile";

/**
 * Settings → Profile: who YOU are, for Freya to know (lib/user-profile). Lists are typed as
 * comma-separated words and kept as a list. Changes go out a moment after you stop typing.
 */
export default function UserProfileEditor({ profile, onChange, onTidyMemories, tidying = false, memoryCount = 0 }: {
  profile: UserProfile;
  onChange: (profile: UserProfile) => void;
  /** Rewrites her existing memories of you in her own words (once). */
  onTidyMemories?: () => void;
  tidying?: boolean;
  memoryCount?: number;
}) {
  const [draft, setDraft] = useState(() => toDraft(profile));
  useEffect(() => { setDraft(toDraft(profile)); }, [profile.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Saved a moment after the last keystroke, so every letter isn't a write to the account.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = normalizeUserProfile({ ...draft, hobbies: draft.hobbies, likes: draft.likes, dislikes: draft.dislikes });
      const before = normalizeUserProfile(profile);
      if (JSON.stringify({ ...next, updatedAt: 0 }) !== JSON.stringify({ ...before, updatedAt: 0 })) onChange({ ...next, updatedAt: Date.now() });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field: keyof Draft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  return (
    <div className="you-profile">
      <p className="settings-description">
        About you, for Freya to know. Her memories of you are written with your name and pronouns. Her own tastes and
        personality stay hers, saved in this browser and your account.
      </p>
      <label className="you-field">
        <span>Your name</span>
        <input value={draft.name} maxLength={PROFILE_LIMITS.name} onChange={(event) => set("name")(event.target.value)} placeholder="what she calls you" autoComplete="given-name" />
      </label>
      <label className="you-field">
        <span>Pronouns</span>
        <select value={draft.pronouns} onChange={(event) => set("pronouns")(event.target.value)}>
          <option value="">not set (they/them)</option>
          <option value="he">he/him</option>
          <option value="she">she/her</option>
          <option value="they">they/them</option>
        </select>
      </label>
      <label className="you-field">
        <span>About you</span>
        <textarea value={draft.about} maxLength={PROFILE_LIMITS.about} rows={3} onChange={(event) => set("about")(event.target.value)} placeholder="a few lines: what you do, what you're like" />
        <small>{PROFILE_LIMITS.about - draft.about.length} left</small>
      </label>
      <label className="you-field">
        <span>Hobbies</span>
        <input value={draft.hobbies} onChange={(event) => set("hobbies")(event.target.value)} placeholder="football, coding, anime" />
      </label>
      <label className="you-field">
        <span>Things you like</span>
        <input value={draft.likes} onChange={(event) => set("likes")(event.target.value)} placeholder="biryani, rainy nights, sci-fi" />
      </label>
      <label className="you-field">
        <span>Things you don&apos;t</span>
        <input value={draft.dislikes} onChange={(event) => set("dislikes")(event.target.value)} placeholder="early mornings, small talk" />
      </label>
      {onTidyMemories && memoryCount > 0 && (
        <div className="you-tidy">
          <p className="settings-description">
            Her {memoryCount} saved memories of you were written like a profile. Rewrite them as her own memories, and drop
            the jokes and roleplay she took literally.
          </p>
          <button type="button" className="small-primary" disabled={tidying} onClick={onTidyMemories}>
            {tidying ? "Rewriting…" : "Rewrite her memories of you"}
          </button>
        </div>
      )}
    </div>
  );
}

type Draft = { name: string; pronouns: Pronouns | ""; about: string; hobbies: string; likes: string; dislikes: string };

function toDraft(profile: UserProfile): Draft {
  return { name: profile.name, pronouns: profile.pronouns, about: profile.about, hobbies: profile.hobbies.join(", "), likes: profile.likes.join(", "), dislikes: profile.dislikes.join(", ") };
}

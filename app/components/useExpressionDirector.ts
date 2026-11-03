"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { directFace, initialDirector, offerCue, type Cue, type ExpressionIntensity, type Face, type Situation } from "@/lib/expression-director";

/**
 * FREYA's face for the portrait (lib/expression-director), kept in step with the conversation.
 * Re-renders only when the face would actually change: when a reaction ends, a mood settles,
 * or a slow reply turns into thinking.
 */
export function useExpressionDirector({ mood, activity, longMessage, deliberating, intensity }: Omit<Situation, "now" | "activitySince">): {
  face: Face;
  offer: (cue: Cue | null, options?: { force?: boolean }) => void;
} {
  const stateRef = useRef(initialDirector());
  const [now, setNow] = useState(() => Date.now());
  const [activitySince, setActivitySince] = useState(() => Date.now());
  const lastActivity = useRef(activity);
  useEffect(() => {
    if (lastActivity.current === activity) return;
    lastActivity.current = activity;
    const at = Date.now();
    setActivitySince(at);
    setNow(at);
  }, [activity]);

  const offer = useCallback((cue: Cue | null, options?: { force?: boolean }) => {
    if (!cue) return;
    const at = Date.now();
    const next = offerCue(stateRef.current, cue, at, options);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setNow(at);
  }, []);

  const { face, nextChangeAt } = directFace(stateRef.current, { now, mood, activity, activitySince, longMessage, deliberating, intensity });
  useEffect(() => {
    if (!Number.isFinite(nextChangeAt)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(50, nextChangeAt - Date.now() + 20));
    return () => window.clearTimeout(timer);
  }, [nextChangeAt]);
  // A new mood starts its settling clock from now, so its face waits rather than appearing at once.
  useEffect(() => { setNow(Date.now()); }, [mood.name, mood.since]);

  return { face, offer };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { directFace, initialDirector, moodMotion, offerCue, planGlance, type Cue, type ExpressionIntensity, type Face, type Glance, type MoodMotion, type Situation } from "@/lib/expression-director";

/**
 * FREYA's face for the portrait (lib/expression-director), kept in step with the conversation.
 * Re-renders only when the face would actually change: when a reaction ends, a mood settles,
 * or a slow reply turns into thinking. Also where she glances and how her head moves, from her
 * mood: a glance at a time, never while she's reacting to something or reading.
 */
export function useExpressionDirector({ mood, activity, longMessage, deliberating, intensity }: Omit<Situation, "now" | "activitySince" | "mood"> & {
  mood: Situation["mood"] & { energy?: number };
}): {
  face: Face;
  offer: (cue: Cue | null, options?: { force?: boolean }) => void;
  glance: Glance | null;
  motion: MoodMotion;
  /** The latest reaction and when it started (it may be over): the canvas answers each new one. */
  reaction: (Cue & { startedAt: number }) | null;
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

  // Glances: one at a time, held for a moment, then back to them.
  const [glance, setGlance] = useState<Glance | null>(null);
  const energyRef = useRef(mood.energy ?? 0.55);
  useEffect(() => { energyRef.current = mood.energy ?? 0.55; }, [mood.energy]);
  useEffect(() => {
    setGlance(null);
    if (intensity === "off" || activity === "reading") return;
    let timer = 0;
    const schedule = () => {
      const { glance: next, wait } = planGlance(mood.name, energyRef.current, { typing: activity === "typing" });
      timer = window.setTimeout(() => {
        const cue = stateRef.current.cue;
        // Reacting to something, she's looking at them: this glance is skipped.
        if (cue && Date.now() < cue.startedAt + cue.ms) { schedule(); return; }
        setGlance(next);
        timer = window.setTimeout(() => { setGlance(null); schedule(); }, next.ms);
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [mood.name, activity, intensity]);

  const motion = useMemo(() => moodMotion(mood.name, intensity), [mood.name, intensity]);
  return { face, offer, glance, motion, reaction: stateRef.current.cue };
}

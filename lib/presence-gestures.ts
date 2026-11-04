/**
 * How FREYA's presence moves beyond her mood's resting shape (app/components/EmotionCanvas):
 * springs kicked by what happens, and small habits of her mood.
 *
 *   REACTIONS  the face her portrait shows (lib/expression-director): a laugh bounces, surprise
 *              jolts, affection warms and leans in, sadness sinks, annoyance pulls back and shakes.
 *   MESSAGES   each message she sends runs a ring over the surface (one per bubble, as it posts).
 *   TYPING     their keystrokes make the surface shimmer and brighten, so she's visibly listening.
 *   A POKE     clicking her presence jolts it and sends a ring.
 *   HABITS     her mood's own idle moves, at irregular times: bored or tired she sighs, restless
 *              she wanders, excited she hops, annoyed she shakes, curious she leans in.
 * Mutable and allocation-free, because the canvas steps it every frame; pure apart from the dice
 * passed in, so the tests step it without a screen.
 */
import type { Expression } from "@/lib/expression";
import type { MoodName } from "@/lib/mood";

export type Gestures = {
  jolt: number; joltV: number;
  hop: number; hopV: number;
  sway: number; swayV: number;
  lean: number; leanV: number;
  sag: number;
  glow: number;
  warm: number;
  keys: number;
  laughUntil: number;
  shakeUntil: number;
  sighAt: number;
  wanderX: number; wanderY: number; wanderToX: number; wanderToY: number;
  pulse: number; pulseAge: number;
  nextHabitAt: number;
};

export const initialGestures = (): Gestures => ({
  jolt: 0, joltV: 0, hop: 0, hopV: 0, sway: 0, swayV: 0, lean: 0, leanV: 0, sag: 0, glow: 0, warm: 0, keys: 0,
  laughUntil: -1, shakeUntil: -1, sighAt: -99, wanderX: 0, wanderY: 0, wanderToX: 0, wanderToY: 0, pulse: 0, pulseAge: 9, nextHabitAt: 0,
});

function ring(g: Gestures, strength: number) {
  // A new ring only replaces one that has mostly faded, or is weaker.
  if (g.pulseAge > 0.6 || strength >= g.pulse) { g.pulse = strength; g.pulseAge = 0; }
}

/** A face she's just shown. `level` is how strongly (0..1); `t` is seconds. */
export function kickReaction(g: Gestures, expression: Expression, level: number, t: number) {
  const k = Math.max(0, Math.min(1, level));
  switch (expression) {
    case "laugh":
      g.hopV += 1.6 * k; g.joltV += 1.0 * k; g.glow = Math.max(g.glow, 0.35 * k); g.laughUntil = t + 0.6 + k; break;
    case "smile": g.hopV += 0.9 * k; g.glow = Math.max(g.glow, 0.22 * k); break;
    case "excited": g.hopV += 1.5 * k; g.joltV += 0.8 * k; g.glow = Math.max(g.glow, 0.3 * k); break;
    case "affectionate": g.joltV += 0.7 * k; g.leanV += 0.9 * k; g.warm = Math.max(g.warm, 0.7 * k); ring(g, 0.5 * k); break;
    case "sultry": g.leanV += 0.8 * k; g.warm = Math.max(g.warm, 0.5 * k); break;
    case "surprised": g.joltV += 4 * k; g.glow = Math.max(g.glow, 0.4 * k); break;
    case "curious": case "interested": g.leanV += 1.4 * k; g.swayV += 0.8 * k; break;
    case "confused": g.swayV += 2.0 * k; break;
    case "playful": g.swayV += 1.5 * k; g.hopV += 0.9 * k; break;
    case "confident": g.joltV += 0.6 * k; g.leanV += 0.5 * k; break;
    case "sad": g.sag = Math.max(g.sag, 0.9 * k); g.joltV -= 0.8 * k; break;
    case "annoyed": case "disgusted": g.leanV -= 1.5 * k; g.shakeUntil = t + 0.3 + 0.3 * k; break;
    case "tired": case "bored": g.sag = Math.max(g.sag, 0.6 * k); break;
    default: break; // thinking, reading and glances have their own movement
  }
}

/** One of her messages has just appeared. */
export function kickBeat(g: Gestures) {
  ring(g, 1);
  g.glow = Math.max(g.glow, 0.18);
  g.joltV += 0.5;
}

/** They typed a character. */
export function kickKey(g: Gestures) {
  g.keys = Math.min(1, g.keys + 0.22);
}

/** They clicked her presence. */
export function kickPoke(g: Gestures) {
  g.joltV += 1.8;
  g.glow = Math.max(g.glow, 0.3);
  ring(g, 1);
}

type Habit = "sigh" | "hop" | "wander" | "shake" | "lean" | "glow" | "recoil" | "tilt";
const HABITS: Record<MoodName, { every: [number, number]; habit: Habit; strength: number }> = {
  neutral: { every: [14, 26], habit: "tilt", strength: 0.6 },
  happy: { every: [7, 15], habit: "hop", strength: 1 },
  playful: { every: [4, 9], habit: "hop", strength: 1.1 },
  warm: { every: [8, 16], habit: "glow", strength: 1 },
  curious: { every: [6, 12], habit: "lean", strength: 1 },
  interested: { every: [8, 15], habit: "lean", strength: 0.8 },
  horny: { every: [8, 14], habit: "glow", strength: 0.8 },
  content: { every: [10, 20], habit: "glow", strength: 0.6 },
  excited: { every: [3, 7], habit: "hop", strength: 1.4 },
  bored: { every: [6, 14], habit: "sigh", strength: 1 },
  tired: { every: [8, 16], habit: "sigh", strength: 1.2 },
  restless: { every: [2.5, 6], habit: "wander", strength: 1 },
  melancholy: { every: [9, 18], habit: "sigh", strength: 0.9 },
  irritated: { every: [7, 14], habit: "shake", strength: 0.8 },
  sulking: { every: [8, 15], habit: "sigh", strength: 0.8 },
  annoyed: { every: [6, 12], habit: "shake", strength: 1 },
  disgusted: { every: [6, 12], habit: "recoil", strength: 1 },
};

/**
 * Her mood's habits, at irregular times. Only while she's idle or listening (`free`): thinking and
 * talking have their own movement. Returns the habit it just did, if any.
 */
export function moodHabit(g: Gestures, mood: MoodName, t: number, free: boolean, random = Math.random): Habit | null {
  const { every, habit, strength } = HABITS[mood] ?? HABITS.neutral;
  const next = () => t + every[0] + random() * (every[1] - every[0]);
  if (!free || g.nextHabitAt === 0) { g.nextHabitAt = Math.max(g.nextHabitAt, t + every[0] * 0.5); return null; }
  if (t < g.nextHabitAt) return null;
  g.nextHabitAt = next();
  const side = random() < 0.5 ? -1 : 1;
  switch (habit) {
    case "sigh": g.sighAt = t; break;
    case "hop": g.hopV += 1.2 * strength; break;
    case "wander": g.wanderToX = side * (0.05 + random() * 0.11) * strength; g.wanderToY = (random() * 2 - 1) * 0.07 * strength; break;
    case "shake": g.shakeUntil = t + 0.45 * strength; break;
    case "lean": g.leanV += 1.1 * strength; g.swayV += side * 0.6 * strength; break;
    case "glow": g.warm = Math.max(g.warm, 0.35 * strength); g.glow = Math.max(g.glow, 0.12 * strength); ring(g, 0.4 * strength); break;
    case "recoil": g.leanV -= 1.2 * strength; break;
    case "tilt": g.swayV += side * 0.7 * strength; break;
  }
  return habit;
}

/** Damped springs, stepped with semi-implicit Euler (stable at the canvas's capped 0.1 s step). */
function spring(position: number, velocity: number, stiffness: number, damping: number, dt: number): [number, number] {
  const v = velocity + (-stiffness * position - damping * velocity) * dt;
  return [position + v * dt, v];
}

export function stepGestures(g: Gestures, dt: number) {
  const step = Math.min(0.1, Math.max(0, dt));
  [g.jolt, g.joltV] = spring(g.jolt, g.joltV, 60, 7, step);
  [g.hop, g.hopV] = spring(g.hop, g.hopV, 70, 6, step);
  [g.sway, g.swayV] = spring(g.sway, g.swayV, 40, 4.5, step);
  [g.lean, g.leanV] = spring(g.lean, g.leanV, 25, 6, step);
  g.sag *= Math.exp(-step * 0.35);
  g.glow *= Math.exp(-step * 2.2);
  g.warm *= Math.exp(-step * 0.8);
  g.keys *= Math.exp(-step * 3);
  g.pulseAge += step;
  if (g.pulseAge > 3.5) g.pulse = 0;
  const follow = 1 - Math.exp(-step * 1.5);
  g.wanderX += (g.wanderToX - g.wanderX) * follow;
  g.wanderY += (g.wanderToY - g.wanderY) * follow;
  g.wanderToX *= Math.exp(-step * 0.25);
  g.wanderToY *= Math.exp(-step * 0.25);
}

export type GestureOffsets = { x: number; y: number; z: number; roll: number; scale: number; glow: number; warm: number; shimmer: number; pulse: number; pulseAge: number };

/** Where all of it puts the body now: an offset, a roll, a size, and light. */
export function gestureOffsets(g: Gestures, t: number): GestureOffsets {
  const sighT = t - g.sighAt;
  const swell = sighT >= 0 && sighT < 3.4 ? (sighT < 1.4 ? Math.sin((sighT / 1.4) * (Math.PI / 2)) : Math.max(0, 1 - (sighT - 1.4) / 2)) : 0;
  const exhale = sighT >= 1.4 && sighT < 3.4 ? Math.sin(((sighT - 1.4) / 2) * Math.PI) : 0;
  const laughing = Math.max(0, Math.min(1, (g.laughUntil - t) / 0.4));
  const shaking = Math.max(0, Math.min(1, (g.shakeUntil - t) / 0.2));
  return {
    x: g.wanderX,
    y: g.hop * 0.6 + Math.abs(Math.sin(t * 15)) * 0.035 * laughing + swell * 0.03 - exhale * 0.04 - g.sag * 0.12 + g.wanderY,
    z: g.lean * 0.6,
    roll: g.sway * 0.35 + Math.sin(t * 34) * 0.06 * shaking,
    scale: 1 + g.jolt * 0.45 + swell * 0.07 - g.sag * 0.06,
    glow: g.glow + g.keys * 0.12,
    warm: Math.min(1, g.warm),
    shimmer: g.keys,
    pulse: g.pulse,
    pulseAge: g.pulseAge,
  };
}

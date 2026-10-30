/**
 * FREYA's facial expression on the portrait, chosen from real signals, never at random:
 *   1. something just happened that a face reacts to (a request like "smile for me", their
 *      news, a joke, her own laugh): a short-lived reaction;
 *   2. she is working out a reply: thinking;
 *   3. otherwise her current (simulated) mood.
 *
 * POSES drive the procedural face rig (brows, mouth corners, lids, lips, head tilt, gaze).
 * When an image for an expression exists (see public/portrait/expressions/README.md), the
 * portrait crossfades to it and the pose only adds subtle motion on top. Pure, so tested.
 */
import type { MoodName } from "@/lib/mood";

export const EXPRESSIONS = ["neutral", "smile", "laugh", "curious", "surprised", "sad", "affectionate", "thinking", "confused", "confident"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** brow -1 furrowed..1 raised; smile -1 corners down..1 up; squint 0..1; tilt -1..1; lips 0..1 parted; gaze -1..1. */
export type Pose = { brow: number; smile: number; squint: number; tilt: number; lips: number; gazeX: number; gazeY: number };

export const POSES: Record<Expression, Pose> = {
  neutral: { brow: 0, smile: 0.05, squint: 0, tilt: 0, lips: 0, gazeX: 0, gazeY: 0 },
  smile: { brow: 0.15, smile: 0.6, squint: 0.3, tilt: 0.15, lips: 0, gazeX: 0, gazeY: 0 },
  laugh: { brow: 0.35, smile: 1, squint: 0.6, tilt: -0.35, lips: 0.45, gazeX: 0, gazeY: 0.15 },
  curious: { brow: 0.55, smile: 0.12, squint: 0, tilt: 0.55, lips: 0.05, gazeX: 0.1, gazeY: 0.05 },
  surprised: { brow: 1, smile: 0.05, squint: -0.3, tilt: -0.1, lips: 0.4, gazeX: 0, gazeY: 0.1 },
  sad: { brow: -0.25, smile: -0.45, squint: 0.15, tilt: 0.35, lips: 0, gazeX: -0.1, gazeY: -0.45 },
  affectionate: { brow: 0.2, smile: 0.45, squint: 0.45, tilt: 0.4, lips: 0.03, gazeX: 0, gazeY: 0 },
  thinking: { brow: -0.2, smile: 0, squint: 0.2, tilt: 0.25, lips: 0, gazeX: -0.55, gazeY: 0.45 },
  confused: { brow: -0.5, smile: -0.1, squint: 0.25, tilt: -0.5, lips: 0.05, gazeX: 0.15, gazeY: 0 },
  confident: { brow: 0.05, smile: 0.3, squint: 0.15, tilt: -0.1, lips: 0, gazeX: 0, gazeY: 0 },
};

const MOOD_EXPRESSION: Record<MoodName, Expression> = {
  playful: "smile",
  warm: "affectionate",
  curious: "curious",
  content: "neutral",
  excited: "smile",
  bored: "neutral",
  tired: "neutral",
  restless: "curious",
  melancholy: "sad",
  irritated: "confident",
  sulking: "sad",
};

export function moodExpression(mood: MoodName): Expression {
  return MOOD_EXPRESSION[mood] ?? "neutral";
}

export type Reaction = { expression: Expression; ms: number };

const REQUESTS: [RegExp, Expression][] = [
  [/\b(laugh|giggle)\b/, "laugh"],
  [/\b(smile|grin)\b/, "smile"],
  [/\b(surprised|shocked|astonished)\b/, "surprised"],
  [/\b(sad|cry|frown|upset)\b/, "sad"],
  [/\b(confused|puzzled)\b/, "confused"],
  [/\b(think(ing)?|pensive)\b/, "thinking"],
  [/\b(curious|intrigued)\b/, "curious"],
  [/\b(confident|smug|cocky)\b/, "confident"],
  [/\b(loving|affectionate|soft|cute)\b/, "affectionate"],
  [/\b(neutral|serious|straight)\b/, "neutral"],
];

/** "smile for me", "can you look surprised", "make a sad face": held for a few seconds. */
export function requestedExpression(text: string): Expression | null {
  const clean = text.toLowerCase();
  if (!/\b(smile|grin|laugh|giggle|look|make|show|give me|do|pull|face|expression)\b/.test(clean)) return null;
  if (!/^(can you|could you|will you|pls|please|now|ok|okay|freya,?)?\s*(smile|grin|laugh|giggle|look|make|show|give me|do|pull)\b|\b(face|expression)\b|\bfor me\b/.test(clean)) return null;
  for (const [pattern, expression] of REQUESTS) if (pattern.test(clean)) return expression;
  return null;
}

/** How a message from them lands on her face, briefly. */
export function reactionTo(text: string): Reaction | null {
  const requested = requestedExpression(text);
  if (requested) return { expression: requested, ms: 8000 };
  if (/\b(died|passed away|funeral|lost my|breakup|broke up|dumped|depressed|lonely|crying|cried|miss (him|her|them))\b/i.test(text)) return { expression: "sad", ms: 9000 };
  if (/\b(love you|miss(ed)? you|you'?re (sweet|cute|the best|amazing)|thank you so much)\b|❤|🥰|😘/i.test(text)) return { expression: "affectionate", ms: 6000 };
  if (/\b(omg|oh my god|no way|guess what|you won'?t believe|holy)\b|!!/i.test(text)) return { expression: "surprised", ms: 3500 };
  if (/\b(lmao|lmfao|rofl|hahaha+)\b|😂|🤣/i.test(text)) return { expression: "laugh", ms: 3500 };
  if (/\b(lol|haha|hehe)\b|😄|😆/i.test(text)) return { expression: "smile", ms: 4000 };
  if (/\?{2,}|\b(what do you mean|i don'?t get it|huh)\b/i.test(text)) return { expression: "confused", ms: 3500 };
  return null;
}

/** Her own message: laughing at her own joke shows on her face. */
export function reactionInReply(text: string): Reaction | null {
  if (/\b(haha+|hahaha|lmao)\b|😂|🤣/i.test(text)) return { expression: "laugh", ms: 3000 };
  if (/\b(lol|hehe)\b|😄|😊/i.test(text)) return { expression: "smile", ms: 3000 };
  return null;
}

export function chooseExpression(moodName: MoodName, thinking: boolean, reaction: (Reaction & { until: number }) | null, now = Date.now()): Expression {
  if (reaction && reaction.until > now) return reaction.expression;
  if (thinking) return "thinking";
  return moodExpression(moodName);
}

/** Expression image files: "smile.png", "smile-2.webp" (a variation). Anything else is ignored. */
export const EXPRESSION_FILE = /^(neutral|smile|laugh|curious|surprised|sad|affectionate|thinking|confused|confident)(?:-(\d{1,2}))?\.(png|jpe?g|webp)$/i;

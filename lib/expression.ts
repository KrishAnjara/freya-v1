/**
 * FREYA's facial expression on the portrait. It follows her mood, not the words in a message:
 *   1. they asked for a face ("smile for me"), or their own face on camera got a response: short-lived;
 *   2. she is reading their message: eyes down, flavoured by her mood;
 *   3. she is working out a reply: thinking;
 *   4. otherwise her current (simulated) mood, with glances away and back so she doesn't freeze.
 *
 * POSES drive the procedural face rig (brows, mouth corners, lids, lips, head tilt, gaze).
 * When an image for an expression exists (see public/portrait/expressions/README.md), the
 * portrait crossfades to it and the pose only adds subtle motion on top. Pure, so tested.
 */
import type { MoodName } from "@/lib/mood";

export const EXPRESSIONS = ["neutral", "smile", "playful", "laugh", "curious", "surprised", "sad", "affectionate", "thinking", "confused", "confident", "reading", "look-left", "look-right", "look-up", "look-down", "sultry", "sultry-thinking", "excited", "interested", "tired", "bored", "annoyed", "disgusted"] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/** brow -1 furrowed..1 raised; smile -1 corners down..1 up; squint 0..1; tilt -1..1; lips 0..1 parted; gaze -1..1. */
export type Pose = { brow: number; smile: number; squint: number; tilt: number; lips: number; gazeX: number; gazeY: number };

export const POSES: Record<Expression, Pose> = {
  neutral: { brow: 0, smile: 0.05, squint: 0, tilt: 0, lips: 0, gazeX: 0, gazeY: 0 },
  smile: { brow: 0.15, smile: 0.6, squint: 0.3, tilt: 0.15, lips: 0, gazeX: 0, gazeY: 0 },
  playful: { brow: 0.25, smile: 0.4, squint: 0.2, tilt: 0.2, lips: 0, gazeX: 0.3, gazeY: 0 },
  laugh: { brow: 0.35, smile: 1, squint: 0.6, tilt: -0.35, lips: 0.45, gazeX: 0, gazeY: 0.15 },
  curious: { brow: 0.55, smile: 0.12, squint: 0, tilt: 0.55, lips: 0.05, gazeX: 0.1, gazeY: 0.05 },
  surprised: { brow: 1, smile: 0.05, squint: -0.3, tilt: -0.1, lips: 0.4, gazeX: 0, gazeY: 0.1 },
  sad: { brow: -0.25, smile: -0.45, squint: 0.15, tilt: 0.35, lips: 0, gazeX: -0.1, gazeY: -0.45 },
  affectionate: { brow: 0.2, smile: 0.45, squint: 0.45, tilt: 0.4, lips: 0.03, gazeX: 0, gazeY: 0 },
  thinking: { brow: -0.2, smile: 0, squint: 0.2, tilt: 0.25, lips: 0, gazeX: -0.55, gazeY: 0.45 },
  confused: { brow: -0.5, smile: -0.1, squint: 0.25, tilt: -0.5, lips: 0.05, gazeX: 0.15, gazeY: 0 },
  confident: { brow: 0.05, smile: 0.3, squint: 0.15, tilt: -0.1, lips: 0, gazeX: 0, gazeY: 0 },
  reading: { brow: -0.05, smile: 0.03, squint: 0.2, tilt: 0.05, lips: 0, gazeX: 0, gazeY: -0.75 },
  "look-left": { brow: 0.05, smile: 0.05, squint: 0, tilt: 0.1, lips: 0, gazeX: -0.8, gazeY: 0 },
  "look-right": { brow: 0.05, smile: 0.05, squint: 0, tilt: -0.1, lips: 0, gazeX: 0.8, gazeY: 0 },
  "look-up": { brow: 0.2, smile: 0, squint: 0, tilt: 0.05, lips: 0, gazeX: 0.1, gazeY: 0.8 },
  "look-down": { brow: -0.05, smile: 0, squint: 0.25, tilt: 0.05, lips: 0, gazeX: 0, gazeY: -0.7 },
  sultry: { brow: 0.1, smile: 0.3, squint: 0.55, tilt: 0.2, lips: 0.04, gazeX: 0, gazeY: 0 },
  "sultry-thinking": { brow: 0.1, smile: 0.25, squint: 0.45, tilt: 0.25, lips: 0, gazeX: -0.5, gazeY: 0.35 },
  excited: { brow: 0.7, smile: 0.85, squint: 0.2, tilt: -0.15, lips: 0.2, gazeX: 0, gazeY: 0.05 },
  interested: { brow: 0.4, smile: 0.2, squint: 0, tilt: 0.3, lips: 0, gazeX: 0, gazeY: 0 },
  tired: { brow: -0.1, smile: 0, squint: 0.7, tilt: 0.2, lips: 0.02, gazeX: 0, gazeY: -0.25 },
  bored: { brow: -0.05, smile: -0.05, squint: 0.5, tilt: -0.15, lips: 0, gazeX: 0.3, gazeY: 0.1 },
  annoyed: { brow: -0.45, smile: -0.2, squint: 0.3, tilt: -0.1, lips: 0, gazeX: 0, gazeY: 0 },
  disgusted: { brow: -0.6, smile: -0.4, squint: 0.5, tilt: -0.3, lips: 0.05, gazeX: -0.2, gazeY: 0 },
};

/** Her faces in each mood. The first is her main one; the others are brief glances away from it. */
const MOOD_FACES: Record<MoodName, Expression[]> = {
  neutral: ["neutral", "look-left", "look-right", "look-up", "look-down"],
  happy: ["smile", "look-left", "look-right"],
  playful: ["playful", "look-left", "look-right"],
  warm: ["affectionate", "look-down", "look-left"],
  curious: ["curious", "look-up", "look-left"],
  interested: ["interested", "look-left", "look-right"],
  horny: ["sultry", "look-down", "look-left"],
  content: ["neutral", "look-left", "look-right"],
  excited: ["excited", "look-up", "look-right"],
  bored: ["bored", "look-up", "look-left", "look-right"],
  tired: ["tired", "look-down"],
  restless: ["curious", "look-left", "look-right", "look-up"],
  melancholy: ["sad", "look-down", "look-left"],
  irritated: ["confident", "look-up"],
  sulking: ["sad", "look-down"],
  annoyed: ["annoyed", "look-up"],
  disgusted: ["disgusted", "look-left"],
};
const READING_FACES: Partial<Record<MoodName, Expression[]>> = {
  playful: ["reading", "playful", "smile"],
  horny: ["reading", "sultry", "sultry-thinking"],
  warm: ["reading", "affectionate"],
  excited: ["reading", "smile", "excited"],
  interested: ["reading", "interested", "curious"],
  curious: ["reading", "curious"],
  tired: ["reading", "tired"],
  bored: ["reading", "bored"],
  melancholy: ["reading", "sad"],
  sulking: ["reading", "sad"],
  irritated: ["reading", "annoyed"],
  annoyed: ["reading", "annoyed"],
  disgusted: ["reading", "disgusted"],
};
const THINKING_FACES: Partial<Record<MoodName, Expression[]>> = {
  playful: ["playful"],
  excited: ["playful"],
  horny: ["sultry-thinking", "sultry"],
};

export function facePool(mood: MoodName): Expression[] {
  return MOOD_FACES[mood] ?? MOOD_FACES.neutral;
}

export function moodExpression(mood: MoodName): Expression {
  return facePool(mood)[0];
}

/** From her main face she glances somewhere at random; from a glance she comes back. */
export function nextFaceBeat(poolSize: number, beat: number, random: () => number = Math.random) {
  if (beat % poolSize !== 0 || poolSize < 2) return 0;
  return 1 + Math.floor(random() * (poolSize - 1));
}

/** A glance is brief, her main face holds for a while. */
export function faceBeatDelay(beat: number, random: () => number = Math.random) {
  return beat === 0 ? 25_000 + random() * 45_000 : 1500 + random() * 1500;
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

/** Only when they ask for a face. Everything else shows through her mood. */
export function reactionTo(text: string): Reaction | null {
  const requested = requestedExpression(text);
  return requested ? { expression: requested, ms: 8000 } : null;
}

export function chooseExpression(moodName: MoodName, thinking: boolean, reaction: (Reaction & { until: number }) | null, now = Date.now(), { beat = 0, reading = false }: { beat?: number; reading?: boolean } = {}): Expression {
  if (reaction && reaction.until > now) return reaction.expression;
  const pool = reading
    ? READING_FACES[moodName] ?? ["reading", "look-down"]
    // Playful or excited, she has the thinking-2 look while working out a reply.
    : thinking ? THINKING_FACES[moodName] ?? ["thinking", "look-up", "look-left"] : facePool(moodName);
  return pool[beat % pool.length];
}

/** Expression image files: "smile.png", "smile-2.webp" (a variation). Anything else is ignored. */
export const EXPRESSION_FILE = /^(neutral|smile|playful|laugh|curious|surprised|sad|affectionate|thinking|confused|confident|reading|look-left|look-right|look-up|look-down|sultry|sultry-thinking|excited|interested|tired|bored|annoyed|disgusted)(?:-(\d{1,2}))?\.(png|jpe?g|webp)$/i;

/** With no image for an expression, the closest face she does have. */
const IMAGE_FALLBACK: Partial<Record<Expression, Expression>> = {
  "sultry-thinking": "sultry", sultry: "playful", excited: "smile", interested: "curious", annoyed: "confident", disgusted: "confused",
  tired: "neutral", bored: "neutral",
};

/** A glance or reading with no image for it moves her eyes, and stays on the face she's showing. */
export const isGlance = (expression: Expression) => expression === "reading" || expression.startsWith("look-");

/** The images that can show this expression. Empty means the base portrait. */
export function imagesFor(expression: Expression, images: Partial<Record<Expression, string[]>>): string[] {
  for (let current: Expression | undefined = expression; current; current = IMAGE_FALLBACK[current]) {
    if (images[current]?.length) return images[current]!;
  }
  return isGlance(expression) ? [] : images.neutral ?? [];
}

/** One of the images, but not the one she's already showing. */
export function pickVariation(options: string[], shown: string, random: () => number = Math.random) {
  if (!options.length) return null;
  const others = options.filter((option) => option !== shown);
  const pool = others.length ? others : options;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * Which expression an image file shows. thinking-2.png is a playful side-eye smirk rather than a
 * thinking face, so it is the playful mood's image and never appears for ordinary thinking.
 */
export function expressionOfFile(name: string, variation?: string): Expression {
  const expression = name.toLowerCase() as Expression;
  return expression === "thinking" && variation === "2" ? "playful" : expression;
}

/**
 * FREYA's facial expressions on the portrait: the poses that drive the procedural face rig, the
 * faces someone can ask for ("smile for me"), and which expression photos exist. Which face she
 * shows, when and how strongly is decided by lib/expression-director, never at random.
 *
 * POSES drive the procedural face rig (brows, mouth corners, lids, lips, head tilt, gaze).
 * When an image for an expression exists (see public/portrait/expressions/README.md), the
 * portrait crossfades to it and the pose only adds subtle motion on top. Pure, so tested.
 */

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

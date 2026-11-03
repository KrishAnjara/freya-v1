/**
 * What the camera's face model reports, turned into one rough word. The numbers are how far each
 * facial muscle group has moved (MediaPipe blendshapes, 0..1), so this reads an expression, not a
 * feeling, and it can be wrong. It never identifies anyone. Pure, so it is tested directly.
 */
export const FACE_EXPRESSIONS = ["neutral", "smiling", "laughing", "surprised", "sad", "frowning"] as const;
export type FaceExpression = (typeof FACE_EXPRESSIONS)[number];

export function readFace(shapes: Record<string, number>): FaceExpression {
  const both = (name: string) => ((shapes[`${name}Left`] ?? 0) + (shapes[`${name}Right`] ?? 0)) / 2;
  const smile = both("mouthSmile");
  const jaw = shapes.jawOpen ?? 0;
  if (smile > 0.45 && jaw > 0.2) return "laughing";
  if (smile > 0.3) return "smiling";
  if (both("eyeWide") > 0.3 && (jaw > 0.15 || (shapes.browInnerUp ?? 0) > 0.4)) return "surprised";
  if ((shapes.browInnerUp ?? 0) > 0.35 && both("mouthFrown") > 0.08) return "sad";
  if (both("browDown") > 0.45) return "frowning";
  return "neutral";
}

const WORDS: Record<Exclude<FaceExpression, "neutral">, string> = {
  smiling: "smiling",
  laughing: "laughing",
  surprised: "surprised",
  sad: "a bit down",
  frowning: "annoyed or worried",
};

/** Requests are untrusted: only a known word gets through. */
export function normalizeSeen(value: unknown): FaceExpression | null {
  return (FACE_EXPRESSIONS as readonly unknown[]).includes(value) ? value as FaceExpression : null;
}

/** The prompt section. Built only from the fixed table above. */
export function seenSection(seen: FaceExpression | null, textingFirst = false) {
  if (!seen || seen === "neutral") return "";
  return `\n\nWHAT YOU CAN SEE (they've switched their camera on so you can see them; a rough read, and it can be wrong)\nThey look ${WORDS[seen]}. ${textingFirst ? "That's why you're texting them: say something about it, the way a person across a table would." : "Let it colour your reply if it fits, and mention it only now and then."} Never say "camera" or that you're analysing them.`;
}

/** Long enough on their face that a person would say something. */
const WORTH_MENTIONING: Partial<Record<FaceExpression, number>> = { sad: 12_000, frowning: 15_000, laughing: 5000, smiling: 20_000, surprised: 8000 };

export function faceWorthMentioning(expression: FaceExpression, heldMs: number) {
  const after = WORTH_MENTIONING[expression];
  return after !== undefined && heldMs >= after;
}

/** Her face answering theirs, straight away. */
export function mirrorExpression(expression: FaceExpression) {
  return ({ smiling: "smile", laughing: "laugh", surprised: "surprised", sad: "affectionate", frowning: "curious", neutral: null } as const)[expression];
}

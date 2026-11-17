/**
 * Her face for a picture of her. The image model edits from a reference photo, so a picture of
 * Freya (a selfie, a full-body shot, her somewhere) starts from one of her own portrait photos and
 * keeps her face. Which photo: the expression they asked for ("smiling", "sultry"), else the one her
 * mood shows, else her resting portrait. Server-only (reads the portrait files).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXPRESSION_FILE, expressionOfFile, imagesFor, type Expression } from "@/lib/expression";
import type { MoodName } from "@/lib/mood";

/** An expression named in the request. */
const ASKED: [RegExp, Expression][] = [
  [/\b(laugh\w*|giggl\w*|cracking up)\b/i, "laugh"],
  [/\b(sultry|sexy|seductive|flirty|flirt\w*|bedroom eyes|smoulder\w*|hot)\b/i, "sultry"],
  [/\b(smil\w*|grin\w*|happy|cheerful)\b/i, "smile"],
  [/\b(sad|crying|upset|teary|melancholy)\b/i, "sad"],
  [/\b(angry|annoyed|mad|pissed|grumpy|eye[- ]?roll)\b/i, "annoyed"],
  [/\b(surprised|shocked|amazed)\b/i, "surprised"],
  [/\b(thinking|thoughtful|pensive)\b/i, "thinking"],
  [/\b(playful|cheeky|teasing|smirk\w*|wink\w*)\b/i, "playful"],
  [/\b(confident|fierce|bold|serious)\b/i, "confident"],
  [/\b(sleepy|tired|just woke up)\b/i, "tired"],
  [/\b(bored)\b/i, "bored"],
  [/\b(excited|thrilled)\b/i, "excited"],
  [/\b(loving|affectionate|soft|tender)\b/i, "affectionate"],
  [/\b(curious)\b/i, "curious"],
];

/** The face each mood shows (as the portrait does, lib/expression-director). */
const MOOD_EXPRESSION: Record<MoodName, Expression> = {
  neutral: "neutral", happy: "smile", playful: "playful", warm: "affectionate", curious: "curious", interested: "interested",
  horny: "sultry", content: "smile", excited: "excited", bored: "bored", tired: "tired", restless: "curious", melancholy: "sad",
  irritated: "confident", sulking: "sad", annoyed: "annoyed", disgusted: "disgusted",
};

export function faceExpression(prompt: string, mood?: MoodName): Expression {
  for (const [pattern, expression] of ASKED) if (pattern.test(prompt)) return expression;
  return mood ? MOOD_EXPRESSION[mood] : "neutral";
}

const PORTRAIT_DIR = join(process.cwd(), "public", "portrait", "expressions");
const BASE_PORTRAIT = join(process.cwd(), "app", "static", "freya.png");

/**
 * Glances and reading are her eyes moving, not a face to build a whole picture from: those take
 * the nearest straight-on face instead.
 */
const STRAIGHT_ON: Partial<Record<Expression, Expression>> = { "sultry-thinking": "sultry", reading: "neutral", "look-left": "neutral", "look-right": "neutral", "look-up": "neutral", "look-down": "neutral" };

/**
 * The reference only has to show her face: the face pass reads it at 224 px. A 512 px JPEG is
 * ~40 KB, where the portrait PNG was ~1.6 MB of base64 on every picture request, through the tunnel.
 */
const REFERENCE_SIDE = 512;
const shrunk = new Map<string, string>();

async function smallCopy(path: string): Promise<string> {
  const known = shrunk.get(path);
  if (known) return known;
  const bytes = await readFile(path);
  let data = bytes.toString("base64");
  try {
    const sharp = (await import("sharp")).default;
    data = (await sharp(bytes).resize(REFERENCE_SIDE, REFERENCE_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()).toString("base64");
  } catch {
    // No sharp on this machine: the full photo still works, it's just bigger.
  }
  shrunk.set(path, data);
  return data;
}

/**
 * One of her photos for this expression, as base64 (a small JPEG). The photo gives the model her
 * face; the expression itself is also named in the prompt, so a near match is fine.
 */
export async function faceReference(expression: Expression, random = Math.random): Promise<string | null> {
  try {
    const files = await readdir(PORTRAIT_DIR).catch(() => [] as string[]);
    const grouped: Partial<Record<Expression, string[]>> = {};
    for (const file of files) {
      const match = file.match(EXPRESSION_FILE);
      if (match) (grouped[expressionOfFile(match[1], match[2])] ??= []).push(file);
    }
    for (let current: Expression | undefined = expression; current; current = STRAIGHT_ON[current]) {
      const choices = [...imagesFor(current, grouped)];
      if (choices.length) return await smallCopy(join(PORTRAIT_DIR, choices[Math.floor(random() * choices.length)]));
    }
    return await smallCopy(BASE_PORTRAIT);
  } catch {
    return null;
  }
}

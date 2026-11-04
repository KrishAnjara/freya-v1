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

/** A picture that's of her: "a selfie", "a pic of you at the beach", "you in a red dress". */
const OF_HER = /\b(selfie|freya)\b|\b(pic(ture)?|photo|image|shot|snap|one)s? of (you|u|yourself|urself)\b|\byour(self)? (face|body|outfit|look|selfie|pic|photo)\b|\b(you|u) (in|wearing|at|on|as|with|doing|posing|lying|sitting|standing|looking|dressed)\b|\b(show|send) (me )?(you|u|yourself)\b/i;

export function isPictureOfHer(prompt: string) {
  return OF_HER.test(prompt);
}

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
/** Small renders (glances, reading) aren't a good face to build a whole picture from. */
const MIN_REFERENCE_BYTES = 200_000;

/** When an expression's photos are only small renders, the nearest full-size face. */
const LARGER: Partial<Record<Expression, Expression>> = { sultry: "playful", "sultry-thinking": "playful", reading: "neutral", "look-left": "neutral", "look-right": "neutral", "look-up": "neutral", "look-down": "neutral" };

/**
 * One of her photos for this expression, as base64. The photo gives the model her face; the
 * expression itself is also named in the prompt, so a near match is fine.
 */
export async function faceReference(expression: Expression, random = Math.random): Promise<string | null> {
  try {
    const files = await readdir(PORTRAIT_DIR).catch(() => [] as string[]);
    const grouped: Partial<Record<Expression, string[]>> = {};
    for (const file of files) {
      const match = file.match(EXPRESSION_FILE);
      if (match) (grouped[expressionOfFile(match[1], match[2])] ??= []).push(file);
    }
    for (let current: Expression | undefined = expression; current; current = LARGER[current]) {
      for (const file of [...imagesFor(current, grouped)].sort(() => random() - 0.5)) {
        const bytes = await readFile(join(PORTRAIT_DIR, file));
        if (bytes.length >= MIN_REFERENCE_BYTES) return bytes.toString("base64");
      }
    }
    return (await readFile(BASE_PORTRAIT)).toString("base64");
  } catch {
    return null;
  }
}

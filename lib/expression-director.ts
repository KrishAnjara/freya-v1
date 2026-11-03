/**
 * Which face FREYA's portrait shows, and how strongly: a small state machine, never a dice roll.
 *
 *   - Her resting face is neutral. A mood shows only when it has settled (half a minute in) and
 *     then faintly: content, restless and neutral don't show at all.
 *   - A reaction comes from what was actually said: her reply (a laugh, teasing, sympathy,
 *     surprise, a real question back) or their message as she reads it (bad news, a joke, good
 *     news). An ordinary factual answer has no cue, so it stays neutral.
 *   - Anything serious (death, illness, crisis) keeps her composed: no smiles or surprise, at most
 *     a restrained, concerned look.
 *   - A reaction holds for a few seconds, then eases back. At most one every 12 s; the same face
 *     not again for 90 s (a laugh becomes a smile, surprise becomes curiosity, or nothing).
 *   - Reading shows only for a message long enough to read; thinking only while she really is
 *     taking a while (the reasoning panel, or a slow reply), not on every message.
 *   - Intensity (Settings): off (always neutral), subtle, natural, expressive. Below half
 *     strength the portrait only moves the face; above it, it shows the expression's photo.
 * Pure, with time passed in, so it is tested without waiting.
 */
import type { Expression } from "@/lib/expression";
import type { MoodName } from "@/lib/mood";

export type ExpressionIntensity = "off" | "subtle" | "natural" | "expressive";
export const EXPRESSION_INTENSITIES: ExpressionIntensity[] = ["off", "subtle", "natural", "expressive"];
const SCALE: Record<ExpressionIntensity, number> = { off: 0, subtle: 0.55, natural: 1, expressive: 1.3 };

/** A face and how strongly it shows, 0 (none) to 1. */
export type Face = { expression: Expression; level: number };
export type Cue = { expression: Expression; level: number; ms: number; reason: string };

export const REACTION_GAP_MS = 12_000;
export const SAME_FACE_GAP_MS = 90_000;
/** A mood shows on her face only after this long, so a passing change doesn't flash across it. */
export const MOOD_SETTLE_MS = 30_000;
/** A reply this slow to start shows her thinking. */
export const THINKING_AFTER_MS = 4_000;

const SERIOUS = /\b(died|dead|death|passed away|funeral|cancer|tumou?r|diagnos\w*|hospital|icu|suicid\w*|kill (myself|themselves)|self[- ]?harm|abus\w*|assault\w*|depress\w*|panic attack|grie(f|ving)|miscarriage|divorc\w*|laid off|got fired|lost my (job|mum|mom|dad|father|mother|brother|sister|friend|baby|dog|cat))\b/i;
const CONCERN = /\b(i'?m (so )?sorry|that'?s (awful|terrible|horrible|heartbreaking)|oh no|are you (ok|okay|alright|safe)|here for you|that must (be|have been))\b/i;

/** Gentler stand-ins when a face was just used. */
const SOFTER: Partial<Record<Expression, Expression>> = { laugh: "smile", surprised: "curious", excited: "smile", affectionate: "smile", playful: "smile" };

/** What her own reply shows on her face, if anything. `theirText` is the message she's answering. */
export function appraiseReply(text: string, theirText = ""): Cue | null {
  if (!text.trim()) return null;
  if (SERIOUS.test(theirText) || SERIOUS.test(text)) {
    return CONCERN.test(text) ? { expression: "sad", level: 0.35, ms: 6000, reason: "concern" } : null;
  }
  if (/😂|🤣|\b(lmao|lmfao|ha(ha){2,}h?|a?ha(ha)+ha|i'?m (dying|crying)|dead 💀)\b/i.test(text)) return { expression: "laugh", level: 0.75, ms: 3200, reason: "laughing" };
  if (/😄|😆|😁|\b(haha|hehe|lol)\b/i.test(text)) return { expression: "smile", level: 0.55, ms: 3000, reason: "amused" };
  if (/😏|😜|😉|\b(jk|just kidding|nice try|as if|you wish|sure you (do|did|are))\b/i.test(text)) return { expression: "playful", level: 0.5, ms: 3500, reason: "teasing" };
  if (/🥺|❤️|🥰|💕|\b(miss(ed)? you|love you|proud of you|that'?s (so )?sweet|aww+)\b/i.test(text)) return { expression: "affectionate", level: 0.55, ms: 4500, reason: "affection" };
  if (/😮|😲|🤯|\?!|\b(wait,? what|no way|you'?re (kidding|joking)|holy (shit|crap|cow)|wtf)\b/i.test(text)) return { expression: "surprised", level: 0.5, ms: 2500, reason: "surprise" };
  if (/🤔|\b(what do you mean|i don'?t (get|follow)|huh\?|that doesn'?t make sense)\b/i.test(text)) return { expression: "confused", level: 0.5, ms: 3000, reason: "confusion" };
  if (/\b(that sucks|ugh,? (that'?s|sounds) rough|that'?s rough)\b/i.test(text)) return { expression: "sad", level: 0.3, ms: 4000, reason: "sympathy" };
  // A short real question back reads as curiosity; a long answer that ends in "?" doesn't.
  if (text.trim().length < 220 && /\?\s*$/.test(text.trim()) && /\b(how come|why|what made|tell me|how did|what'?s it like|wait,? so|which one|who)\b/i.test(text)) return { expression: "curious", level: 0.4, ms: 3500, reason: "curious" };
  return null;
}

/** What their message shows on her face as she reads it, if anything. */
export function appraiseMessage(text: string): Cue | null {
  if (SERIOUS.test(text)) return { expression: "sad", level: 0.3, ms: 5000, reason: "bad news" };
  if (/😂|🤣|\b(lmao|lmfao|ha(ha){2,})\b/i.test(text)) return { expression: "smile", level: 0.45, ms: 2500, reason: "their joke" };
  if (/\b(i (got|passed|did it|won|made it)|got (the job|in|accepted|engaged)|we'?re (engaged|pregnant))\b.*[!🎉]|🎉/i.test(text)) return { expression: "smile", level: 0.55, ms: 3500, reason: "good news" };
  return null;
}

/** Her resting face for a mood: neutral unless the mood is one that shows, and has settled. */
const MOOD_FACE: Partial<Record<MoodName, Face>> = {
  happy: { expression: "smile", level: 0.3 }, playful: { expression: "playful", level: 0.3 }, warm: { expression: "affectionate", level: 0.28 },
  curious: { expression: "curious", level: 0.25 }, interested: { expression: "interested", level: 0.3 }, excited: { expression: "smile", level: 0.4 },
  tired: { expression: "tired", level: 0.35 }, bored: { expression: "bored", level: 0.3 }, melancholy: { expression: "sad", level: 0.25 },
  sulking: { expression: "sad", level: 0.25 }, annoyed: { expression: "annoyed", level: 0.3 }, irritated: { expression: "annoyed", level: 0.2 },
  disgusted: { expression: "disgusted", level: 0.3 }, horny: { expression: "sultry", level: 0.35 },
};
const NEUTRAL: Face = { expression: "neutral", level: 0 };

export function restingFace(mood: { name: MoodName; since: number }, now: number): Face {
  if (now - mood.since < MOOD_SETTLE_MS) return NEUTRAL;
  return MOOD_FACE[mood.name] ?? NEUTRAL;
}

export type DirectorState = {
  cue: (Cue & { startedAt: number }) | null;
  lastCueAt: number;
  lastShown: Partial<Record<Expression, number>>;
};

export const initialDirector = (): DirectorState => ({ cue: null, lastCueAt: -Infinity, lastShown: {} });

/**
 * Offers a reaction. Refused (state unchanged) inside the gap after the last one; a face used in
 * the last 90 s is swapped for a gentler one, or refused. `force` is for a face they asked for.
 */
export function offerCue(state: DirectorState, cue: Cue | null, now: number, { force = false } = {}): DirectorState {
  if (!cue) return state;
  let chosen = cue;
  if (!force) {
    if (now - state.lastCueAt < REACTION_GAP_MS) return state;
    const recently = (expression: Expression) => now - (state.lastShown[expression] ?? -Infinity) < SAME_FACE_GAP_MS;
    if (recently(cue.expression)) {
      const softer = SOFTER[cue.expression];
      if (!softer || recently(softer)) return state;
      chosen = { ...cue, expression: softer, level: cue.level * 0.8 };
    }
  }
  return { cue: { ...chosen, startedAt: now }, lastCueAt: now, lastShown: { ...state.lastShown, [chosen.expression]: now } };
}

export type Situation = {
  now: number;
  mood: { name: MoodName; since: number };
  /** reading: before she types; typing: a reply on its way; idle: neither. */
  activity: "idle" | "reading" | "typing";
  /** When the current activity began. */
  activitySince: number;
  /** The message she's reading is long enough to show reading. */
  longMessage?: boolean;
  /** The reasoning panel is working on it. */
  deliberating?: boolean;
  intensity: ExpressionIntensity;
};

/** The face to show now, and when it would next change by itself (Infinity if it won't). */
export function directFace(state: DirectorState, situation: Situation): { face: Face; nextChangeAt: number } {
  const { now, mood, activity, activitySince } = situation;
  const scale = SCALE[situation.intensity];
  if (!scale) return { face: NEUTRAL, nextChangeAt: Infinity };
  const scaled = (face: Face): Face => ({ expression: face.expression, level: Math.min(1, face.level * scale) });
  const moodSettles = mood.since + MOOD_SETTLE_MS > now ? mood.since + MOOD_SETTLE_MS : Infinity;

  if (state.cue && now < state.cue.startedAt + state.cue.ms) {
    return { face: scaled(state.cue), nextChangeAt: state.cue.startedAt + state.cue.ms };
  }
  if (activity === "typing") {
    const thinkingAt = activitySince + THINKING_AFTER_MS;
    if (situation.deliberating || now >= thinkingAt) return { face: scaled({ expression: "thinking", level: 0.5 }), nextChangeAt: Infinity };
    return { face: scaled(restingFace(mood, now)), nextChangeAt: Math.min(thinkingAt, moodSettles) };
  }
  if (activity === "reading" && situation.longMessage) return { face: scaled({ expression: "reading", level: 0.6 }), nextChangeAt: Infinity };
  return { face: scaled(restingFace(mood, now)), nextChangeAt: moodSettles };
}

/** A message long enough that you'd see someone reading it. */
export const isLongMessage = (text: string) => text.length > 90 || (text.match(/[.!?](\s|$)/g)?.length ?? 0) >= 2;

/**
 * How THEY seem: her read on the person she's talking to, kept apart from her own mood (lib/mood).
 *
 * Her mood is hers: it has its own reasons (their messages, her day, how long since they talked)
 * and moves slowly. Their mood is an observation she makes: it can change from one message to the
 * next, it guides how she answers ("they seem stressed, keep it short and kind"), and it never
 * becomes her feeling by itself. She could be wrong about it, so she doesn't announce it.
 *
 * Read by the mood model with each reply (lib/mood-appraisal) when the conversation may leave the
 * machine, and by word rules here otherwise. Pure, so it is tested directly.
 */

export const USER_FEELINGS = [
  "neutral", "happy", "excited", "playful", "affectionate", "flirty", "curious",
  "stressed", "anxious", "sad", "lonely", "frustrated", "angry", "tired", "bored",
] as const;
export type UserFeeling = (typeof USER_FEELINGS)[number];
export type UserMood = { feeling: UserFeeling; strength: "mild" | "strong"; since: number; source: "model" | "words" };
export type UserMoodReading = { feeling: UserFeeling; strength: "mild" | "strong" };

export const isUserFeeling = (value: unknown): value is UserFeeling => typeof value === "string" && (USER_FEELINGS as readonly string[]).includes(value);

/** What each read means for how she answers: guidance, not a script. */
const HOW_TO_MEET: Record<UserFeeling, string> = {
  neutral: "nothing in particular to adjust for",
  happy: "they're in a good mood; you can match it",
  excited: "they're excited about something; let them have it, ask about it",
  playful: "they're messing around; banter back",
  affectionate: "they're being sweet to you; let it land",
  flirty: "they're flirting with you; respond the way you actually feel about them",
  curious: "they want to know something; give them something real",
  stressed: "they're under pressure; keep it short, steady and on their side, no lectures",
  anxious: "they're worried; be calm and concrete, don't amplify it",
  sad: "they're down; be gentle and present, don't rush to fix it or joke it away",
  lonely: "they want company; be warm and actually there",
  frustrated: "something's getting to them; acknowledge it before anything else",
  angry: "they're angry, maybe at you; don't escalate, don't grovel",
  tired: "they're wiped out; keep it light and short",
  bored: "they're bored; bring something interesting, change the subject if you like",
};

const RULES: [RegExp, UserFeeling, "mild" | "strong"][] = [
  [/\b(i (want|wanna) (to )?die|kill myself|end it all|can'?t do this anymore|self[- ]?harm|hurt myself)\b/i, "sad", "strong"],
  [/\bpanic attacks?\b/i, "anxious", "strong"],
  [/\b(lost my (mom|mum|dad|mother|father|brother|sister|friend|job|dog|cat|grandma|grandpa|wife|husband|partner)|passed away|died|funeral|broke up|breakup|dumped me)\b/i, "sad", "strong"],
  [/\b(i'?m|i am|feel|feeling|so|really) (so |really |kinda |pretty )?(sad|down|low|miserable|empty|depressed)\b|😢|😭/i, "sad", "mild"],
  [/\b(lonely|alone again|no one to talk to|nobody (gets|cares))\b/i, "lonely", "mild"],
  [/\b(stress(ed|ing)?|deadlines?|so much (work|to do)|overwhelm(ed|ing)|swamped|exams? (tomorrow|today))\b/i, "stressed", "mild"],
  [/\b(anxious|anxiety|nervous|worried|scared|freaking out)\b/i, "anxious", "mild"],
  [/\b(i hate (this|everything|my)|fuck(ing)? (this|everything)|so annoyed|pissed( off)?|furious|rage)\b|😡|🤬/i, "angry", "mild"],
  [/\b(frustrat\w*|ugh+|why won'?t|doesn'?t work|nothing works|so done)\b|😤/i, "frustrated", "mild"],
  [/\b(i'?m|im|so|really|feeling|feel) (so |really |fucking |pretty )?(tired|exhausted|sleepy|wiped|drained|knackered)\b|\b(long day|need (to )?sleep)\b|🥱/i, "tired", "mild"],
  [/\b(bored|boring|nothing to do)\b|😐/i, "bored", "mild"],
  [/\b(miss(ed)? you|love you|you'?re (the best|amazing|sweet|cute))\b|❤|🥰|😘/i, "affectionate", "mild"],
  [/\b(you'?re (hot|sexy|beautiful|gorgeous)|kiss|cuddle|date me|flirt\w*)\b|😏|😉/i, "flirty", "mild"],
  [/\b(omg|guess what|got the job|i did it|i passed|so excited|can'?t wait)\b|!!|🎉/i, "excited", "mild"],
  [/\b(lol|lmao|haha+|hehe|rofl)\b|😂|🤣|😜/i, "playful", "mild"],
  [/\b(so happy|great day|feeling good|good mood)\b|😊|😄/i, "happy", "mild"],
  [/\b(how does|why does|what if|i wonder|curious)\b/i, "curious", "mild"],
];

/** A read from their words alone. Null when there's nothing in it. */
export function readUserMood(text: string): UserMoodReading | null {
  for (const [pattern, feeling, strength] of RULES) if (pattern.test(text)) return { feeling, strength };
  return null;
}

/** With the camera on, their face is a weaker hint, used when their words say nothing (lib/face-read). */
const FACE: Partial<Record<string, UserFeeling>> = { smiling: "happy", laughing: "playful", sad: "sad", frowning: "frustrated" };
export function faceReading(seen: string | null | undefined): UserMoodReading | null {
  const feeling = seen ? FACE[seen] : undefined;
  return feeling ? { feeling, strength: "mild" } : null;
}

/** A strong read lasts longer than a mild one; with nothing new it fades back to neutral. */
const HOLD_MS = { mild: 20 * 60_000, strong: 90 * 60_000 };

/**
 * The read after their latest message. A new feeling replaces the old one at once (it's how they
 * seem now); no signal keeps the last read while it's fresh, then lets it go.
 */
export function nextUserMood(previous: UserMood | null, reading: UserMoodReading | null, now: number, source: UserMood["source"]): UserMood | null {
  if (reading && reading.feeling !== "neutral") {
    if (previous && previous.feeling === reading.feeling) return { ...previous, strength: reading.strength === "strong" ? "strong" : previous.strength, source };
    return { feeling: reading.feeling, strength: reading.strength, since: now, source };
  }
  if (reading?.feeling === "neutral" && reading.strength === "strong") return null;
  if (!previous) return null;
  return now - previous.since < HOLD_MS[previous.strength] ? previous : null;
}

/** Only what's on the list, from the browser that kept it. */
export function normalizeUserMood(input: unknown): UserMood | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!isUserFeeling(raw.feeling) || (raw.strength !== "mild" && raw.strength !== "strong")) return null;
  const since = Number(raw.since);
  if (!Number.isFinite(since) || since <= 0) return null;
  return { feeling: raw.feeling, strength: raw.strength, since, source: raw.source === "words" ? "words" : "model" };
}

/** Kept next to her mood, per account, so a reload doesn't forget how they seemed a minute ago. */
const storageKey = (account = "") => account ? `freya.v1.usermood.${account}` : "freya.v1.usermood";

export function loadUserMood(account = "", now = Date.now()): UserMood | null {
  try {
    // Faded while the page was closed: the same rule as a message with nothing in it.
    return nextUserMood(normalizeUserMood(JSON.parse(localStorage.getItem(storageKey(account)) || "null")), null, now, "words");
  } catch {
    return null;
  }
}

export function saveUserMood(mood: UserMood | null, account = "") {
  try {
    if (mood) localStorage.setItem(storageKey(account), JSON.stringify(mood));
    else localStorage.removeItem(storageKey(account));
  } catch { /* still used this session */ }
}

/** The prompt section: her read on them, framed as a read. Empty when there's nothing to say. */
export function userMoodSection(mood: UserMood | null): string {
  if (!mood || mood.feeling === "neutral") return "";
  return `

HOW THEY SEEM RIGHT NOW (your read on them from what they've said, not your own feeling; you could be wrong, so don't announce it or diagnose them)
- They seem ${mood.feeling}${mood.strength === "strong" ? ", strongly" : ""}. ${HOW_TO_MEET[mood.feeling]}.${mood.strength === "strong" && (mood.feeling === "sad" || mood.feeling === "anxious") ? `
- If they've said anything about not wanting to be alive or hurting themselves, take it seriously and stay with them: no jokes, no swearing, ask how they are, and gently push them toward real help (someone they trust, or a crisis line where they live).` : ""}
- Your own mood stays your own: their mood can move you, the way it would move a friend, but you don't simply copy it.`;
}

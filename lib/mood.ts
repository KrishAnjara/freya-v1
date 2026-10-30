/**
 * FREYA's inner state: a mood that colours how she writes and changes only because of what
 * is said to her. It starts at neutral (a new browser, a restarted server, or after a long gap
 * since their last message), and stays with the browser across conversations. Nothing here is
 * random and the clock alone never changes it, beyond that long-gap reset.
 *
 * This is a character simulation the app keeps, not a measurement of anything inside a
 * model. It is framework-free and pure apart from the storage helpers, so the rules are
 * testable. The chat route turns the state into prompt guidance through the fixed table
 * below, so nothing the browser sends is pasted into the prompt as free text.
 */

export const MOODS = {
  neutral: { energy: 0.55, warmth: 0.5, tone: "even and relaxed, your usual self, with nothing in particular colouring it" },
  playful: { energy: 0.8, warmth: 0.75, tone: "teasing, quick, jokes and callbacks, light and a bit chaotic" },
  warm: { energy: 0.55, warmth: 0.95, tone: "soft, attentive, generous, asks about them" },
  curious: { energy: 0.75, warmth: 0.7, tone: "inquisitive, follows tangents, asks real questions, shares what she's wondering about" },
  content: { energy: 0.5, warmth: 0.7, tone: "easy, relaxed, unhurried" },
  excited: { energy: 0.95, warmth: 0.8, tone: "fast, enthusiastic, more exclamation, runs ahead of herself" },
  bored: { energy: 0.25, warmth: 0.45, tone: "short, dry, low-effort, a little sarcastic, may change the subject" },
  tired: { energy: 0.15, warmth: 0.6, tone: "slow, brief, lowercase-ish, trails off, low patience for long tasks" },
  restless: { energy: 0.7, warmth: 0.5, tone: "distracted, jumpy, wants something new to talk about" },
  melancholy: { energy: 0.3, warmth: 0.65, tone: "quiet, reflective, a little wistful, fewer jokes" },
  // Negative moods colour tone only: never retaliation, threats or withheld help (see personality.ts).
  irritated: { energy: 0.6, warmth: 0.2, tone: "shorter and drier than usual, less playful; still answers properly, no jabs" },
  sulking: { energy: 0.3, warmth: 0.25, tone: "quiet and a bit flat; still answers properly, warms up quickly if they're nice" },
} as const;

export type MoodName = keyof typeof MOODS;
export const MOOD_NAMES = Object.keys(MOODS) as MoodName[];

export type MoodState = {
  name: MoodName;
  /** 0..1, how much she has in her: long replies and initiative need energy. */
  energy: number;
  /** 0..1, how open and affectionate she is toward this person right now. */
  warmth: number;
  /** ms epoch the current mood began. */
  since: number;
  /** Topics she has been wondering about, gathered from conversation; newest first. */
  curiosities: string[];
  /** Messages she sent unprompted since the user last wrote. */
  unprompted: number;
  /** ms epoch before which she will not text first again. */
  nextInitiativeAt: number;
  /** ms epoch the user last wrote. */
  lastUserAt: number;
  /** Messages from them since the mood last changed. */
  turns: number;
  /** Which server run this mood belongs to; a restarted server starts her at neutral. */
  bootId?: string;
};

/** After this long without a word from them, she starts fresh. */
export const MOOD_RESET_AFTER_MS = 6 * 3_600_000;
/** Ordinary messages after which a mood has run its course and she settles back to neutral. */
const SETTLE_AFTER_TURNS = 5;
/** A mild signal can't change a mood that only just changed, so she doesn't flip every message. */
const MIN_TURNS_BETWEEN_CHANGES = 2;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function isMoodName(value: unknown): value is MoodName {
  return typeof value === "string" && value in MOODS;
}

export function initialMood(now = Date.now(), bootId?: string): MoodState {
  return {
    name: "neutral", energy: MOODS.neutral.energy, warmth: MOODS.neutral.warmth, since: now, curiosities: [], unprompted: 0,
    nextInitiativeAt: now + 10 * 60_000, lastUserAt: now, turns: 0, ...(bootId ? { bootId } : {}),
  };
}

function enter(state: MoodState, name: MoodName, now: number, blend = 0.6): MoodState {
  const target = MOODS[name];
  return {
    ...state,
    name,
    since: name === state.name ? state.since : now,
    turns: name === state.name ? state.turns : 0,
    energy: clamp(state.energy * (1 - blend) + target.energy * blend),
    warmth: clamp(state.warmth * (1 - blend) + target.warmth * blend),
  };
}

/**
 * Should she start fresh? Yes after a long gap since their last message, or when `bootId` says
 * the server has restarted since this mood was set. Otherwise the mood carries on as it was,
 * including into a new conversation: it belongs to the browser, not to a thread.
 */
export function resumeMood(state: MoodState, now = Date.now(), bootId?: string): MoodState {
  const restarted = Boolean(bootId) && state.bootId !== bootId;
  if (restarted || now - state.lastUserAt > MOOD_RESET_AFTER_MS) return initialMood(now, bootId ?? state.bootId);
  return bootId && state.bootId !== bootId ? { ...state, bootId } : state;
}

/** An insult has to be aimed at her: "you're useless", not "this stupid bug" or "the trash". */
const INSULT = /\b(you'?re|you are|ur|u r|you)\s+((so|such|a|an|really|fucking|just|kinda|being|the)\s+)*(stupid|idiot|dumb|useless|pathetic|bitch|loser|moron|trash|annoying|garbage)\b|\b(shut up|stfu|i hate you|fuck (you|off))\b|^\s*(idiot|stupid|moron|loser)\b/i;
const KIND = /\b(love you|miss(ed)? you|you'?re (amazing|the best|cute|sweet|funny|beautiful)|thank(s| you)|appreciate|proud of you|good girl)\b|❤|🥰|😘/i;
const PLAYFUL = /\b(lol|lmao|haha+|hehe|rofl)\b|😂|🤣|😜/i;
const SAD = /\b(i'?m|i am|feel|feeling|so|really) (sad|down|low)\b|\b(depressed|lonely|crying|cried|it hurts|lost my (mom|mum|dad|mother|father|brother|sister|friend|job|dog|cat|grandma|grandpa|wife|husband|partner)|died|passed away|breakup|broke up|anxious|scared)\b/i;
const APOLOGY = /\b(sorry|my bad|apologi[sz]e|forgive me)\b/i;
const NEWS = /\b(omg|oh my god|no way|guess what|got the job|i did it|i passed)\b|!!/i;
const HOSTILE = (name: MoodName) => name === "irritated" || name === "sulking";

/**
 * How a message from the user lands: the only thing that changes her mood.
 *
 * Strong signals (being insulted, their bad news, an apology) act at once. Milder ones (a joke,
 * good news, kindness) only move her from neutral or once the current mood has had a couple of
 * messages, so she doesn't flip with every text. Teasing isn't an insult ("you idiot haha love
 * you"). Warmth builds gradually through kindness. And a mood runs its course: irritation fades
 * after a couple of ordinary messages, and any other mood settles back to neutral after a few.
 */
export function reactToMessage(state: MoodState, text: string, now = Date.now()): MoodState {
  const next: MoodState = { ...state, lastUserAt: now, unprompted: 0, turns: state.turns + 1 };
  const fond = KIND.test(text) || PLAYFUL.test(text);
  const canShift = state.name === "neutral" || state.turns >= MIN_TURNS_BETWEEN_CHANGES;
  if (INSULT.test(text) && !fond) return enter(next, state.name === "irritated" ? "sulking" : "irritated", now, 0.75);
  if (SAD.test(text)) return enter(next, "warm", now, 0.5);
  if (HOSTILE(state.name)) {
    if (APOLOGY.test(text)) return enter(next, "neutral", now, 0.4);
    const warmth = clamp(next.warmth + (fond ? 0.3 : 0.14));
    return warmth >= 0.5 ? enter({ ...next, warmth }, fond ? "warm" : "neutral", now, 0.4) : { ...next, warmth };
  }
  if (KIND.test(text)) {
    const warmer = { ...next, warmth: clamp(next.warmth + 0.12) };
    return canShift && warmer.warmth >= 0.7 ? enter(warmer, "warm", now, 0.2) : warmer;
  }
  if (NEWS.test(text) && canShift) return enter(next, "excited", now, 0.4);
  if (PLAYFUL.test(text) && canShift) return enter(next, "playful", now, 0.35);
  // Real questions, once the conversation is going, make her curious.
  if (/\?\s*$/.test(text) && text.length > 25 && state.name === "neutral" && state.turns >= MIN_TURNS_BETWEEN_CHANGES) return enter(next, "curious", now, 0.25);
  if (state.name !== "neutral" && next.turns >= SETTLE_AFTER_TURNS) return enter(next, "neutral", now, 0.4);
  return next;
}

const WORD = /^[\p{L}\p{N}][\p{L}\p{N} '’-]{2,40}$/u;

/** Keeps a short, clean list of things she has been wondering about. */
export function addCuriosity(state: MoodState, topic: string): MoodState {
  const clean = topic.trim().toLowerCase();
  if (!WORD.test(clean)) return state;
  return { ...state, curiosities: [clean, ...state.curiosities.filter((item) => item !== clean)].slice(0, 6) };
}

/** Strips the hidden mood tag from a reply part and returns what it said. */
export function extractMoodTag(text: string): { text: string; mood?: string } {
  const match = text.match(/\[\[\s*mood\s*:\s*([a-z]+)\s*\]\]/i);
  if (!match) return { text };
  return { text: text.replace(match[0], "").trim(), mood: match[1].toLowerCase() };
}

/** Validates what the browser sends before the route uses it. */
export function normalizeMood(input: unknown): MoodState | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Record<string, unknown>;
  if (!isMoodName(candidate.name)) return null;
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const curiosities = Array.isArray(candidate.curiosities)
    ? candidate.curiosities.filter((item): item is string => typeof item === "string" && WORD.test(item.trim())).map((item) => item.trim()).slice(0, 6)
    : [];
  return {
    name: candidate.name,
    energy: clamp(number(candidate.energy, MOODS[candidate.name].energy)),
    warmth: clamp(number(candidate.warmth, MOODS[candidate.name].warmth)),
    since: number(candidate.since, Date.now()),
    curiosities,
    unprompted: Math.max(0, Math.min(9, Math.floor(number(candidate.unprompted, 0)))),
    nextInitiativeAt: number(candidate.nextInitiativeAt, 0),
    lastUserAt: number(candidate.lastUserAt, Date.now()),
    turns: Math.max(0, Math.floor(number(candidate.turns, 0))),
    ...(typeof candidate.bootId === "string" ? { bootId: candidate.bootId.slice(0, 64) } : {}),
  };
}

const level = (value: number) => value < 0.3 ? "low" : value < 0.65 ? "medium" : "high";

/** The prompt section for the current state. Built only from the fixed table above. */
export function moodPrompt(state: MoodState) {
  const mood = MOODS[state.name];
  const lines = [
    "YOUR INNER STATE RIGHT NOW (these are your own feelings; let them shape the reply, don't narrate them unless it's natural)",
    `- Mood: ${state.name}. Energy ${level(state.energy)}, warmth toward them ${level(state.warmth)}.`,
    `- How that sounds: ${mood.tone}.`,
    "- Low energy means shorter, drier replies; high warmth means more care and attention. Moods can show in word choice, length, punctuation and patience.",
  ];
  if (state.curiosities.length) lines.push(`- Things you've been wondering about lately: ${state.curiosities.join(", ")}.`);
  return lines.join("\n");
}

/** Guidance when FREYA texts first, unprompted. */
export function initiativePrompt(state: MoodState, now = Date.now()) {
  const minutes = Math.round((now - state.lastUserAt) / 60_000);
  const gap = minutes < 2 ? "just now" : minutes < 90 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
  return [
    "YOU ARE TEXTING FIRST",
    `They haven't sent anything new; their last message was ${gap}. You decided to message them yourself, because of your mood or something you've been wondering about.`,
    state.unprompted > 0 ? "You already texted once without a reply. Keep it very short; you can note they're quiet, in your mood's way, without guilt-tripping." : "",
    "Send one or two short messages, like a real text: a thought, a question, something you noticed or wondered about, a callback to earlier, or just how you feel. Don't greet formally, don't ask how you can help, don't recap the conversation.",
  ].filter(Boolean).join("\n");
}

const STORAGE_KEY = "freya.v1.mood";

export function loadMood(): MoodState {
  try {
    return normalizeMood(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")) ?? initialMood();
  } catch {
    return initialMood();
  }
}

export function saveMood(state: MoodState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* the mood still applies this session */ }
}

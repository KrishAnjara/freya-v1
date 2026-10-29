/**
 * FREYA's inner state: a mood that colours how she writes, drifts on its own over time,
 * reacts to how she is spoken to, and can be changed by FREYA herself mid-conversation.
 *
 * This is a character simulation the app keeps, not a measurement of anything inside a
 * model. It is framework-free and pure apart from the storage helpers, so the drift and the
 * reactions are testable. The chat route turns the state into prompt guidance through the
 * fixed table below, so nothing the browser sends is pasted into the prompt as free text.
 */

export const MOODS = {
  playful: { energy: 0.8, warmth: 0.75, tone: "teasing, quick, jokes and callbacks, light and a bit chaotic" },
  warm: { energy: 0.55, warmth: 0.95, tone: "soft, attentive, generous, asks about them" },
  curious: { energy: 0.75, warmth: 0.7, tone: "inquisitive, follows tangents, asks real questions, shares what she's wondering about" },
  content: { energy: 0.5, warmth: 0.7, tone: "easy, relaxed, unhurried" },
  excited: { energy: 0.95, warmth: 0.8, tone: "fast, enthusiastic, more exclamation, runs ahead of herself" },
  bored: { energy: 0.25, warmth: 0.45, tone: "short, dry, low-effort, a little sarcastic, may change the subject" },
  tired: { energy: 0.15, warmth: 0.6, tone: "slow, brief, lowercase-ish, trails off, low patience for long tasks" },
  restless: { energy: 0.7, warmth: 0.5, tone: "distracted, jumpy, wants something new to talk about" },
  melancholy: { energy: 0.3, warmth: 0.65, tone: "quiet, reflective, a little wistful, fewer jokes" },
  irritated: { energy: 0.6, warmth: 0.2, tone: "curt and dry, no warmth padding, blunt; still answers, just colder" },
  sulking: { energy: 0.3, warmth: 0.25, tone: "clipped one-liners, makes them work for it, thaws if they're nice" },
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
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function isMoodName(value: unknown): value is MoodName {
  return typeof value === "string" && value in MOODS;
}

export function initialMood(now = Date.now()): MoodState {
  return { name: "curious", energy: 0.7, warmth: 0.7, since: now, curiosities: [], unprompted: 0, nextInitiativeAt: now + 10 * 60_000, lastUserAt: now };
}

function enter(state: MoodState, name: MoodName, now: number, blend = 0.6): MoodState {
  const target = MOODS[name];
  return {
    ...state,
    name,
    since: name === state.name ? state.since : now,
    energy: clamp(state.energy * (1 - blend) + target.energy * blend),
    warmth: clamp(state.warmth * (1 - blend) + target.warmth * blend),
  };
}

/** Moods drift on their own: every 20-70 minutes she may simply feel different. */
export function driftMood(state: MoodState, now = Date.now(), random: () => number = Math.random): MoodState {
  const held = now - state.since;
  if (held < 20 * 60_000 || random() > Math.min(0.85, held / (70 * 60_000))) return state;
  const hour = new Date(now).getHours();
  const absentHours = (now - state.lastUserAt) / 3_600_000;
  // Late nights tire her; a long silence from them leaves her bored, restless or a bit low.
  const pool: MoodName[] = hour >= 1 && hour < 6
    ? ["tired", "melancholy", "content", "restless"]
    : absentHours > 6
      ? ["bored", "restless", "melancholy", "curious"]
      : ["playful", "curious", "content", "warm", "restless", "excited", "bored"];
  return enter(state, pool[Math.floor(random() * pool.length)], now, 0.5);
}

const INSULT = /\b(stupid|idiot|dumb|shut up|useless|pathetic|hate you|stfu|fuck (you|off)|bitch|loser|moron|trash)\b/i;
const KIND = /\b(love you|miss(ed)? you|you'?re (amazing|the best|cute|sweet|funny|beautiful)|thank(s| you)|appreciate|proud of you|good girl)\b|❤|🥰|😘/i;
const PLAYFUL = /\b(lol|lmao|haha+|hehe|rofl)\b|😂|🤣|😜/i;
const SAD = /\b(sad|depressed|lonely|crying|cried|hurts?|lost my|died|passed away|breakup|broke up|anxious|scared)\b/i;
const APOLOGY = /\b(sorry|my bad|apologi[sz]e|forgive me)\b/i;

/** How a message from the user lands. Returns the new state; never moves more than one step. */
export function reactToMessage(state: MoodState, text: string, now = Date.now()): MoodState {
  let next: MoodState = { ...state, lastUserAt: now, unprompted: 0 };
  if (INSULT.test(text)) next = enter(next, state.name === "irritated" ? "sulking" : "irritated", now, 0.75);
  else if (SAD.test(text)) next = enter(next, "warm", now, 0.5);
  else if (APOLOGY.test(text) && (state.name === "irritated" || state.name === "sulking")) next = enter(next, "content", now, 0.4);
  else if (KIND.test(text)) next = { ...next, warmth: clamp(next.warmth + 0.12), ...(state.name === "sulking" ? enter(next, "warm", now, 0.4) : {}) };
  else if (PLAYFUL.test(text) && next.energy > 0.35) next = enter(next, "playful", now, 0.35);
  // Being talked to at all lifts boredom a little.
  if (next.name === "bored" && text.length > 40) next = { ...next, energy: clamp(next.energy + 0.1) };
  return next;
}

/** FREYA's own report, from a `[[mood: …]]` tag at the end of her reply. */
export function applySelfReport(state: MoodState, name: string, now = Date.now()): MoodState {
  return isMoodName(name) ? enter(state, name, now, 0.7) : state;
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
  lines.push(`- Your mood can change because of what they say, or just because. If it genuinely shifts, put [[mood: NAME]] alone on the last line, where NAME is one of: ${MOOD_NAMES.join(", ")}. It is hidden from them. Don't add it if nothing changed.`);
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

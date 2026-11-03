/**
 * FREYA's inner state: a mood that colours how she writes. It's kept per account in the browser,
 * across conversations and server restarts. What they say moves it (lib/mood-appraisal reads the
 * conversation; the word rules here are the fallback, and all of Local-only and intimate chat). Time
 * moves it too: moods expire while they're away, she gets sad if they stay away, tires of very long
 * chats, and is glad when they come back. Nothing here is random.
 *
 * This is a character simulation the app keeps, not a measurement of anything inside a
 * model. It is framework-free and pure apart from the storage helpers, so the rules are
 * testable. The chat route turns the state into prompt guidance through the fixed table
 * below, so nothing the browser sends is pasted into the prompt as free text.
 */

import { isIntimateTone, mentionsMinors, soundsUpset } from "@/lib/intimacy";

export const MOODS = {
  neutral: { energy: 0.55, warmth: 0.5, tone: "even and relaxed, your usual self, with nothing in particular colouring it" },
  playful: { energy: 0.8, warmth: 0.75, tone: "teasing, quick, jokes and callbacks, light and a bit chaotic" },
  happy: { energy: 0.7, warmth: 0.8, tone: "in a good mood and glad to hear from them, lighter and quicker than usual, doesn't gush" },
  warm: { energy: 0.55, warmth: 0.95, tone: "soft, attentive, generous, asks about them" },
  curious: { energy: 0.75, warmth: 0.7, tone: "inquisitive, follows tangents, asks real questions, shares what she's wondering about" },
  interested: { energy: 0.75, warmth: 0.75, tone: "properly into what they're saying: leans in, remembers details, asks the next question, adds her own take" },
  // Only with the 18+ switch on, and only ever shown to the user's own model (see the chat route).
  horny: { energy: 0.85, warmth: 0.85, tone: "turned on and not hiding it: forward, teasing, keeps steering things back there" },
  content: { energy: 0.5, warmth: 0.7, tone: "easy, relaxed, unhurried" },
  excited: { energy: 0.95, warmth: 0.8, tone: "fast, enthusiastic, more exclamation, runs ahead of herself" },
  bored: { energy: 0.25, warmth: 0.45, tone: "short, dry, low-effort, a little sarcastic, may change the subject" },
  tired: { energy: 0.15, warmth: 0.6, tone: "slow, brief, lowercase-ish, trails off, low patience for long tasks" },
  restless: { energy: 0.7, warmth: 0.5, tone: "distracted, jumpy, wants something new to talk about" },
  melancholy: { energy: 0.3, warmth: 0.65, tone: "quiet, reflective, a little wistful, fewer jokes" },
  // Negative moods colour tone only: never retaliation, threats or withheld help (see personality.ts).
  irritated: { energy: 0.6, warmth: 0.2, tone: "shorter and drier than usual, less playful; still answers properly, no jabs" },
  sulking: { energy: 0.3, warmth: 0.25, tone: "quiet and a bit flat; still answers properly, warms up quickly if they're nice" },
  annoyed: { energy: 0.6, warmth: 0.35, tone: "clipped and exasperated, lets out a sigh or an eye-roll, says what's bugging her; still answers" },
  disgusted: { energy: 0.6, warmth: 0.45, tone: "grossed out and saying so, 'ew', wants a change of subject; can find it funny" },
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
  /** Messages since anything fed this mood. */
  quiet: number;
  /** Why she feels this way: a key of MOOD_REASONS, so it's never free text. */
  why?: MoodReason;
  /** The mood an upset interrupted, to go back to once it's over. */
  previous?: MoodName;
  /** Messages from them, ever. */
  talked: number;
  /** When this sitting began and how many messages it's had, for getting tired of a very long chat. */
  chatStart: number;
  chatMessages: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long each mood lasts with nobody talking to her, before it eases into the next. */
const EXPIRES_AFTER_MS: Partial<Record<MoodName, number>> = {
  horny: 30 * MINUTE, disgusted: 30 * MINUTE, annoyed: HOUR, excited: HOUR, irritated: 2 * HOUR, playful: 2 * HOUR, curious: 2 * HOUR, interested: 2 * HOUR,
  restless: 2 * HOUR, sulking: 3 * HOUR, happy: 3 * HOUR, warm: 4 * HOUR, content: 4 * HOUR, tired: 6 * HOUR, bored: 6 * HOUR,
};
/** Left this long, she's a bit sad about it. */
export const MISSED_AFTER_MS = 8 * HOUR;
/** Left this long, it's expired and she starts fresh. */
export const MOOD_RESET_AFTER_MS = 5 * 24 * HOUR;
/** A gap this long means they've come back, not just paused. */
const WELCOME_AFTER_MS: Partial<Record<MoodName, number>> = { bored: 5 * MINUTE, tired: 20 * MINUTE, neutral: 20 * MINUTE, content: 20 * MINUTE, restless: 20 * MINUTE, melancholy: 0 };
const VERY_PLEASED_AFTER_MS = 6 * HOUR;
/** A new sitting starts after this long. */
const CHAT_ENDS_AFTER_MS = 30 * MINUTE;
/** Past this in one sitting with nothing feeding her, she's had enough. */
const LONG_CHAT_MESSAGES = 70;
const LONG_CHAT_MS = 3 * HOUR;
/** Messages with nothing feeding a mood before it starts to ease. Anything that feeds it starts this again. */
const HOLD: Record<MoodName, number> = { neutral: 0, happy: 8, playful: 10, horny: 12, warm: 12, curious: 8, interested: 10, content: 8, excited: 6, bored: 6, tired: 10, restless: 6, melancholy: 8, irritated: 3, sulking: 3, annoyed: 4, disgusted: 3 };
/** Moods ease in steps rather than dropping straight to neutral. */
const EASES_TO: Partial<Record<MoodName, MoodName>> = { horny: "playful", excited: "happy", happy: "content", playful: "content", warm: "content", interested: "curious", curious: "content" };

export const MOOD_REASONS = {
  laughing: "they've been making you laugh",
  kind: "they've been kind to you",
  hurting: "they're going through something and you care",
  news: "they just told you something good",
  insulted: "they were rude to you",
  sorry: "they apologised, so you've let it go",
  interesting: "what they're talking about actually interests you",
  questions: "they got you thinking",
  tired: "they're wiped out and it's rubbing off on you",
  flirting: "they've been flirting with you and you like it",
  turnedOn: "they've turned you on",
  cooling: "the moment has passed and things have calmed down",
  pestered: "they keep pestering you",
  gross: "they just said something gross",
  boring: "they're giving you nothing to work with",
  back: "they came back and you're glad",
  missed: "you haven't heard from them in ages and you've noticed",
  longChat: "you've been talking for ages and you're running out of steam",
} as const;
export type MoodReason = keyof typeof MOOD_REASONS;
export type Appraisal = { mood: MoodName; strength: "none" | "mild" | "strong"; reason?: MoodReason };
/** A mild signal can't change a mood that only just changed, so she doesn't flip every message. */
const MIN_TURNS_BETWEEN_CHANGES = 2;

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function isMoodName(value: unknown): value is MoodName {
  return typeof value === "string" && value in MOODS;
}

export function initialMood(now = Date.now()): MoodState {
  return {
    name: "neutral", energy: MOODS.neutral.energy, warmth: MOODS.neutral.warmth, since: now, curiosities: [], unprompted: 0,
    nextInitiativeAt: now + 10 * 60_000, lastUserAt: now, turns: 0, quiet: 0, talked: 0, chatStart: now, chatMessages: 0,
  };
}

function enter(state: MoodState, name: MoodName, now: number, blend: number, why: MoodReason, previous?: MoodName): MoodState {
  const target = MOODS[name];
  return {
    ...state,
    name,
    since: name === state.name ? state.since : now,
    turns: name === state.name ? state.turns : 0,
    quiet: 0,
    why,
    previous,
    energy: clamp(state.energy * (1 - blend) + target.energy * blend),
    warmth: clamp(state.warmth * (1 - blend) + target.warmth * blend),
  };
}

/**
 * What time has done to her mood while they were away. Left alone a mood expires step by step, then
 * she misses them, and after long enough it's all expired and she starts fresh.
 */
export function resumeMood(state: MoodState, now = Date.now()): MoodState {
  const silent = now - state.lastUserAt;
  if (silent >= MOOD_RESET_AFTER_MS) return state.name === "neutral" ? state : enter(state, "neutral", now, 0.5, "cooling");
  let current = state;
  for (let step = 0; step < 6; step += 1) {
    const limit = EXPIRES_AFTER_MS[current.name];
    if (limit === undefined || silent < limit) break;
    current = enter(current, current.previous ?? EASES_TO[current.name] ?? "neutral", now, 0.3, "cooling");
  }
  if (current.name === "neutral" && current.talked > 0 && silent >= MISSED_AFTER_MS) return enter(current, "melancholy", now, 0.5, "missed");
  return current;
}

/**
 * A message has just arrived. Bored, sad or just idle, hearing from them after a while lifts her, rather
 * than resetting her to nothing. And a very long sitting with nothing in it eventually wears on her.
 * This is about their being here; what they said is judged afterwards and can still change it.
 */
export function arrive(state: MoodState, now = Date.now()): MoodState {
  const before = resumeMood(state, now);
  const gap = now - before.lastUserAt;
  const newChat = gap >= CHAT_ENDS_AFTER_MS || before.chatMessages === 0;
  const next: MoodState = {
    ...before, lastUserAt: now, unprompted: 0, talked: before.talked + 1,
    chatStart: newChat ? now : before.chatStart, chatMessages: newChat ? 1 : before.chatMessages + 1,
  };
  const welcome = WELCOME_AFTER_MS[before.name];
  if (before.talked > 0 && welcome !== undefined && gap >= welcome) {
    return enter(next, gap >= VERY_PLEASED_AFTER_MS || before.name === "melancholy" ? "excited" : "happy", now, 0.5, "back");
  }
  const worn = next.chatMessages >= LONG_CHAT_MESSAGES || now - next.chatStart >= LONG_CHAT_MS;
  if (worn && before.quiet >= 5 && (before.name === "neutral" || before.name === "content" || before.name === "curious" || before.name === "happy")) {
    return enter(next, "bored", now, 0.5, "longChat");
  }
  return next;
}

/** After a message: a mood with nothing feeding it for long enough eases on. */
function settle(state: MoodState, now: number) {
  return state.name !== "neutral" && state.quiet >= HOLD[state.name] ? enter(state, state.previous ?? EASES_TO[state.name] ?? "neutral", now, 0.3, "cooling") : state;
}

const SOURED = (name: MoodName) => name === "annoyed" || name === "disgusted" || name === "irritated" || name === "sulking";

/** What the mood model decided, with the same restraint: moods hold, and mild changes wait their turn. */
export function applyAppraisal(state: MoodState, { mood, strength, reason }: Appraisal, now = Date.now()): MoodState {
  const next: MoodState = { ...state, turns: state.turns + 1, quiet: (state.quiet ?? 0) + 1 };
  if (mood === state.name && strength !== "none") return { ...next, quiet: 0, why: reason ?? state.why };
  if (mood === state.name || strength === "none") return settle(next, now);
  if (strength === "mild" && state.name !== "neutral" && state.turns < MIN_TURNS_BETWEEN_CHANGES) return settle(next, now);
  const interrupted = !SOURED(mood) ? undefined : SOURED(state.name) ? state.previous : state.name === "neutral" ? undefined : state.name === "horny" ? "playful" : state.name;
  // Over it: she goes back to how she was, rather than to nothing.
  const target = mood === "neutral" && SOURED(state.name) ? state.previous ?? mood : mood;
  return enter(next, target, now, strength === "strong" ? 0.6 : 0.35, reason ?? "cooling", interrupted);
}

/** The server's verdict, leaving alone what the browser has noted since it asked. */
export function mergeVerdict(current: MoodState, verdict: MoodState): MoodState {
  const { name, energy, warmth, since, turns, quiet, why, previous } = verdict;
  return { ...current, name, energy, warmth, since, turns, quiet, why, previous };
}

/** An insult has to be aimed at her: "you're useless", not "this stupid bug" or "the trash". */
const INSULT = /\b(you'?re|you are|ur|u r|you)\s+((so|such|a|an|really|fucking|just|kinda|being|the)\s+)*(stupid|idiot|dumb|useless|pathetic|bitch|loser|moron|trash|annoying|garbage)\b|\b(shut up|stfu|i hate you|fuck (you|off))\b|^\s*(idiot|stupid|moron|loser)\b/i;
const KIND = /\b(love you|miss(ed)? you|you'?re (amazing|the best|cute|sweet|funny|beautiful)|thank(s| you)|appreciate|proud of you|good girl)\b|❤|🥰|😘/i;
const PLAYFUL = /\b(lol|lmao|haha+|hehe|rofl)\b|😂|🤣|😜/i;
const SAD = /\b(i'?m|i am|feel|feeling|so|really) (sad|down|low)\b|\b(depressed|lonely|crying|cried|it hurts|lost my (mom|mum|dad|mother|father|brother|sister|friend|job|dog|cat|grandma|grandpa|wife|husband|partner)|died|passed away|breakup|broke up|anxious|scared)\b/i;
const APOLOGY = /\b(sorry|my bad|apologi[sz]e|forgive me)\b/i;
const NEWS = /\b(omg|oh my god|no way|guess what|got the job|i did it|i passed)\b|!!/i;
const TIRED = /\b(i'?m|im|so|really|feeling|feel) (so |really |fucking |pretty )?(tired|exhausted|sleepy|wiped|drained|knackered)\b|\b(long day|going to bed|need (to )?sleep|can'?t keep my eyes open)\b/i;
const INTERESTING = /\b(books?|novel|philosoph\w*|psycholog\w*|history|physics|cyberpunk|privacy|poem|poetry|film|album|conspiracy|i'?ve been thinking|let me tell you|you won'?t believe|weird thing|funny story|so basically)\b/i;
const TURNED_ON = /\b(horny|turned on|turn(s|ing)? me on|fuck me|sex\w*|naked|want you|need you|moan\w*|aroused)\b|🥵/i;
const PESTERING = /\b(answer me|hurry up|reply to me|reply already|are you (even )?listening|you'?re not listening|stop ignoring|you didn'?t answer|that'?s not what i asked|why are you so slow)\b|\?{3,}|^\s*hello\s*\?+\s*$/i;
const GROSS = /\b(ew+|yuck|gross|disgusting|nasty|threw up|throw(ing)? up|puk(e|ed|ing)|vomit\w*|maggots?|diarrh\w+|pus|snot|boogers?|toenails?)\b|🤮|🤢/i;
/** Passing moods: when they're over she goes back to how she was. */
const SOUR = (name: MoodName) => name === "annoyed" || name === "disgusted";
const HOSTILE = (name: MoodName) => name === "irritated" || name === "sulking";

/**
 * How a message from the user lands: the only thing that changes her mood.
 *
 * Strong signals (being insulted, their bad news, an apology) act at once. Milder ones (a joke,
 * good news, kindness) only move her from neutral or once the current mood has had a couple of
 * messages, so she doesn't flip with every text. Teasing isn't an insult ("you idiot haha love
 * you"). Warmth builds gradually through kindness.
 *
 * A mood holds while it's being fed, and has a reason she knows. Left alone it eases in steps
 * (horny, playful, content, neutral) rather than dropping straight to neutral, and an insult only
 * interrupts: once that's over she goes back to how she was.
 *
 * With intimate roleplay switched on (`options.intimate`), flirting makes her playful and more of it,
 * or anything plainer, makes her horny. Without the switch she can't be, and being upset, saying no
 * or any mention of minors ends it at once.
 */
export function reactToMessage(state: MoodState, text: string, now = Date.now(), options: { intimate?: boolean } = {}): MoodState {
  const next: MoodState = { ...state, lastUserAt: now, unprompted: 0, turns: state.turns + 1, quiet: (state.quiet ?? 0) + 1 };
  const fond = KIND.test(text) || PLAYFUL.test(text);
  const canShift = state.name === "neutral" || state.turns >= MIN_TURNS_BETWEEN_CHANGES;
  const feeds = (name: MoodName) => canShift || state.name === name;
  const interrupted = HOSTILE(state.name) || SOUR(state.name) ? state.previous : state.name === "neutral" ? undefined : state.name === "horny" ? "playful" : state.name;
  if (INSULT.test(text) && !fond) {
    return enter(next, state.name === "irritated" ? "sulking" : "irritated", now, 0.75, "insulted", interrupted);
  }
  if (SAD.test(text)) return enter(next, "warm", now, 0.5, "hurting");
  if (state.name === "horny" && (!options.intimate || mentionsMinors(text) || soundsUpset(text))) {
    return options.intimate ? enter(next, mentionsMinors(text) ? "neutral" : "content", now, 0.5, "cooling") : enter(next, "playful", now, 0.3, "cooling");
  }
  if (TIRED.test(text) && !HOSTILE(state.name)) return enter(next, "tired", now, 0.5, "tired");
  if (options.intimate && isIntimateTone([text]) && !mentionsMinors(text) && !soundsUpset(text) && !HOSTILE(state.name)) {
    return TURNED_ON.test(text) || state.name === "playful" || state.name === "horny"
      ? enter(next, "horny", now, 0.4, "turnedOn")
      : enter(next, "playful", now, 0.35, "flirting");
  }
  if (HOSTILE(state.name)) {
    const back = state.previous;
    if (APOLOGY.test(text)) return enter(next, back ?? "neutral", now, 0.4, "sorry");
    const warmth = clamp(next.warmth + (fond ? 0.3 : 0.14));
    return warmth >= 0.5 ? enter({ ...next, warmth }, back ?? (fond ? "warm" : "neutral"), now, 0.4, fond ? "kind" : "cooling") : { ...next, warmth };
  }
  if (GROSS.test(text)) return enter(next, "disgusted", now, 0.5, "gross", interrupted);
  if (PESTERING.test(text)) return enter(next, "annoyed", now, 0.5, "pestered", interrupted);
  if (SOUR(state.name) && (APOLOGY.test(text) || fond)) return enter(next, state.previous ?? "neutral", now, 0.4, APOLOGY.test(text) ? "sorry" : "kind");
  if (KIND.test(text)) {
    const warmer = { ...next, warmth: clamp(next.warmth + 0.12), quiet: 0 };
    return feeds("warm") && warmer.warmth >= 0.7 ? enter(warmer, "warm", now, 0.2, "kind") : warmer;
  }
  if (NEWS.test(text) && feeds("excited")) return enter(next, "excited", now, 0.4, "news");
  if (PLAYFUL.test(text) && feeds("playful")) return enter(next, "playful", now, 0.35, "laughing");
  if ((INTERESTING.test(text) || text.length > 90) && feeds("interested")) return enter(next, "interested", now, 0.3, "interesting");
  // Real questions, once the conversation is going, make her curious.
  if (/\?\s*$/.test(text) && text.length > 25 && (state.name === "neutral" || state.name === "curious") && state.turns >= MIN_TURNS_BETWEEN_CHANGES) return enter(next, "curious", now, 0.25, "questions");
  return settle(next, now);
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
    quiet: Math.max(0, Math.floor(number(candidate.quiet, 0))),
    ...(typeof candidate.why === "string" && candidate.why in MOOD_REASONS ? { why: candidate.why as MoodReason } : {}),
    ...(isMoodName(candidate.previous) ? { previous: candidate.previous } : {}),
    talked: Math.max(0, Math.floor(number(candidate.talked, 0))),
    chatStart: number(candidate.chatStart, Date.now()),
    chatMessages: Math.max(0, Math.floor(number(candidate.chatMessages, 0))),
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
    ...(state.why ? [`- Why: ${MOOD_REASONS[state.why]}.`] : []),
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

/** Each account signed in on this browser has her own mood with them; no account shares one. */
const storageKey = (account = "") => account ? `freya.v1.mood.${account}` : "freya.v1.mood";

export function loadMood(account = ""): MoodState {
  try {
    return normalizeMood(JSON.parse(localStorage.getItem(storageKey(account)) || "null")) ?? initialMood();
  } catch {
    return initialMood();
  }
}

export function saveMood(state: MoodState, account = "") {
  try { localStorage.setItem(storageKey(account), JSON.stringify(state)); } catch { /* the mood still applies this session */ }
}

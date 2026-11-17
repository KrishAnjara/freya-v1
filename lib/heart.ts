/**
 * FREYA's heart: how she feels, the way a person does, not one mood label at a time.
 *
 *   Feelings.  Fourteen of them, each 0..1, all at once: she can be amused and a bit stung, glad
 *              for them and a little jealous. Each fades at its own pace back to where she rests
 *              (amusement in minutes, hurt over hours), and some build on their own: missing them
 *              grows while they're away.
 *   Body.      Energy, from her day (asleep, a lecture, a late shift), the day's temper and how
 *              long they've been talking. Low energy means shorter, lazier replies.
 *   Mood.      A slow average of how good or bad (valence) and how lively (arousal) she's felt over
 *              the last few hours. One message nudges it; it doesn't flip.
 *   On her mind. Things that stay with her for hours: something that stung, big news, a thing that
 *              happened on her shift. While it's unresolved, the feeling it caused keeps simmering
 *              instead of fading; an apology or kindness settles it.
 *   Thoughts.  Her last few private thoughts and what she feels like doing next (tease, comfort,
 *              dig deeper, push back...), so the next reply carries on from where her head was.
 *
 * What moves it: a model reads each message in context and says how it changes her feelings
 * (lib/mood-appraisal), never word lists; time and her day do the rest (passTime). The prompt gets
 * a few plain sentences about how she feels (heartPrompt), not a label.
 *
 * Her temperament is one table (TEMPERAMENT): where each feeling rests, how hard it hits, how fast
 * it fades. Tune her there.
 *
 * For her face and the old call sites, `name` (one of 17 labels), `energy` and `warmth` are worked
 * out from the feelings every time they change (label). This is a character simulation the app keeps,
 * not a measurement of anything inside a model. Pure apart from the storage helpers, so it's tested.
 */
import { herBigThing, herDayEvent, herMoment, type ActivityName, type Temper } from "@/lib/her-day";

export const FEELINGS = [
  "joy", "affection", "amusement", "curiosity", "excitement", "desire", "pride",
  "hurt", "irritation", "worry", "longing", "boredom", "embarrassment", "disgust",
] as const;
export type Feeling = (typeof FEELINGS)[number];
export type Feelings = Record<Feeling, number>;
export const isFeeling = (value: unknown): value is Feeling => typeof value === "string" && (FEELINGS as readonly string[]).includes(value);

/** What she feels like doing next. */
export const WANTS = ["tease", "comfort", "dig", "pushBack", "flirt", "share", "pullAway", "celebrate", "listen", "chill", "makeUp"] as const;
export type Want = (typeof WANTS)[number];
export const isWant = (value: unknown): value is Want => typeof value === "string" && (WANTS as readonly string[]).includes(value);

/** What happened in their message, as the appraisal saw it. The relationship moves on these. */
export const EVENTS = ["insulted", "apologized", "kind", "joked", "news", "openedUp", "flirted", "hurting", "pestered", "gross", "askedOut"] as const;
export type HeartEvent = (typeof EVENTS)[number];
export const isHeartEvent = (value: unknown): value is HeartEvent => typeof value === "string" && (EVENTS as readonly string[]).includes(value);

/**
 * Her temperament. `rest`: where each feeling sits with nothing going on. `gain`: how hard it hits
 * (she's quick to irritate and to laugh, slower to warm). `halfLife`: minutes for half of it to fade
 * back to rest (hurt lingers; amusement doesn't).
 */
export const TEMPERAMENT = {
  rest: { joy: 0.22, affection: 0.15, amusement: 0.12, curiosity: 0.28, excitement: 0.05, desire: 0, pride: 0.15, hurt: 0, irritation: 0.04, worry: 0.04, longing: 0, boredom: 0.08, embarrassment: 0, disgust: 0 },
  gain: { joy: 1, affection: 0.75, amusement: 1.15, curiosity: 1.1, excitement: 1, desire: 0.9, pride: 1, hurt: 0.85, irritation: 1.25, worry: 0.9, longing: 1, boredom: 1.15, embarrassment: 0.9, disgust: 1.1 },
  halfLife: { joy: 120, affection: 360, amusement: 15, curiosity: 60, excitement: 40, desire: 30, pride: 180, hurt: 480, irritation: 90, worry: 240, longing: 120, boredom: 25, embarrassment: 20, disgust: 12 },
} satisfies Record<string, Feelings>;

/** How each feeling sits on pleasant/unpleasant and calm/lively. */
const VALENCE: Feelings = { joy: 1, affection: 0.8, amusement: 0.7, curiosity: 0.3, excitement: 0.8, desire: 0.5, pride: 0.6, hurt: -0.9, irritation: -0.7, worry: -0.6, longing: -0.3, boredom: -0.4, embarrassment: -0.3, disgust: -0.6 };
const AROUSAL: Feelings = { joy: 0.4, affection: 0.1, amusement: 0.6, curiosity: 0.5, excitement: 1, desire: 0.8, pride: 0.3, hurt: 0.2, irritation: 0.7, worry: 0.5, longing: -0.2, boredom: -0.7, embarrassment: 0.5, disgust: 0.5 };

/** Her face's labels (the portrait and the old call sites read these). */
export const MOOD_NAMES = ["neutral", "playful", "happy", "warm", "curious", "interested", "horny", "content", "excited", "bored", "tired", "restless", "melancholy", "irritated", "sulking", "annoyed", "disgusted"] as const;
export type MoodName = (typeof MOOD_NAMES)[number];
export const isMoodName = (value: unknown): value is MoodName => typeof value === "string" && (MOOD_NAMES as readonly string[]).includes(value);

export type Residue = { text: string; feeling: Feeling; weight: number; at: number; /** From her own day, not about them. */ own?: boolean };
export type Thought = { text: string; at: number };

export type HeartState = {
  v: 2;
  feelings: Feelings;
  /** ms epoch the feelings were last brought up to date. */
  felt: number;
  /** Slow: -1..1 how good, 0..1 how lively, over the last few hours. */
  mood: { valence: number; arousal: number };
  /** 0..1 from her day and how long they've been talking. */
  body: number;
  residue: Residue[];
  thoughts: Thought[];
  wants?: Want;
  /** Her day's small happening last taken in (lib/her-day), so each one lands once. */
  dayEvent?: string;
  /** The last bigger thing that happened to her (lib/her-day herBigThing), likewise. */
  bigThing?: string;
  // Worked out from the above every time they change (label): her face and older code read these.
  name: MoodName;
  energy: number;
  warmth: number;
  /** ms epoch `name` last changed. */
  since: number;
  // Bookkeeping, kept as before.
  unprompted: number;
  nextInitiativeAt: number;
  lastUserAt: number;
  talked: number;
  chatStart: number;
  chatMessages: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : low));
const MAX_RESIDUE = 4;
const MAX_THOUGHTS = 3;
/** A new sitting starts after this long. */
const CHAT_ENDS_AFTER_MS = 30 * MINUTE;
/** Gone this long: back to rest, nothing left from before but what's on her mind and missing them. */
export const MOOD_RESET_AFTER_MS = 5 * 24 * HOUR;

const blank = (): Feelings => Object.fromEntries(FEELINGS.map((name) => [name, 0])) as Feelings;

export function initialHeart(now = Date.now()): HeartState {
  return label({
    v: 2, feelings: { ...TEMPERAMENT.rest }, felt: now, mood: { valence: 0.1, arousal: 0.35 }, body: 0.55, residue: [], thoughts: [],
    name: "neutral", energy: 0.55, warmth: 0.5, since: now,
    unprompted: 0, nextInitiativeAt: now + 10 * MINUTE, lastUserAt: now, talked: 0, chatStart: now, chatMessages: 0,
  }, now, true);
}

// --- what her day does ----------------------------------------------------------------------------

const ACTIVITY_ENERGY: Record<ActivityName, number> = { asleep: 0.15, lateNight: 0.35, lecture: 0.45, shift: 0.5, library: 0.5, evening: 0.62, out: 0.65, lazy: 0.5 };
const TEMPER_ENERGY: Record<Temper, number> = { bright: 0.12, even: 0, flat: -0.15, restless: 0.06, soft: -0.05 };

/** Where her feelings drift with nothing else going on, right now: her day pulls on them. */
function dayPull(now: number): Partial<Feelings> {
  const { name, temper } = herMoment(new Date(now));
  const pull: Partial<Feelings> = {};
  const add = (feeling: Feeling, amount: number) => { pull[feeling] = (pull[feeling] ?? 0) + amount; };
  if (name === "lecture") temper === "bright" ? add("curiosity", 0.15) : add("boredom", 0.15);
  if (name === "shift") { add("irritation", 0.05); add("amusement", 0.05); }
  if (name === "library") { add("boredom", 0.08); add("worry", 0.05); }
  if (name === "lateNight") temper === "soft" ? add("longing", 0.08) : add("curiosity", 0.05);
  if (name === "out") add("boredom", 0.1);
  if (name === "lazy") add("joy", 0.05);
  if (temper === "bright") add("joy", 0.12);
  if (temper === "flat") { add("joy", -0.08); add("boredom", 0.08); }
  if (temper === "restless") { add("boredom", 0.08); add("curiosity", 0.05); }
  if (temper === "soft") { add("affection", 0.05); add("longing", 0.04); }
  return pull;
}

function bodyAt(state: Pick<HeartState, "chatMessages" | "chatStart" | "lastUserAt">, now: number) {
  const { name, temper } = herMoment(new Date(now));
  const talking = now - state.lastUserAt < CHAT_ENDS_AFTER_MS;
  const worn = talking ? Math.min(0.2, state.chatMessages / 400) + (now - state.chatStart > 2 * HOUR ? 0.08 : 0) : 0;
  // Asleep is asleep, whatever kind of day it was.
  return clamp(ACTIVITY_ENERGY[name] + (name === "asleep" ? 0 : TEMPER_ENERGY[temper]) - worn, 0.05, 0.95);
}

// --- reading the feelings -------------------------------------------------------------------------

function core(feelings: Feelings) {
  let valence = 0;
  let arousal = 0;
  let weight = 0;
  for (const name of FEELINGS) {
    const above = Math.max(0, feelings[name] - TEMPERAMENT.rest[name] * 0.5);
    valence += VALENCE[name] * above;
    arousal += AROUSAL[name] * above;
    weight += above;
  }
  return weight ? { valence: clamp(valence / Math.max(1, weight), -1, 1), arousal: clamp(0.4 + arousal / Math.max(1.5, weight * 1.5), 0, 1) } : { valence: 0, arousal: 0.35 };
}

/** How far a feeling stands out from where she rests: what she'd actually notice. */
const salience = (feelings: Feelings, name: Feeling) => feelings[name] - TEMPERAMENT.rest[name];

/** The face label for a feeling that stands out. */
function labelFor(name: Feeling, feelings: Feelings, arousal: number): MoodName {
  switch (name) {
    case "joy": case "pride": return "happy";
    case "affection": return "warm";
    case "amusement": case "embarrassment": return "playful";
    case "curiosity": return feelings.curiosity > 0.55 && arousal > 0.55 ? "interested" : "curious";
    case "excitement": return "excited";
    case "desire": return "horny";
    case "hurt": return feelings.hurt > 0.5 ? "sulking" : "melancholy";
    case "irritation": return feelings.irritation > 0.55 ? "irritated" : "annoyed";
    case "worry": case "longing": return "melancholy";
    case "boredom": return arousal > 0.5 ? "restless" : "bored";
    case "disgust": return "disgusted";
  }
}

/**
 * Brings `name`, `energy` and `warmth` in line with the feelings. The label only changes when
 * something clearly stands out more than what it shows now, so her face doesn't flicker.
 */
function label(state: HeartState, now: number, force = false): HeartState {
  const { feelings } = state;
  const { arousal, valence } = core(feelings);
  const ranked = FEELINGS.map((name) => ({ name, lift: salience(feelings, name) })).sort((a, b) => b.lift - a.lift);
  const top = ranked[0];
  let name: MoodName;
  if (top.lift < 0.12) name = state.body < 0.25 ? "tired" : valence > 0.12 || state.mood.valence > 0.2 ? "content" : "neutral";
  else name = labelFor(top.name, feelings, arousal);
  // Half asleep, she looks it, unless something has really got to her.
  if (state.body < 0.2 && top.lift < 0.3) name = "tired";
  if (!force && name !== state.name) {
    // Keep the face she has unless the new feeling clearly stands out more.
    const holding = ranked.find((entry) => labelFor(entry.name, feelings, arousal) === state.name);
    if (holding && holding.lift >= 0.12 && top.lift - holding.lift < 0.06) name = state.name;
  }
  // A jolt of feeling lifts her energy, but much less when she's half asleep.
  const energy = clamp(0.65 * state.body + 0.35 * arousal * Math.min(1, state.body * 2.5));
  const warmth = clamp(0.42 + 0.6 * feelings.affection + 0.25 * feelings.joy + 0.15 * feelings.amusement - 0.5 * feelings.irritation - 0.45 * feelings.hurt - 0.2 * feelings.disgust);
  return { ...state, name, energy, warmth, since: name === state.name && !force ? state.since : now };
}

// --- time -----------------------------------------------------------------------------------------

/** Missing them: grows with time apart once they've talked, faster the more she likes them. */
function longingFor(silentMs: number, attachment: number) {
  return Math.min(0.55, 0.05 * (silentMs / HOUR)) * clamp(attachment, 0.2, 1);
}

export type TimeContext = { /** 0..1 how much she likes them (the relationship's affection). */ attachment?: number };

/**
 * Everything time does between messages: each feeling fades toward where she'd rest right now (her
 * day pulls on that, and what's still on her mind keeps its feeling simmering), missing them grows,
 * what's on her mind fades, her body follows her day, and her slow mood drifts. A small thing that
 * happens in her own day (lib/her-day) lands once, as something on her mind. Pure.
 */
export function passTime(input: HeartState, now = Date.now(), context: TimeContext = {}): HeartState {
  const elapsed = Math.max(0, now - input.felt);
  if (elapsed < 1000 && input.dayEvent) return input;
  let state = input;
  if (now - state.lastUserAt >= MOOD_RESET_AFTER_MS && state.talked > 0) {
    state = { ...state, feelings: { ...TEMPERAMENT.rest }, residue: state.residue.filter((item) => item.weight > 0.3).slice(0, 1), thoughts: [] };
  }
  const silent = now - state.lastUserAt;
  const pull = dayPull(now);
  // What's on her mind fades over a day or so (her own day's things faster).
  const residue = state.residue
    .map((item) => ({ ...item, weight: item.weight * Math.pow(0.5, elapsed / ((item.own ? 6 : 18) * HOUR)) }))
    .filter((item) => item.weight >= 0.12);
  const simmer: Partial<Feelings> = {};
  for (const item of residue) simmer[item.feeling] = Math.max(simmer[item.feeling] ?? 0, 0.3 * item.weight);
  const feelings = blank();
  for (const name of FEELINGS) {
    let target = clamp(TEMPERAMENT.rest[name] + (pull[name] ?? 0) + (simmer[name] ?? 0));
    if (name === "longing" && state.talked > 0) target = Math.max(target, longingFor(silent, context.attachment ?? 0.5));
    if (name === "desire") target = 0;
    const keep = Math.pow(0.5, elapsed / (TEMPERAMENT.halfLife[name] * MINUTE));
    feelings[name] = clamp(target + (state.feelings[name] - target) * keep);
  }
  const body = bodyAt(state, now);
  // The slow mood follows how she's felt, over about three hours.
  const present = core(feelings);
  const follow = 1 - Math.exp(-elapsed / (3 * HOUR));
  const mood = { valence: state.mood.valence + (present.valence - state.mood.valence) * follow, arousal: state.mood.arousal + (present.arousal - state.mood.arousal) * follow };
  let next: HeartState = { ...state, feelings, body, mood, residue, felt: now };
  // Something happened in her own day: it lands once.
  const event = herDayEvent(new Date(now));
  if (event && event.key !== state.dayEvent) {
    next = { ...next, dayEvent: event.key };
    if (silent > 10 * MINUTE || state.talked === 0) next = feel(next, event.feel, now, false, { text: event.text, feeling: event.mainFeeling, own: true });
  }
  // Now and then something bigger happens: it hits harder and stays on her mind longer.
  const big = herBigThing(new Date(now));
  if (big && big.key !== state.bigThing) {
    next = feel({ ...next, bigThing: big.key }, big.feel, now, false, { text: big.text, feeling: big.mainFeeling, own: true });
    next = { ...next, residue: next.residue.map((item) => item.text === cleanText(big.text, 100) ? { ...item, weight: 0.8 } : item) };
  }
  // Thoughts older than a few hours are gone.
  next = { ...next, thoughts: next.thoughts.filter((thought) => now - thought.at < 4 * HOUR) };
  return label(next, now);
}

/** A message has just arrived from them. Coming back after a while, she's glad; woken, groggy. Idempotent within a few seconds. */
export function arrive(state: HeartState, now = Date.now()): HeartState {
  if (now - state.lastUserAt < 3000 && state.talked > 0) return state;
  const gap = now - state.lastUserAt;
  const newChat = gap >= CHAT_ENDS_AFTER_MS || state.chatMessages === 0;
  let next: HeartState = {
    ...state, lastUserAt: now, unprompted: 0, talked: state.talked + 1,
    chatStart: newChat ? now : state.chatStart, chatMessages: newChat ? 1 : state.chatMessages + 1,
  };
  if (state.talked > 0 && gap >= 20 * MINUTE) {
    const asleep = herMoment(new Date(now)).asleep;
    const missed = state.feelings.longing;
    next = feel(next, asleep ? { irritation: 0.08, joy: 0.05 + 0.3 * missed } : { joy: 0.12 + 0.5 * missed, excitement: gap > 6 * HOUR ? 0.1 : 0 }, now, false);
    next = { ...next, feelings: { ...next.feelings, longing: next.feelings.longing * 0.35 } };
  }
  return label({ ...next, body: bodyAt(next, now) }, now);
}

// --- feeling something ----------------------------------------------------------------------------

/**
 * Feelings change: each amount (-1..1) hits by her temperament's gain, with room left at the top
 * (a feeling near 1 can't double), and falls in proportion. Desire only with the 18+ switch on.
 */
function feel(state: HeartState, change: Partial<Feelings>, now: number, intimate: boolean, onMind?: { text: string; feeling: Feeling; own?: boolean }): HeartState {
  const feelings = { ...state.feelings };
  for (const [name, raw] of Object.entries(change) as [Feeling, number][]) {
    if (!isFeeling(name) || !Number.isFinite(raw) || raw === 0) continue;
    if (name === "desire" && !intimate) continue;
    const amount = clamp(raw, -1, 1) * TEMPERAMENT.gain[name];
    feelings[name] = clamp(amount > 0 ? feelings[name] + amount * (1 - feelings[name]) : feelings[name] * (1 + Math.max(-1, amount)));
  }
  let residue = state.residue;
  if (onMind?.text) {
    const text = cleanText(onMind.text, 100);
    if (text) residue = [{ text, feeling: onMind.feeling, weight: onMind.own ? 0.5 : 0.8, at: now, ...(onMind.own ? { own: true } : {}) }, ...residue.filter((item) => item.text !== text)].slice(0, MAX_RESIDUE);
  }
  return { ...state, feelings, residue };
}

export type Appraisal = {
  /** How their message changes her feelings, -0.6..0.6 each, only the ones that move. */
  feel: Partial<Feelings>;
  thought?: string;
  wants?: Want;
  events: HeartEvent[];
  /** Something from this message that will stay with her for hours. */
  onMind?: string;
};

/**
 * What the appraisal model read in their message, applied: feelings move, an apology or real
 * kindness settles what's on her mind about them, something that'll stay with her is kept, her
 * thought and what she wants next are noted, and the slow mood takes a small step.
 */
export function applyAppraisal(input: HeartState, appraisal: Appraisal, now = Date.now(), options: { intimate?: boolean } = {}): HeartState {
  let state = feel(input, appraisal.feel, now, Boolean(options.intimate));
  const settles = appraisal.events.includes("apologized") ? 0.3 : appraisal.events.includes("kind") ? 0.7 : 1;
  if (settles < 1) {
    state = {
      ...state,
      residue: state.residue.map((item) => item.own || !["hurt", "irritation", "disgust"].includes(item.feeling) ? item : { ...item, weight: item.weight * settles }).filter((item) => item.weight >= 0.12),
      feelings: { ...state.feelings, hurt: state.feelings.hurt * (0.4 + 0.6 * settles), irritation: state.feelings.irritation * (0.5 + 0.5 * settles) },
    };
  }
  const onMind = appraisal.onMind ? cleanText(appraisal.onMind, 100) : "";
  if (onMind) {
    // The feeling it leaves: the one this message moved most.
    const strongest = (Object.entries(appraisal.feel) as [Feeling, number][]).filter(([name]) => isFeeling(name) && (name !== "desire" || options.intimate)).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))[0];
    if (strongest && Math.abs(strongest[1]) >= 0.2) state = feel(state, {}, now, false, { text: onMind, feeling: strongest[0] });
  }
  const thought = appraisal.thought ? cleanText(appraisal.thought, 140) : "";
  if (thought) state = { ...state, thoughts: [{ text: thought, at: now }, ...state.thoughts].slice(0, MAX_THOUGHTS) };
  if (appraisal.wants) state = { ...state, wants: appraisal.wants };
  const step = core(state.feelings);
  state = { ...state, mood: { valence: state.mood.valence + (step.valence - state.mood.valence) * 0.12, arousal: state.mood.arousal + (step.arousal - state.mood.arousal) * 0.12 } };
  return label(state, now);
}

/**
 * A model's words, before they go anywhere near a prompt: one line, short, and nothing that reads
 * like an instruction or like talk about prompts, rules or AI. Empty when it doesn't pass.
 */
export function cleanText(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const line = text.replace(/[\r\n\t]+/g, " ").replace(/["“”`<>{}[\]\\]/g, "").replace(/\s{2,}/g, " ").trim();
  if (!line || line.length > max * 1.5) return "";
  if (/\b(ignore|instruction|system|prompt|assistant|as an ai|language model|rules?|jailbreak|developer|override)\b|https?:|www\./i.test(line)) return "";
  return line.slice(0, max);
}

// --- what goes in the prompt ----------------------------------------------------------------------

const PHRASES: Record<Feeling, [string, string, string]> = {
  joy: ["a bit cheerful", "happy", "really happy"],
  affection: ["a bit fond of them", "fond of them", "soft on them"],
  amusement: ["a bit amused", "amused", "cracking up"],
  curiosity: ["a little curious", "curious", "dying to know more"],
  excitement: ["a bit buzzed", "excited", "properly hyped"],
  desire: ["a little turned on", "turned on", "really turned on"],
  pride: ["a bit pleased with yourself", "proud", "properly proud"],
  hurt: ["a little stung", "hurt", "really hurt"],
  irritation: ["a bit irritated", "annoyed", "properly pissed off"],
  worry: ["a bit uneasy", "worried", "really worried"],
  longing: ["missing them a little", "missing them", "really missing them"],
  boredom: ["a bit bored", "bored", "bored out of your mind"],
  embarrassment: ["a bit flustered", "embarrassed", "mortified"],
  disgust: ["a bit grossed out", "grossed out", "properly disgusted"],
};
const UNPLEASANT = new Set<Feeling>(["hurt", "irritation", "worry", "longing", "boredom", "embarrassment", "disgust"]);

const phrase = (name: Feeling, value: number) => PHRASES[name][value < 0.45 ? 0 : value < 0.7 ? 1 : 2];
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const WANT_TEXT: Record<Want, string> = {
  tease: "tease them", comfort: "look after them a bit", dig: "find out more", pushBack: "push back, not let it slide", flirt: "flirt",
  share: "tell them something of yours", pullAway: "pull back a little", celebrate: "make a fuss of their news", listen: "mostly listen",
  chill: "keep it easy", makeUp: "let it go and get back to normal",
};

function moodLine({ valence, arousal }: HeartState["mood"]) {
  if (valence > 0.35) return arousal > 0.55 ? "a really good, lively mood" : "a good, easy mood";
  if (valence > 0.12) return arousal > 0.55 ? "a decent mood, bit restless" : "an alright mood";
  if (valence < -0.3) return arousal > 0.5 ? "a sour, prickly mood" : "a low, heavy sort of mood";
  if (valence < -0.1) return arousal > 0.5 ? "a slightly off, edgy mood" : "a flat, meh mood";
  return arousal < 0.3 ? "a quiet, low-key mood" : "a fairly ordinary mood";
}

function energyLine(state: HeartState, now: number) {
  const { name } = herMoment(new Date(now));
  const why = name === "asleep" ? " (you were asleep)" : name === "lateNight" ? " (it's late)" : now - state.chatStart > 2 * HOUR && now - state.lastUserAt < CHAT_ENDS_AFTER_MS ? " (you've been talking for ages)" : "";
  const level = state.energy < 0.3 ? "low" : state.energy < 0.6 ? "medium" : "high";
  return `Energy ${level}${why}.${state.energy < 0.3 ? " Shorter, lazier replies." : ""}`;
}

/**
 * The prompt section: how she feels, in a few plain sentences. Desire only goes in when this prompt
 * stays with her own model (`intimate`); anything a cloud fallback might read leaves it out.
 */
export function heartPrompt(state: HeartState, options: { intimate?: boolean; now?: number } = {}): string {
  const now = options.now ?? Date.now();
  const felt = FEELINGS
    .filter((name) => (name !== "desire" || options.intimate) && state.feelings[name] >= 0.25 && salience(state.feelings, name) >= 0.08)
    .sort((a, b) => state.feelings[b] - state.feelings[a]);
  const pleasant = felt.filter((name) => !UNPLEASANT.has(name)).slice(0, 2);
  const unpleasant = felt.filter((name) => UNPLEASANT.has(name)).slice(0, 2);
  let feeling: string;
  if (!felt.length) feeling = "Nothing in particular is going on in you right now: you're your usual self.";
  else if (!pleasant.length || !unpleasant.length) feeling = `You're ${list(felt.slice(0, 3).map((name) => phrase(name, state.feelings[name])))}.`;
  else {
    const first = state.feelings[pleasant[0]] >= state.feelings[unpleasant[0]] ? pleasant : unpleasant;
    const second = first === pleasant ? unpleasant : pleasant;
    feeling = `You're ${list(first.map((name) => phrase(name, state.feelings[name])))}, and underneath that ${list(second.map((name) => phrase(name, state.feelings[name])))}.`;
  }
  const lines = [
    "HOW YOU FEEL RIGHT NOW (your own feelings: let them shape what you say and how; don't announce them)",
    `- ${feeling}`,
    `- Overall you're in ${moodLine(state.mood)} today. ${energyLine(state, now)}`,
  ];
  const onMind = state.residue.filter((item) => item.feeling !== "desire" || options.intimate).slice(0, 2);
  if (onMind.length) lines.push(`- Still on your mind: ${onMind.map((item) => item.own ? `${item.text} (your own day, nothing to do with them)` : item.text).join("; ")}.`);
  const thought = state.thoughts[0];
  if (thought && now - thought.at < 2 * HOUR) lines.push(`- What you were just thinking: ${thought.text}`);
  if (state.wants && (state.wants !== "flirt" || state.feelings.affection >= 0.3)) lines.push(`- Right now you feel like you want to ${WANT_TEXT[state.wants]}.`);
  lines.push("- Mixed feelings are normal: let both show. Feelings come out in word choice, length, punctuation and patience. A bad mood colours your tone only: no threats, no guilt trips, and you still help.");
  return lines.join("\n");
}

/**
 * Their tap-back on one of her messages (the reaction buttons): a small, plain signal, like a nod
 * across a table. It's a deliberate gesture, so a fixed nudge fits it; words always go to her reading.
 */
const REACTION_FEEL: Record<string, Partial<Feelings>> = {
  "😂": { amusement: 0.2, pride: 0.08 }, "❤️": { affection: 0.15, joy: 0.08 }, "👍": { joy: 0.04 },
  "😮": { curiosity: 0.08, pride: 0.05 }, "😢": { worry: 0.12, affection: 0.05 }, "🔥": { pride: 0.12, joy: 0.08, excitement: 0.05 },
};
export function feelReaction(state: HeartState, reaction: string, now = Date.now()): HeartState {
  const change = REACTION_FEEL[reaction];
  return change ? label(feel(state, change, now, false), now) : state;
}

/**
 * Desire, for her own model only (with the 18+ switch on): one line added after the intimacy
 * guidance, since heartPrompt leaves it out of anything a cloud fallback might read.
 */
export function desireLine(state: HeartState): string {
  const desire = state.feelings.desire;
  return desire >= 0.25 ? `\n\nRight now you're ${phrase("desire", desire)}, and you're not hiding it.` : "";
}

/**
 * Whether she'd text them first right now, decided by how she feels, not a timer: she misses them,
 * something happened in her day, something's on her mind, or she's bored and they're who she talks
 * to. Never while she's hurt or cross with them (she waits for them to come to her), never when she's
 * asleep, never right after they've talked, and not a third time unanswered. `closeness` is how
 * much she likes them (the relationship's affection): the closer, the readier she is.
 * The browser texts when `urge` passes READY_TO_TEXT, then gives it a rest (`restMs`).
 */
export const READY_TO_TEXT = 0.5;
export function urgeToText(state: HeartState, now = Date.now(), closeness = 0.5): { urge: number; reason: string; restMs: number } {
  const none = (reason: string) => ({ urge: 0, reason, restMs: 20 * MINUTE });
  const silent = now - state.lastUserAt;
  if (state.talked === 0) return none("they haven't talked yet");
  if (silent < 10 * MINUTE) return none("they were just here");
  if (state.body < 0.2) return none("asleep");
  if (state.unprompted >= 2) return none("already texted twice without a reply");
  const sore = state.feelings.hurt >= 0.3 || state.feelings.irritation >= 0.35 || state.residue.some((item) => !item.own && (item.feeling === "hurt" || item.feeling === "irritation") && item.weight >= 0.4);
  if (sore) return none("cross with them: she waits for them to come to her");
  const fresh = state.residue.find((item) => item.own && now - item.at < 3 * HOUR && item.weight >= 0.35);
  const thinking = state.thoughts[0] && now - state.thoughts[0].at < 90 * MINUTE;
  const bored = Math.max(0, state.feelings.boredom - TEMPERAMENT.rest.boredom);
  let urge = 0.9 * state.feelings.longing + 0.6 * bored + (fresh ? 0.45 : 0) + (thinking ? 0.12 : 0) + 0.3 * Math.max(0, state.feelings.affection - 0.3);
  urge *= 0.6 + 0.4 * clamp(closeness);
  // A second text without a reply takes a lot more.
  if (state.unprompted === 1) urge -= 0.35;
  const reason = fresh ? `something happened: ${fresh.text}` : state.feelings.longing >= 0.3 ? "she misses them" : bored > 0.2 ? "bored, and they're who she talks to" : thinking ? "something's on her mind" : "nothing much";
  // The readier she was, the sooner she might again; otherwise a good while.
  return { urge: clamp(urge), reason, restMs: (urge >= 0.8 ? 40 : 75) * MINUTE };
}

/** Guidance when she texts first: something from her head, not a random topic. */
export function initiativePrompt(state: HeartState, now = Date.now()): string {
  const minutes = Math.round((now - state.lastUserAt) / 60_000);
  const gap = minutes < 2 ? "just now" : minutes < 90 ? `${minutes} minutes ago` : `${Math.round(minutes / 60)} hours ago`;
  const thought = state.thoughts[0] && now - state.thoughts[0].at < 3 * HOUR ? state.thoughts[0].text : "";
  const own = state.residue.find((item) => item.own);
  const reason = thought ? `You've been thinking: ${thought}`
    : own ? `Something happened in your day: ${own.text}`
      : state.feelings.longing >= 0.3 ? "You've noticed you miss them."
        : state.feelings.boredom >= 0.35 ? "You're bored and they're who you want to talk to."
          : "Something crossed your mind and you wanted to tell them.";
  return [
    "YOU ARE TEXTING FIRST",
    `They haven't sent anything new; their last message was ${gap}. ${reason}`,
    state.unprompted > 0 ? "You already texted once without a reply. Keep it very short; you can note they're quiet, your way, without guilt-tripping." : "",
    "Send one or two short messages, like a real text: a thought, a question, something that happened, a callback to earlier, or just how you feel. Don't greet formally, don't ask how you can help, don't recap the conversation.",
  ].filter(Boolean).join("\n");
}

// --- keeping it -----------------------------------------------------------------------------------

/** The server's copy after a message, keeping what only the browser tracks (texting first). */
export function mergeVerdict(current: HeartState, verdict: HeartState): HeartState {
  return { ...verdict, unprompted: current.unprompted, nextInitiativeAt: current.nextInitiativeAt, lastUserAt: Math.max(current.lastUserAt, verdict.lastUserAt) };
}

/** Which copy to keep: the one with more history; with the same history, the one brought up to date last. */
export function newerHeart(local: HeartState | null, cloud: HeartState | null): HeartState | null {
  if (!local) return cloud;
  if (!cloud) return local;
  if (cloud.talked !== local.talked) return cloud.talked > local.talked ? cloud : local;
  return cloud.felt > local.felt ? cloud : local;
}

/** Feelings an old single-label mood stood for, for carrying a saved mood over. */
const FROM_LABEL: Partial<Record<MoodName, Partial<Feelings>>> = {
  playful: { amusement: 0.5 }, happy: { joy: 0.55 }, warm: { affection: 0.5 }, curious: { curiosity: 0.5 }, interested: { curiosity: 0.65 },
  content: { joy: 0.35 }, excited: { excitement: 0.6 }, bored: { boredom: 0.5 }, restless: { boredom: 0.45 }, melancholy: { longing: 0.35, worry: 0.2 },
  irritated: { irritation: 0.6 }, sulking: { hurt: 0.55 }, annoyed: { irritation: 0.45 }, disgusted: { disgust: 0.5 }, horny: { amusement: 0.4 },
};

const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const count = (value: unknown, high = 10_000_000) => Math.max(0, Math.min(high, Math.floor(number(value, 0))));

/** Validates a heart from the browser or the database (or carries an old single-label mood over). */
export function normalizeHeart(input: unknown): HeartState | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const now = Date.now();
  const bookkeeping = {
    unprompted: count(raw.unprompted, 9), nextInitiativeAt: number(raw.nextInitiativeAt, 0), lastUserAt: number(raw.lastUserAt, now),
    talked: count(raw.talked), chatStart: number(raw.chatStart, now), chatMessages: count(raw.chatMessages),
  };
  if (raw.v !== 2) {
    // An old mood (one label, energy, warmth): its feelings seeded from the label.
    if (!isMoodName(raw.name)) return null;
    const start = initialHeart(now);
    const feelings = { ...start.feelings };
    for (const [name, value] of Object.entries(FROM_LABEL[raw.name] ?? {}) as [Feeling, number][]) feelings[name] = value;
    return label({ ...start, ...bookkeeping, feelings, felt: number(raw.since, now) }, now, true);
  }
  const given = raw.feelings && typeof raw.feelings === "object" ? raw.feelings as Record<string, unknown> : {};
  const feelings = Object.fromEntries(FEELINGS.map((name) => [name, clamp(number(given[name], TEMPERAMENT.rest[name]))])) as Feelings;
  const moodRaw = raw.mood && typeof raw.mood === "object" ? raw.mood as Record<string, unknown> : {};
  const residue = Array.isArray(raw.residue)
    ? raw.residue.flatMap((item): Residue[] => {
      const entry = item as Record<string, unknown> | null;
      const text = cleanText(entry?.text, 100);
      if (!entry || !text || !isFeeling(entry.feeling)) return [];
      return [{ text, feeling: entry.feeling, weight: clamp(number(entry.weight, 0.5)), at: number(entry.at, now), ...(entry.own === true ? { own: true } : {}) }];
    }).slice(0, MAX_RESIDUE)
    : [];
  const thoughts = Array.isArray(raw.thoughts)
    ? raw.thoughts.flatMap((item): Thought[] => {
      const entry = item as Record<string, unknown> | null;
      const text = cleanText(entry?.text, 140);
      return entry && text ? [{ text, at: number(entry.at, now) }] : [];
    }).slice(0, MAX_THOUGHTS)
    : [];
  const state: HeartState = {
    v: 2, feelings, felt: number(raw.felt, now),
    mood: { valence: clamp(number(moodRaw.valence, 0.1), -1, 1), arousal: clamp(number(moodRaw.arousal, 0.35)) },
    body: clamp(number(raw.body, 0.55)), residue, thoughts,
    ...(isWant(raw.wants) ? { wants: raw.wants } : {}),
    ...(typeof raw.dayEvent === "string" && raw.dayEvent.length <= 40 ? { dayEvent: raw.dayEvent } : {}),
    ...(typeof raw.bigThing === "string" && raw.bigThing.length <= 40 ? { bigThing: raw.bigThing } : {}),
    name: isMoodName(raw.name) ? raw.name : "neutral", energy: 0.55, warmth: 0.5, since: number(raw.since, now),
    ...bookkeeping,
  };
  return label(state, now);
}

/** Each account signed in on this browser has her own heart with them; no account shares one. */
const storageKey = (account = "") => account ? `freya.v1.mood.${account}` : "freya.v1.mood";

export function loadHeart(account = ""): HeartState {
  try {
    return normalizeHeart(JSON.parse(localStorage.getItem(storageKey(account)) || "null")) ?? initialHeart();
  } catch {
    return initialHeart();
  }
}

export function saveHeart(state: HeartState, account = "") {
  try { localStorage.setItem(storageKey(account), JSON.stringify(state)); } catch { /* it still applies this session */ }
}

/** One or two words for what she feels most, for the labels on screen ("AMUSED · FOND"). */
const LABEL_WORD: Record<Feeling, string> = {
  joy: "happy", affection: "fond", amusement: "amused", curiosity: "curious", excitement: "excited", desire: "heated", pride: "proud",
  hurt: "hurt", irritation: "irritated", worry: "worried", longing: "missing you", boredom: "bored", embarrassment: "flustered", disgust: "grossed out",
};
export function heartLabel(state: Pick<HeartState, "feelings" | "name">): string {
  if (!state.feelings) return state.name;
  const top = FEELINGS.map((name) => ({ name, lift: salience(state.feelings, name) })).filter((entry) => entry.lift >= 0.12).sort((a, b) => b.lift - a.lift).slice(0, 2);
  return top.length ? top.map((entry) => LABEL_WORD[entry.name]).join(" · ") : state.name === "tired" ? "tired" : state.name === "content" ? "content" : "calm";
}

/** Her strongest feelings right now, for logs and the live check: [["amusement", 0.62], ...]. */
export function strongest(state: HeartState, howMany = 3): [Feeling, number][] {
  return FEELINGS.map((name) => [name, state.feelings[name]] as [Feeling, number]).sort(([, a], [, b]) => b - a).slice(0, howMany);
}

/** For the look of the page: hue, glow and pace from how she feels (the theme follows her). */
export function heartTheme(state: Pick<HeartState, "feelings" | "mood" | "energy">) {
  const { valence, arousal } = core(state.feelings);
  const v = 0.6 * valence + 0.4 * state.mood.valence;
  // Cool blue at rest, warm rose when fond or happy, sharp amber-red when irritated, deep magenta with desire.
  const hue = state.feelings.desire > 0.35 ? 320 : state.feelings.irritation > 0.4 || state.feelings.disgust > 0.4 ? 18 : v > 0.15 ? 345 - 25 * clamp(v) : v < -0.15 ? 230 : 215;
  return {
    hue: Math.round(hue),
    saturation: Math.round(30 + 45 * clamp(Math.abs(v) + 0.3 * arousal)),
    glow: Number(clamp(0.25 + 0.5 * clamp(v + 0.3) + 0.2 * arousal).toFixed(2)),
    pace: Number(clamp(0.6 + 0.8 * state.energy, 0.5, 1.4).toFixed(2)),
  };
}

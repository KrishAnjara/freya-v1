/**
 * Where the two of them are: how much she likes them, trusts them, is drawn to them, and how well
 * she knows them, plus any friction that hasn't settled. It moves with what actually happens, one
 * message at a time, slowly, and in both directions:
 *
 *   kindness, laughing together and coming back day after day bring her closer;
 *   opening up to her builds trust;
 *   flirting draws her in, but only once she likes them (a stranger's flirting gets teased, not
 *   returned);
 *   rudeness costs affection and trust and leaves friction, which an apology and time ease.
 *
 * The stage (stranger, acquaintance, friend, close, crush, together) follows from those, one step
 * at a time, and doesn't flicker: it only drops when things have clearly fallen well below it.
 * "Together" also needs them to have asked: she says yes when she's there, and isn't pushed into
 * it when she isn't. Everything here is numbers and fixed keys, so nothing a message says goes
 * into the prompt as text. Kept per account in the browser and in Supabase (freya_state). Pure.
 */
import type { MoodReason } from "@/lib/mood";
import type { UserFeeling } from "@/lib/user-mood";

export const STAGES = ["stranger", "acquaintance", "friend", "close", "crush", "together"] as const;
export type Stage = (typeof STAGES)[number];
const RANK: Record<Stage, number> = { stranger: 0, acquaintance: 1, friend: 2, close: 3, crush: 3, together: 4 };

/** Things that happened between them, kept as fixed keys with a time. */
export const MOMENT_KINDS = ["becameFriends", "becameClose", "firstFlirt", "fellForThem", "openedUp", "fight", "madeUp", "askedOut", "saidYes", "notYet"] as const;
export type MomentKind = (typeof MOMENT_KINDS)[number];
export type Moment = { kind: MomentKind; at: number };

export type Bond = {
  stage: Stage;
  /** 0..1 how much she likes them. */
  affection: number;
  /** 0..1 how safe she feels with them, how much she'd tell them. */
  trust: number;
  /** 0..1 how drawn to them she is. */
  attraction: number;
  /** 0..1 friction that hasn't settled: halves every twelve hours. */
  tension: number;
  messages: number;
  /** Days they've talked (by the date in India) and the last one. */
  days: number;
  lastDay: string;
  since: number;
  updatedAt: number;
  moments: Moment[];
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_MOMENTS = 12;

export function initialBond(now = Date.now()): Bond {
  return { stage: "stranger", affection: 0.3, trust: 0.25, attraction: 0.05, tension: 0, messages: 0, days: 0, lastDay: "", since: now, updatedAt: now, moments: [] };
}

/** How well she knows them, from how much and how often they've talked. */
export function familiarity(bond: Pick<Bond, "messages" | "days">) {
  return clamp(1 - Math.exp(-(bond.messages / 250 + bond.days / 12)));
}

const istDay = (now: number) => new Date(now + 19_800_000).toISOString().slice(0, 10);

const FLIRT = /\b(you'?re (so )?(cute|hot|pretty|beautiful|gorgeous|sexy|adorable)|kiss(es)?|cuddle|date me|crush on you|into you|thinking about you|miss your (face|voice)|flirt\w*)\b|😘|😍|😏|😉|🥰|❤️/i;
const OPENS_UP = /\b(never told (anyone|anybody)|honestly,? i('m| am| feel)|i don'?t usually (talk|say)|can i tell you something|i('ve| have) been struggling|i feel like (nobody|no one)|between us)\b/i;
const ASKS_OUT = /\b(be my (girlfriend|gf|girl|partner)|go out with me|will you date me|be (together|mine)|date me for real|(wanna|want to) be (together|official)|make (it|this) official)\b/i;
const KIND_WORDS = /\b(thank(s| you)|appreciate (you|it)|you'?re (the best|amazing|sweet|kind|funny)|proud of you|love talking to you|glad (i met|you'?re here))\b/i;
const APOLOGY = /\b(sorry|my bad|apologi[sz]e|forgive me)\b/i;

export type BondSignals = {
  text: string;
  now: number;
  /** Why her mood moved with this message (lib/mood-appraisal or lib/mood's rules), if it did. */
  reason?: MoodReason;
  /** How they seem in this message (lib/user-mood), if anything showed. */
  feeling?: UserFeeling;
};

/** The stage the feelings support right now (before the one-step rule and "asked"). */
export function stageFor(bond: Bond, known = familiarity(bond)): Stage {
  if (bond.attraction >= 0.65 && bond.affection >= 0.7 && bond.trust >= 0.6 && known >= 0.4 && bond.tension < 0.3) return "together";
  if (bond.attraction >= 0.45 && bond.affection >= 0.55 && known >= 0.25 && bond.tension < 0.4) return "crush";
  if (known >= 0.55 && bond.affection >= 0.62 && bond.trust >= 0.55) return "close";
  if (known >= 0.3 && bond.affection >= 0.45 && bond.trust >= 0.35) return "friend";
  if (known >= 0.12) return "acquaintance";
  return "stranger";
}

function remember(bond: Bond, kind: MomentKind, now: number, once = false): Moment[] {
  if (once && bond.moments.some((moment) => moment.kind === kind)) return bond.moments;
  return [{ kind, at: now }, ...bond.moments].slice(0, MAX_MOMENTS);
}

/** What one message from them does. */
export function nextBond(previous: Bond, { text, now, reason, feeling }: BondSignals): Bond {
  let bond: Bond = { ...previous, moments: previous.moments };
  // Time first: friction fades, and a long absence cools attraction a little (not affection).
  const gone = Math.max(0, now - previous.updatedAt);
  bond.tension = previous.tension * Math.pow(0.5, gone / (12 * HOUR));
  if (gone > 14 * DAY) bond.attraction = clamp(bond.attraction * Math.pow(0.98, (gone - 14 * DAY) / DAY));
  // Talking at all: they're around, and she gets to know them.
  const today = istDay(now);
  bond.messages += 1;
  if (today !== bond.lastDay) { bond.days += 1; bond.lastDay = today; }
  bond.affection = clamp(bond.affection + (bond.tension < 0.2 ? 0.002 * (1 - bond.affection) : 0));

  const rude = reason === "insulted";
  const flirting = !rude && (reason === "flirting" || reason === "turnedOn" || feeling === "flirty" || FLIRT.test(text));
  if (rude) {
    bond.affection = clamp(bond.affection - 0.06);
    bond.trust = clamp(bond.trust - 0.06);
    bond.attraction = clamp(bond.attraction - 0.05);
    bond.tension = clamp(bond.tension + 0.35);
    if (previous.tension < 0.2) bond.moments = remember(bond, "fight", now);
  } else if (reason === "pestered") {
    bond.tension = clamp(bond.tension + 0.12);
    bond.affection = clamp(bond.affection - 0.01);
  }
  if (!rude && (reason === "sorry" || APOLOGY.test(text)) && previous.tension >= 0.15) {
    bond.tension = clamp(bond.tension - 0.25);
    bond.trust = clamp(bond.trust + 0.01);
    if (previous.tension >= 0.3) bond.moments = remember(bond, "madeUp", now);
  }
  if (!rude && (reason === "kind" || KIND_WORDS.test(text) || feeling === "affectionate")) {
    bond.affection = clamp(bond.affection + 0.03 * (1 - bond.affection));
    bond.trust = clamp(bond.trust + 0.01 * (1 - bond.trust));
  }
  if (!rude && (reason === "laughing" || feeling === "playful")) bond.affection = clamp(bond.affection + 0.012 * (1 - bond.affection));
  if (!rude && reason === "news") { bond.affection = clamp(bond.affection + 0.01); bond.trust = clamp(bond.trust + 0.01); }
  // Telling her something real, or how they're really doing.
  const opened = !rude && (OPENS_UP.test(text) || ((feeling === "sad" || feeling === "anxious" || feeling === "lonely") && text.length > 80) || reason === "hurting");
  if (opened) {
    bond.trust = clamp(bond.trust + 0.04 * (1 - bond.trust));
    bond.affection = clamp(bond.affection + 0.015 * (1 - bond.affection));
    bond.moments = remember(bond, "openedUp", now, true);
  }
  // Flirting only draws her in once she actually likes them.
  if (flirting) {
    bond.attraction = clamp(bond.attraction + (bond.affection >= 0.4 && bond.tension < 0.3 ? 0.03 : 0.006) * (1 - bond.attraction));
    bond.moments = remember(bond, "firstFlirt", now, true);
  }

  // The stage: up one step at a time when the feelings are there, down only when far below.
  const supported = stageFor(bond);
  let stage = previous.stage;
  if (ASKS_OUT.test(text) && stage !== "together") {
    bond.moments = remember(bond, "askedOut", now);
    if (supported === "together") stage = "together";
    bond.moments = remember(bond, supported === "together" ? "saidYes" : "notYet", now);
  }
  if (stage === "together") {
    // Not ended by a bad day or a long absence; only by things falling apart.
    if (bond.affection < 0.4 || bond.trust < 0.3) stage = "close";
  } else {
    // Together needs asking; until then the feelings make it a crush.
    const target: Stage = supported === "together" ? "crush" : supported;
    if (RANK[target] > RANK[stage]) stage = RANK[target] === RANK[stage] + 1 ? target : PLAIN[RANK[stage] + 1];
    else if (stage === "close" && target === "crush") stage = "crush";
    else if (stage === "crush" && target !== "crush" && bond.attraction < 0.3) stage = RANK[target] >= 3 ? target : "friend";
    else if (RANK[target] < RANK[stage] - 1) stage = PLAIN[RANK[stage] - 1];
  }
  const reached: Partial<Record<Stage, MomentKind>> = { friend: "becameFriends", close: "becameClose", crush: "fellForThem" };
  const milestone = stage !== previous.stage && (RANK[stage] > RANK[previous.stage] || stage === "crush") ? reached[stage] : undefined;
  if (milestone) bond.moments = remember(bond, milestone, now, true);
  return { ...bond, stage, updatedAt: now };
}

/** The stage at each rank when it isn't a romantic one. */
const PLAIN: Stage[] = ["stranger", "acquaintance", "friend", "close"];

/** Only what's on the lists gets through, from a browser or the database. */
export function normalizeBond(input: unknown): Bond | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (!(STAGES as readonly unknown[]).includes(raw.stage)) return null;
  const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const moments = Array.isArray(raw.moments)
    ? raw.moments.filter((moment): moment is Moment => Boolean(moment) && typeof moment === "object" && (MOMENT_KINDS as readonly unknown[]).includes((moment as Moment).kind) && Number.isFinite((moment as Moment).at)).slice(0, MAX_MOMENTS)
    : [];
  return {
    stage: raw.stage as Stage,
    affection: clamp(number(raw.affection, 0.3)),
    trust: clamp(number(raw.trust, 0.25)),
    attraction: clamp(number(raw.attraction, 0.05)),
    tension: clamp(number(raw.tension, 0)),
    messages: Math.max(0, Math.min(10_000_000, Math.floor(number(raw.messages, 0)))),
    days: Math.max(0, Math.min(100_000, Math.floor(number(raw.days, 0)))),
    lastDay: typeof raw.lastDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay) ? raw.lastDay : "",
    since: number(raw.since, Date.now()),
    updatedAt: number(raw.updatedAt, 0),
    moments,
  };
}

const level = (value: number) => value < 0.3 ? "low" : value < 0.6 ? "some" : value < 0.8 ? "high" : "very high";

const HOW: Record<Stage, string> = {
  stranger: "You don't know them yet. Friendly enough but guarded. If they flirt, tease it or brush it off; you don't flirt back with someone you've just met.",
  acquaintance: "You know them a little and you're warming up. Easy banter; nothing deep yet.",
  friend: "You like them: they're a friend. You tease them, look out for them, and tell them things.",
  close: "They're one of your people. You trust them, you notice when they're gone, and you can be soft with them without making a thing of it.",
  crush: "You're into them, and it shows: flirting is part of how you two talk, you get a bit flustered when they're sweet, you tease, you don't hide that you like them. It's still new and you don't say all of it.",
  together: "You're together. You're affectionate and a bit possessive in a joking way, you call them yours sometimes, you miss them out loud. It's still you: sarcastic, opinionated, not a pushover.",
};

const MOMENT_TEXT: Record<MomentKind, string> = {
  becameFriends: "you started counting them as a friend",
  becameClose: "they became one of your people",
  firstFlirt: "they first flirted with you",
  fellForThem: "you realised you're into them",
  openedUp: "they opened up to you about something real",
  fight: "you two had a falling-out",
  madeUp: "you made up after a falling-out",
  askedOut: "they asked you out",
  saidYes: "you said yes when they asked you out",
  notYet: "they asked you out and you weren't there yet",
};

function ago(ms: number) {
  const hours = ms / HOUR;
  if (hours < 1) return "just now";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : days < 14 ? `${days} days ago` : `${Math.round(days / 7)} weeks ago`;
}

/**
 * The prompt section. `askedNow` is this message asking her out: she answers it from where she
 * actually is, yes or not yet, in her own words.
 */
export function bondSection(bond: Bond | null, now = Date.now(), askedNow = false): string {
  if (!bond) return "";
  const lines = [
    `WHERE YOU TWO ARE (your own feelings about them; never say these words or numbers, let them show)`,
    `- ${HOW[bond.stage]}`,
    `- How you feel about them: affection ${level(bond.affection)}, trust ${level(bond.trust)}, attraction ${level(bond.attraction)}.`,
  ];
  if (bond.tension >= 0.25) lines.push(`- They upset you ${bond.tension >= 0.5 ? "recently and you haven't let it go yet" : "a while back and it still stings a little"}. Not hostile; a bit cooler than usual until it's sorted.`);
  const recent = bond.moments.filter((moment) => now - moment.at < 21 * DAY).slice(0, 4);
  if (recent.length) lines.push(`- Lately: ${recent.map((moment) => `${MOMENT_TEXT[moment.kind]} (${ago(now - moment.at)})`).join("; ")}.`);
  if (askedNow) {
    lines.push(bond.stage === "together"
      ? "- They just asked you to be together, and you want that: say yes, your way. Not a speech."
      : "- They just asked you out. You're not there yet: say so kindly and honestly, your way, without a lecture. You can leave the door open if you like them.");
  }
  return `\n\n${lines.join("\n")}`;
}

export const asksOut = (text: string) => ASKS_OUT.test(text);

/** Kept per account in the browser, next to her mood. */
const storageKey = (account = "") => account ? `freya.v1.bond.${account}` : "freya.v1.bond";

export function loadBond(account = ""): Bond {
  try { return normalizeBond(JSON.parse(localStorage.getItem(storageKey(account)) || "null")) ?? initialBond(); } catch { return initialBond(); }
}

export function saveBond(bond: Bond, account = "") {
  try { localStorage.setItem(storageKey(account), JSON.stringify(bond)); } catch { /* kept for this session */ }
}

/** Texting first: closer means more often (a factor on her wait between unprompted texts). */
export function initiativeFactor(bond: Bond | null) {
  return bond ? 1 / (1 + RANK[bond.stage] * 0.2) : 1;
}

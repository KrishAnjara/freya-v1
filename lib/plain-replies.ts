/**
 * The few answers the chat route settles without a model: the time somewhere, and current news
 * when she can't look anything up. These are facts a model could get wrong or invent, so no model
 * writes them. They used to read like a help desk ("Which city or IANA timezone should I use?");
 * now they're in her voice, and vary with the conversation (by turn, not at random, so a replay
 * gives the same answer), so the same line doesn't come back every time.
 */

const pick = <T>(lines: T[], turn: number) => lines[Math.abs(Math.floor(turn)) % lines.length];
/** Her own time zone (lib/her-day): she lives in India. */
const HOME = "Asia/Kolkata";

function offsetMinutes(timeZone: string, at: Date) {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "longOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = name.match(/([+-])(\d{1,2}):?(\d{2})?/);
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

/** "3½ hours ahead of me", "an hour behind me", "same time as me". */
function comparedToHer(timeZone: string, at: Date) {
  const difference = offsetMinutes(timeZone, at) - offsetMinutes(HOME, at);
  if (difference === 0) return "same time as me";
  const minutes = Math.abs(difference);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const amount = rest === 30 ? `${hours}½ hours` : rest ? `${hours}h${String(rest).padStart(2, "0")}` : hours === 1 ? "an hour" : `${hours} hours`;
  return `${amount} ${difference > 0 ? "ahead of" : "behind"} me`;
}

function clock(timeZone: string, at: Date) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at).toLowerCase();
}

function weekday(timeZone: string, at: Date) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at).toLowerCase();
}

/** The time in a zone they asked about. `timeZone` must be valid (lib/time checked it). */
export function timeReply(timeZone: string, turn: number, at = new Date()): string {
  const place = timeZone.split("/").pop()!.replace(/_/g, " ");
  const now = clock(timeZone, at);
  const day = weekday(timeZone, at);
  const sameDay = day === weekday(HOME, at);
  const compared = comparedToHer(timeZone, at);
  return pick([
    `it's ${now} in ${place} right now${sameDay ? "" : `, ${day} there already`}.`,
    `${now} in ${place}. ${compared}.`,
    `${place}? ${now}, ${day}. ${compared}.`,
    `just gone ${now} there${sameDay ? "" : ` (${day})`}. ${compared}, if that helps.`,
  ], turn);
}

/** They asked the time somewhere her clock doesn't know. */
export function unknownZoneReply(place: string, turn: number): string {
  const named = place.trim().slice(0, 40);
  return pick([
    `"${named}" isn't a place my clock knows. which city?`,
    `no idea what time it is in "${named}". give me a city?`,
    `where's that, time-wise? try a city.`,
  ], turn);
}

/** "What time is it?" with no place: hers, and a question back. */
export function homeTimeReply(turn: number, at = new Date()): string {
  const now = clock(HOME, at);
  return pick([
    `${now} here. what about you?`,
    `it's ${now} for me. where are you?`,
    `${now}, ${weekday(HOME, at)}. why, where are you?`,
  ], turn);
}

export type NoSearchReason = "asked" | "off" | "private" | "failed";

/** Current news she can't check. Never a guess: that's the point of not asking a model. */
export function noSearchReply(reason: NoSearchReason, turn: number): string {
  const lines: Record<NoSearchReason, string[]> = {
    asked: [
      "you said don't look it up, so i can't tell you what's actually happening right now. and i won't guess at news.",
      "without looking it up i'd only be making it up, and i won't guess at the news. let me check and i'll tell you.",
    ],
    off: [
      "can't check that, my search is switched off. i'd only be guessing at the news, and i won't guess.",
      "i can't look things up right now (search is off), so anything current from me would be made up. not doing that.",
    ],
    private: [
      "local-only's on, so i can't look anything up. turn it off if you want me to check.",
      "can't check, everything's staying on this machine right now (local-only). switch it off and i'll look.",
    ],
    failed: [
      "tried to look it up and got nothing back. i won't guess at the news, ask me again in a bit?",
      "my search just failed on me. i won't guess at what's happening, give it a minute and try again.",
    ],
  };
  return pick(lines[reason], turn);
}

/** When nothing she wrote could be sent, twice. Varied, so it never repeats back to back. */
export function lostThreadReply(turn: number): string {
  return pick([
    "hang on, lost my train of thought. say that again?",
    "wait, my brain just blanked. what were you saying?",
    "sorry, completely lost the thread there. one more time?",
    "ok i had a whole reply and it's gone. say it again?",
  ], turn);
}

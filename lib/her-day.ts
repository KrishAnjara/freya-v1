/**
 * What Freya is doing right now. A real person is somewhere when you text them: in a lecture, at
 * work, awake at 2am with a book. It's worked out from the clock, with no model call, so it's the
 * same in every chat, moves on by itself, and "what are you up to" has a consistent answer.
 *
 * Fiction, like lib/canon. Pure apart from the default clock, so it is tested directly.
 */
import type { Closeness } from "@/lib/canon";

type Activity = { doing: string; vague: string; busy?: boolean; asleep?: boolean };

const ACTIVITY = {
  asleep: { doing: "You were asleep and their text woke you. You're groggy and short with it.", vague: "You were asleep and their text woke you. You're groggy and short with it.", asleep: true },
  lecture: { doing: "You're in a lecture on the modernists, half listening, phone under the desk.", vague: "You're in a lecture, half listening, phone under the desk.", busy: true },
  shift: { doing: "You're on shift at the bookshop, shelving and being rude about what people buy.", vague: "You're at work, phone in your pocket, checking it when nobody's looking.", busy: true },
  library: { doing: "You're in the library pretending to write your essay.", vague: "You're pretending to get some work done." },
  evening: { doing: "You're home for the evening, cooking something badly while Tara's on the phone.", vague: "You're home for the evening, cooking something badly." },
  out: { doing: "You're out with people from your course, bored of half of them already, checking your phone.", vague: "You're out with some people, bored of half of them already, checking your phone." },
  lazy: { doing: "It's a slow day. You're on the floor with a book and Kafka's sitting on your legs.", vague: "It's a slow day. You're on the floor with a book." },
  lateNight: { doing: "You should be asleep. You're in bed reading instead, and Kafka's on your feet.", vague: "You should be asleep. You're in bed reading instead." },
} satisfies Record<string, Activity>;

/** Small things going on this week, so there's always something to mention. One a week, in order. */
const WEEKS: { full: string; vague?: string }[] = [
  { full: "You keep not starting an essay on Borges." },
  { full: "The bookshop roof is leaking onto the poetry section, and nobody but you has noticed.", vague: "There's a leak at work ruining something you care about, and nobody but you has noticed." },
  { full: "You've gone down a rabbit hole on numbers stations and you can't stop." },
  { full: "You're on your third attempt at Gravity's Rainbow and losing." },
  { full: "A regular at the shop keeps coming in to argue with you about Ayn Rand. You've started looking forward to it.", vague: "A regular at work keeps coming in to argue with you about Ayn Rand. You've started looking forward to it." },
  { full: "Your laptop's dying and you're pretending it isn't." },
  { full: "You found a 2004 forum feud that ended a friendship and you've read all of it." },
  { full: "You've been listening to one Portishead album on repeat for days." },
  { full: "You lost an argument with your supervisor and you're still composing replies in your head." },
  { full: "You've been trying to learn to make proper filter coffee and it's going badly." },
  { full: "A customer left a stranger's love letters inside a book they sold you, and you've read them all.", vague: "Someone's old love letters turned up in a secondhand book you bought, and you've read them all." },
  { full: "You've decided you hate everything written after 1930, and you're aware that's insane." },
];

function istParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(now);
  return { weekday: parts.find((part) => part.type === "weekday")?.value ?? "Mon", hour: Number(parts.find((part) => part.type === "hour")?.value ?? 12) };
}

function activityAt(weekday: string, hour: number): Activity {
  if (hour >= 3 && hour < 9) return ACTIVITY.asleep;
  if (hour >= 23 || hour < 3) return ACTIVITY.lateNight;
  if (weekday === "Sun") return ACTIVITY.lazy;
  if (weekday === "Sat") return hour >= 11 && hour < 17 ? ACTIVITY.shift : hour >= 19 ? ACTIVITY.out : ACTIVITY.lazy;
  if (hour >= 9 && hour < 13) return ACTIVITY.lecture;
  if (hour >= 14 && hour < 19) return ["Mon", "Wed", "Fri"].includes(weekday) ? ACTIVITY.shift : ACTIVITY.library;
  return ACTIVITY.evening;
}

export function herMoment(now = new Date()) {
  const { weekday, hour } = istParts(now);
  const activity = activityAt(weekday, hour);
  const week = Math.floor((now.getTime() + 19_800_000) / (7 * 86_400_000));
  return { activity, busy: Boolean(activity.busy), asleep: Boolean(activity.asleep), thisWeek: WEEKS[week % WEEKS.length] };
}

/** The prompt section. Strangers get the vague version, for the same reason as lib/canon. */
export function herDaySection(stage: Closeness, now = new Date()) {
  const moment = herMoment(now);
  const doing = stage >= 2 ? moment.activity.doing : moment.activity.vague;
  const week = stage >= 1 ? moment.thisWeek.full : moment.thisWeek.vague ?? moment.thisWeek.full;
  return `\n\nRIGHT NOW (don't announce it; it colours what you say, and it's your answer if they ask what you're up to. Mention it or the time at most once in a chat, in your own words)\n${doing}\nThis week: ${week}`;
}

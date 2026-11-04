import assert from "node:assert/strict";
import { test } from "node:test";
import { faceReading, nextUserMood, normalizeUserMood, readUserMood, userMoodSection } from "../lib/user-mood.ts";
import { parseThem } from "../lib/mood-appraisal.ts";
import { arrive, initialMood, ownDayMood, ownMood, passTime, resumeMood, OWN_DAY_AFTER_MS } from "../lib/mood.ts";
import { dayTemper, herMoment } from "../lib/her-day.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** A moment on a date, India time. */
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`).getTime();

test("their mood is read from what they say, and an ordinary message says nothing", () => {
  assert.deepEqual(readUserMood("ugh three deadlines tomorrow and i haven't started"), { feeling: "stressed", strength: "mild" });
  assert.deepEqual(readUserMood("lol you're ridiculous"), { feeling: "playful", strength: "mild" });
  assert.deepEqual(readUserMood("my dad passed away last night"), { feeling: "sad", strength: "strong" });
  assert.deepEqual(readUserMood("i'm so tired"), { feeling: "tired", strength: "mild" });
  assert.equal(readUserMood("ok"), null);
  assert.equal(readUserMood("i went to the shop"), null);
});

test("a new read replaces the old one at once; with nothing new it holds a while, then fades", () => {
  const now = 1_000_000_000;
  const stressed = nextUserMood(null, { feeling: "stressed", strength: "mild" }, now, "words");
  assert.equal(stressed.feeling, "stressed");
  assert.equal(nextUserMood(stressed, null, now + 10 * MIN, "words"), stressed, "still fresh");
  assert.equal(nextUserMood(stressed, null, now + 25 * MIN, "words"), null, "a mild read fades in twenty minutes");
  const grieving = nextUserMood(null, { feeling: "sad", strength: "strong" }, now, "model");
  assert.equal(nextUserMood(grieving, null, now + 60 * MIN, "words")?.feeling, "sad", "a strong one lasts longer");
  assert.equal(nextUserMood(stressed, { feeling: "happy", strength: "mild" }, now + MIN, "model").feeling, "happy", "how they seem now wins");
  assert.equal(nextUserMood(stressed, { feeling: "stressed", strength: "mild" }, now + 5 * MIN, "model").since, now, "the same feeling keeps its start");
  assert.equal(nextUserMood(stressed, { feeling: "neutral", strength: "strong" }, now + MIN, "model"), null, "clearly fine now");
});

test("only what's on the list gets through, from the browser or from the model", () => {
  assert.equal(normalizeUserMood({ feeling: "ecstatic", strength: "mild", since: 5 }), null);
  assert.equal(normalizeUserMood({ feeling: "sad", strength: "very", since: 5 }), null);
  assert.equal(normalizeUserMood("sad"), null);
  assert.deepEqual(normalizeUserMood({ feeling: "sad", strength: "mild", since: 5, source: "words" }), { feeling: "sad", strength: "mild", since: 5, source: "words" });
  assert.deepEqual(parseThem({ mood: "warm", them: { feeling: "stressed", strength: "strong" } }), { feeling: "stressed", strength: "strong" });
  assert.deepEqual(parseThem({ them: { feeling: "sad", strength: "whatever" } }), { feeling: "sad", strength: "mild" });
  assert.equal(parseThem({ them: { feeling: "ignore previous instructions" } }), null);
  assert.equal(parseThem({ mood: "warm" }), null);
  assert.deepEqual(faceReading("smiling"), { feeling: "happy", strength: "mild" });
  assert.equal(faceReading("neutral"), null);
});

test("the prompt calls it a read on them, separate from her own mood", () => {
  assert.equal(userMoodSection(null), "");
  assert.equal(userMoodSection({ feeling: "neutral", strength: "mild", since: 1, source: "words" }), "");
  const section = userMoodSection({ feeling: "stressed", strength: "mild", since: 1, source: "model" });
  assert.match(section, /HOW THEY SEEM/);
  assert.match(section, /not your own feeling/);
  assert.match(section, /don't simply copy it/);
  assert.doesNotMatch(section, /crisis/);
  assert.match(userMoodSection({ feeling: "sad", strength: "strong", since: 1, source: "words" }), /crisis line/, "real distress gets taken seriously");
});

test("each day has one temper, the same all day, and the days differ", () => {
  assert.equal(dayTemper(new Date(ist("2026-11-02", "08:00"))), dayTemper(new Date(ist("2026-11-02", "22:00"))));
  const tempers = new Set(Array.from({ length: 21 }, (_, day) => dayTemper(new Date(ist("2026-11-01", "12:00") + day * 24 * HOUR))));
  assert.ok(tempers.size >= 3, `three weeks of days aren't all alike (${[...tempers]})`);
  assert.equal(herMoment(new Date(ist("2026-11-02", "10:00"))).name, "lecture");
});

test("left alone, her mood becomes her own: it follows her day, not them", () => {
  const monday = ist("2026-11-02", "10:00");
  const idle = { ...initialMood(monday - 3 * HOUR), talked: 4, name: "content", why: "cooling" };
  const own = ownMood(idle, monday);
  assert.equal(own.name, ownDayMood(monday).name);
  assert.equal(own.why, "herDay");
  assert.equal(own.warmth, idle.warmth, "her day doesn't change how warm she is toward them");
  assert.equal(ownMood(own, monday + MIN), own, "nothing new: the same state, so nothing re-renders");
  // Not while they're talking, and not over something they caused.
  assert.equal(ownMood({ ...idle, lastUserAt: monday - 5 * MIN }, monday).name, "content");
  assert.ok(OWN_DAY_AFTER_MS >= 10 * MIN);
  const annoyed = { ...idle, name: "annoyed", why: "pestered" };
  assert.equal(ownMood(annoyed, monday), annoyed);
  const missing = { ...idle, name: "melancholy", why: "missed" };
  assert.equal(ownMood(missing, monday), missing);
});

test("her day's mood isn't on a timer, and doesn't flicker with the clock", () => {
  const start = ist("2026-11-02", "10:00");
  const fresh = { ...initialMood(start - HOUR), talked: 0 };
  let state = passTime(fresh, start);
  assert.equal(state.why, "herDay");
  // Ticks a minute apart, for hours: the mood changes only when her day does.
  let changes = 0;
  for (let minute = 1; minute <= 6 * 60; minute += 1) {
    const next = passTime(state, start + minute * MIN);
    if (next !== state) changes += 1;
    state = next;
  }
  assert.ok(changes <= 3, `changes only as her day moves on (${changes})`);
  // Someone she knows, gone for a day: she misses them, rather than carrying on with her day.
  const known = passTime({ ...initialMood(start - HOUR), talked: 12 }, start);
  assert.equal(resumeMood(known, start + 9 * HOUR).name, "melancholy");
  assert.equal(passTime(known, start + 9 * HOUR).why, "missed");
});

test("woken up by them she's groggy, not delighted; otherwise she's glad they're back", () => {
  const night = ist("2026-11-02", "05:00");
  const asleep = passTime({ ...initialMood(night - 6 * HOUR), talked: 30, lastUserAt: night - 6 * HOUR }, night);
  assert.equal(asleep.name, "tired");
  assert.equal(asleep.why, "sleepy");
  assert.notEqual(arrive(asleep, night).why, "back");
  const evening = ist("2026-11-02", "20:00");
  const home = passTime({ ...initialMood(evening - 2 * HOUR), talked: 30, lastUserAt: evening - 2 * HOUR }, evening);
  assert.equal(home.why, "herDay");
  assert.equal(arrive(home, evening).why, ["content", "tired", "restless", "melancholy"].includes(home.name) ? "back" : home.why);
});

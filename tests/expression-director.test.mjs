import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appraiseMessage, appraiseReply, directFace, initialDirector, isLongMessage, MOOD_SETTLE_MS, offerCue, REACTION_GAP_MS,
  restingFace, SAME_FACE_GAP_MS, THINKING_AFTER_MS,
} from "../lib/expression-director.ts";

const T = 10_000_000;
const settled = (name) => ({ name, since: T - MOOD_SETTLE_MS - 1 });
const situation = (extra = {}) => ({ now: T, mood: settled("neutral"), activity: "idle", activitySince: T - 60_000, intensity: "natural", ...extra });

test("at rest she's neutral, and an ordinary factual answer leaves her that way", () => {
  assert.deepEqual(directFace(initialDirector(), situation()).face, { expression: "neutral", level: 0 });
  assert.equal(appraiseReply("The capital of Peru is Lima. It sits on the coast and has about ten million people."), null);
  assert.equal(appraiseReply("yeah it's in the fridge"), null);
});

test("a mood shows only once it has settled, and only faintly", () => {
  const fresh = { name: "happy", since: T - 1000 };
  assert.equal(restingFace(fresh, T).expression, "neutral", "a passing change doesn't flash across her face");
  const shown = restingFace(settled("happy"), T);
  assert.equal(shown.expression, "smile");
  assert.ok(shown.level <= 0.4, "faint");
  for (const quiet of ["neutral", "content", "restless"]) assert.equal(restingFace(settled(quiet), T).expression, "neutral", quiet);
});

test("what she says sets the reaction: a joke, teasing, sympathy, surprise, a real question", () => {
  assert.equal(appraiseReply("LMAO no way you did that 😂").expression, "laugh");
  assert.equal(appraiseReply("haha fair").expression, "smile");
  assert.equal(appraiseReply("nice try 😏").expression, "playful");
  assert.equal(appraiseReply("ugh that sucks, i'm sorry").expression, "sad");
  assert.equal(appraiseReply("wait, what?! when?").expression, "surprised");
  assert.equal(appraiseReply("how come you quit?").expression, "curious");
  assert.equal(appraiseReply(`${"a long explanation of how it works, ".repeat(8)}does that make sense?`), null, "a long answer ending in a question isn't curiosity");
});

test("serious news keeps her composed: no smile, no surprise, at most restrained concern", () => {
  const news = "my grandma passed away last night";
  assert.equal(appraiseReply("haha", news), null, "never a laugh at bad news");
  assert.equal(appraiseReply("wait what?!", news), null);
  const concern = appraiseReply("oh no. i'm so sorry. are you okay?", news);
  assert.equal(concern.expression, "sad");
  assert.ok(concern.level <= 0.4, "restrained");
  assert.equal(appraiseMessage(news).expression, "sad");
  assert.equal(appraiseMessage("i got the job!!! 🎉").expression, "smile");
  assert.equal(appraiseMessage("ok what time tomorrow"), null);
});

test("a reaction holds, then eases back; and not every bubble gets one", () => {
  let state = offerCue(initialDirector(), appraiseReply("hahaha 😂"), T);
  assert.equal(directFace(state, situation()).face.expression, "laugh");
  const { nextChangeAt } = directFace(state, situation());
  assert.equal(directFace(state, situation({ now: nextChangeAt + 1 })).face.expression, "neutral");
  const again = offerCue(state, appraiseReply("lol"), T + 2000);
  assert.equal(again, state, "a second bubble two seconds later doesn't fire another face");
  state = offerCue(state, appraiseReply("lol"), T + REACTION_GAP_MS + 1);
  assert.equal(state.cue.expression, "smile");
});

test("the same face doesn't come back within 90 seconds: a laugh softens to a smile, or nothing", () => {
  let state = offerCue(initialDirector(), appraiseReply("LMAO 😂"), T);
  state = offerCue(state, appraiseReply("😂😂 stop"), T + REACTION_GAP_MS + 1);
  assert.equal(state.cue.expression, "smile", "softened");
  const third = offerCue(state, appraiseReply("LMAO 😂"), T + 2 * REACTION_GAP_MS + 2);
  assert.equal(third, state, "laugh and smile both used recently: nothing");
  const later = offerCue(state, appraiseReply("LMAO 😂"), T + SAME_FACE_GAP_MS + 1);
  assert.equal(later.cue.expression, "laugh");
});

test("a face they ask for always shows, cooldown or not", () => {
  const state = offerCue(initialDirector(), appraiseReply("haha"), T);
  const asked = offerCue(state, { expression: "surprised", level: 0.85, ms: 8000, reason: "asked" }, T + 100, { force: true });
  assert.equal(directFace(asked, situation({ now: T + 200 })).face.expression, "surprised");
});

test("reading shows only for a long message; thinking only when she's taking a while", () => {
  assert.equal(directFace(initialDirector(), situation({ activity: "reading", longMessage: false })).face.expression, "neutral");
  assert.equal(directFace(initialDirector(), situation({ activity: "reading", longMessage: true })).face.expression, "reading");
  const typing = situation({ activity: "typing", activitySince: T - 500 });
  const quick = directFace(initialDirector(), typing);
  assert.equal(quick.face.expression, "neutral", "a quick reply doesn't flash a thinking face");
  assert.equal(quick.nextChangeAt, T - 500 + THINKING_AFTER_MS);
  assert.equal(directFace(initialDirector(), { ...typing, now: T - 500 + THINKING_AFTER_MS }).face.expression, "thinking");
  assert.equal(directFace(initialDirector(), { ...typing, deliberating: true }).face.expression, "thinking", "the reasoning panel is real thinking");
  assert.ok(isLongMessage("so here's the thing. i don't know what to do."));
  assert.ok(!isLongMessage("hey"));
});

test("intensity: off is always neutral, subtle is fainter, expressive stronger", () => {
  const state = offerCue(initialDirector(), appraiseReply("haha"), T);
  assert.deepEqual(directFace(state, situation({ intensity: "off" })).face, { expression: "neutral", level: 0 });
  const subtle = directFace(state, situation({ intensity: "subtle" })).face.level;
  const natural = directFace(state, situation({ intensity: "natural" })).face.level;
  const expressive = directFace(state, situation({ intensity: "expressive" })).face.level;
  assert.ok(subtle < 0.5 && subtle < natural && natural < expressive && expressive <= 1, `${subtle} ${natural} ${expressive}`);
});

test("her glances come from her mood: bored looks away often, warm holds their eye, tired looks down", async () => {
  const { planGlance, moodMotion, STILL_MOTION } = await import("../lib/expression-director.ts");
  // A fixed sequence of "dice" so the plan is exact.
  const dice = (...values) => { let index = 0; return () => values[index++ % values.length]; };
  const average = (mood) => {
    let total = 0;
    for (let index = 0; index < 50; index += 1) total += planGlance(mood, 0.5, { random: dice(index / 50, 0.5, 0.5, 0.5) }).wait;
    return total / 50;
  };
  assert.ok(average("bored") < average("warm") / 2, "bored glances away far more often than warm");
  assert.ok(average("restless") < average("content"));
  const looks = (mood, options = {}) => new Set(Array.from({ length: 40 }, (_, index) => planGlance(mood, 0.5, { ...options, random: dice(0.3, index / 40, 0.5, 0.5) }).glance.look));
  assert.deepEqual([...looks("tired")].sort(), ["down", "left", "right"]);
  assert.ok(looks("annoyed").has("up"), "an eye-roll");
  assert.ok(looks("neutral").has("left") && looks("neutral").has("right"), "left and right both");
  const glance = planGlance("tired", 0.2, { random: dice(0.5, 0, 0.5, 0.5) }).glance;
  assert.equal(glance.look, "down");
  assert.ok(glance.y < 0 && glance.ms > 1000, "down, and held");
  assert.ok([...looks("excited", { typing: true })].includes("down"), "typing, she looks at her phone");
  // How she moves: nothing extra with expressions off, more with them on.
  assert.deepEqual(moodMotion("excited", "off"), STILL_MOTION);
  assert.ok(moodMotion("tired", "natural").droop > 0.4);
  assert.ok(moodMotion("excited", "natural").pace > moodMotion("tired", "natural").pace);
  assert.ok(moodMotion("warm", "natural").lean > 0 && moodMotion("bored", "natural").lean < 0);
});

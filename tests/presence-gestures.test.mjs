import assert from "node:assert/strict";
import { test } from "node:test";
import { gestureOffsets, initialGestures, kickBeat, kickKey, kickPoke, kickReaction, moodHabit, stepGestures } from "../lib/presence-gestures.ts";

/** Steps the springs for `seconds` at 60 fps and returns the largest |value| seen of `pick`. */
function run(g, seconds, pick, start = 0) {
  let peak = 0;
  for (let frame = 0; frame < seconds * 60; frame += 1) {
    stepGestures(g, 1 / 60);
    peak = Math.max(peak, Math.abs(pick(gestureOffsets(g, start + frame / 60))));
  }
  return peak;
}

test("reactions move her body: a laugh bounces, surprise jolts, sadness sinks, then it all settles", () => {
  const laugh = initialGestures();
  kickReaction(laugh, "laugh", 0.75, 0);
  assert.ok(run(laugh, 1, (move) => move.y) > 0.04, "a laugh lifts her");
  const surprise = initialGestures();
  kickReaction(surprise, "surprised", 0.5, 0);
  assert.ok(run(surprise, 0.5, (move) => move.scale - 1) > 0.05, "surprise makes her bigger at once");
  const sad = initialGestures();
  kickReaction(sad, "sad", 0.6, 0);
  stepGestures(sad, 1 / 60);
  assert.ok(gestureOffsets(sad, 0.1).y < -0.03, "sadness sinks");
  // Everything comes back to rest.
  for (const g of [laugh, surprise]) {
    run(g, 6, () => 0, 10);
    const rest = gestureOffsets(g, 20);
    assert.ok(Math.abs(rest.y) < 0.005 && Math.abs(rest.scale - 1) < 0.005, "settled");
  }
  // Thinking and glances have their own movement: no kick.
  const thinking = initialGestures();
  kickReaction(thinking, "thinking", 1, 0);
  assert.deepEqual(thinking, initialGestures());
});

test("each message she sends runs a ring; a poke too; typing shimmers and fades", () => {
  const g = initialGestures();
  kickBeat(g);
  assert.equal(g.pulse, 1);
  assert.equal(g.pulseAge, 0);
  run(g, 4, () => 0);
  assert.equal(g.pulse, 0, "the ring is gone after a few seconds");
  kickPoke(g);
  assert.equal(g.pulse, 1);
  const typing = initialGestures();
  for (let key = 0; key < 8; key += 1) kickKey(typing);
  assert.equal(typing.keys, 1, "capped");
  assert.ok(gestureOffsets(typing, 0).shimmer > 0.9);
  run(typing, 2, () => 0);
  assert.ok(typing.keys < 0.01, "stops when they stop");
});

test("mood habits come at irregular times, only while she's idle, and fit the mood", () => {
  const dice = (value) => () => value;
  const g = initialGestures();
  assert.equal(moodHabit(g, "bored", 100, true, dice(0.5)), null, "the first call only schedules");
  assert.ok(g.nextHabitAt > 100);
  assert.equal(moodHabit(g, "bored", g.nextHabitAt - 0.1, true, dice(0.5)), null, "not yet");
  assert.equal(moodHabit(g, "bored", g.nextHabitAt + 0.1, true, dice(0.5)), "sigh");
  assert.equal(moodHabit(g, "excited", g.nextHabitAt + 0.1, true, dice(0.5)), "hop");
  assert.equal(moodHabit(g, "restless", g.nextHabitAt + 0.1, true, dice(0.9)), "wander");
  assert.equal(moodHabit(g, "annoyed", g.nextHabitAt + 0.1, true, dice(0.2)), "shake");
  // Busy (thinking or talking): habits wait.
  const busy = initialGestures();
  moodHabit(busy, "excited", 0, true, dice(0.5));
  assert.equal(moodHabit(busy, "excited", busy.nextHabitAt + 1, false, dice(0.5)), null);
  // Irregular: different dice, different gaps.
  const a = initialGestures();
  const b = initialGestures();
  moodHabit(a, "restless", 0, true, dice(0.1));
  moodHabit(b, "restless", 0, true, dice(0.1));
  moodHabit(a, "restless", 50, true, dice(0.1));
  moodHabit(b, "restless", 50, true, dice(0.9));
  assert.notEqual(a.nextHabitAt, b.nextHabitAt);
});

test("a sigh swells, then lets go and sinks", () => {
  const g = initialGestures();
  g.sighAt = 0;
  assert.ok(gestureOffsets(g, 1.4).scale > 1.05, "breathes in");
  assert.ok(gestureOffsets(g, 2.4).y < 0, "and out, lower");
  assert.equal(gestureOffsets(g, 5).scale, 1, "then it's over");
});

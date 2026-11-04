import assert from "node:assert/strict";
import { test } from "node:test";
import { jobKind, planEnqueue } from "../lib/reply-queue.ts";

const msg = (targetId, conversationId = "c") => ({ conversationId, targetId });
const thread = (...rows) => rows.map(([id, role]) => ({ id, role }));

test("a new message while she's replying in that chat interrupts her, and she knows if she'd started", () => {
  const started = planEnqueue(msg("b"), { job: msg("a"), posted: 2 }, [], thread(["a", "user"], ["r1", "assistant"], ["b", "user"]));
  assert.equal(started.abortActive, true);
  assert.deepEqual(started.waiting, [{ ...msg("b"), interrupted: true }]);
  const notYet = planEnqueue(msg("b"), { job: msg("a"), posted: 0 }, [], thread(["a", "user"], ["b", "user"]));
  assert.equal(notYet.abortActive, true, "nothing on screen yet: restarted for both messages");
  assert.equal(notYet.waiting[0].interrupted, undefined, "she hadn't said anything, so there's nothing to have been cut off");
});

test("interrupting jumps ahead of other chats and drops what she meant to text first here", () => {
  const waiting = [msg("x", "other"), { ...msg("i"), initiative: true }, { ...msg("p"), extraPrompt: "continue" }];
  const plan = planEnqueue(msg("b"), { job: msg("a"), posted: 1 }, waiting, []);
  assert.deepEqual(plan.waiting.map((job) => job.targetId), ["b", "x", "p"]);
});

test("messages she hasn't started on are answered together, until she has spoken in between", () => {
  const waiting = [msg("a")];
  const merged = planEnqueue(msg("b"), null, waiting, thread(["a", "user"], ["b", "user"]));
  assert.equal(merged.abortActive, false);
  assert.deepEqual(merged.waiting, [msg("b")], "one reply, to the latest");
  const split = planEnqueue(msg("c"), null, [msg("a")], thread(["a", "user"], ["r", "assistant"], ["c", "user"]));
  assert.deepEqual(split.waiting.map((job) => job.targetId), ["a", "c"], "she spoke after the first: the new one gets its own reply");
});

test("a message in another chat doesn't interrupt the one she's in", () => {
  const plan = planEnqueue(msg("z", "other"), { job: msg("a"), posted: 1 }, [], []);
  assert.equal(plan.abortActive, false);
  assert.deepEqual(plan.waiting, [msg("z", "other")]);
});

test("she doesn't text first into a conversation that's already going", () => {
  const first = { ...msg("last"), initiative: true };
  assert.deepEqual(planEnqueue(first, { job: msg("a"), posted: 0 }, [], []).waiting, []);
  assert.deepEqual(planEnqueue(first, null, [msg("a")], []).waiting, [msg("a")]);
  assert.deepEqual(planEnqueue(first, null, [], []).waiting, [first]);
  assert.deepEqual(planEnqueue(msg("b"), null, [first], thread(["b", "user"])).waiting, [msg("b")], "their message replaces the text she was about to send");
});

test("her own follow-ups wait their turn and never interrupt", () => {
  const more = { ...msg("t"), extraPrompt: "Continue" };
  const plan = planEnqueue(more, { job: msg("a"), posted: 3 }, [], []);
  assert.equal(plan.abortActive, false);
  assert.deepEqual(plan.waiting, [more]);
  assert.equal(jobKind(more), "continue");
  assert.equal(jobKind({ ...msg("e"), event: { kind: "x" } }), "event");
});

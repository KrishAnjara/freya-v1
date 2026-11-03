import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanReply, guardText } from "../lib/reply-guard.ts";

const context = { lastUserText: "what's a black hole", recentUserTexts: ["what's a black hole"] };

test("customer-service openers are lifted out, and the rest of the reply stays", () => {
  assert.equal(cleanReply("Certainly! A black hole is where gravity wins.", context), "A black hole is where gravity wins.");
  assert.equal(cleanReply("Great question! it's gravity winning", context), "it's gravity winning");
  assert.equal(cleanReply("That's interesting! never thought of it", context), "never thought of it");
  assert.equal(cleanReply("I'd be happy to help with that: start with the mass.", context), "start with the mass.");
  assert.equal(cleanReply("Absolutely!", context), "", "an opener on its own is dropped");
});

test("ordinary ways friends talk are left alone", () => {
  for (const reply of ["of course i remember lol", "sure, why not", "absolutely not, that's cursed", "that's interesting tbh but no", "certainly not today"]) {
    assert.equal(cleanReply(reply, context), reply, reply);
  }
});

test("a whole reply loses only its opener", async () => {
  const reply = await guardText(async () => "Certainly! It's a place where gravity is so strong that light can't get out.", { ...context, recentReplies: [], styleChecks: true });
  assert.equal(reply, "It's a place where gravity is so strong that light can't get out.");
});

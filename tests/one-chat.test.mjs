import assert from "node:assert/strict";
import { test } from "node:test";
import { chatDiff, deleteForEveryone, deleteForMe, forHer, forMe, mergeChats, mergeCloud } from "../lib/one-chat.ts";
import { pictureIntent } from "../lib/picture-intent.ts";

const m = (id, at, role = "user", extra = {}) => ({ id, role, content: id, at: `2026-11-0${at}T10:00:00Z`, ...extra });

test("separate chats from before become one long chat, in time order, each message once", () => {
  const merged = mergeChats([{ messages: [m("b", 3), m("d", 5)] }, { messages: [m("a", 1), m("c", 4), m("b", 3)] }]);
  assert.deepEqual(merged.map((message) => message.id), ["a", "b", "c", "d"]);
});

test("delete for me hides it here only; delete for everyone takes it out of what she reads too", () => {
  const chat = [m("a", 1), m("r", 2, "assistant", { turn: "t" }), m("b", 3, "user", { attachments: [{ id: "x" }] })];
  const mine = deleteForMe(chat, "a");
  assert.deepEqual(forMe(mine).map((message) => message.id), ["r", "b"], "gone from view");
  assert.deepEqual(forHer(mine).map((message) => message.id), ["a", "r", "b"], "she still has it");
  const gone = deleteForEveryone(chat, "b");
  assert.equal(gone[2].deleted, true);
  assert.equal(gone[2].content, "", "the text is gone");
  assert.equal(gone[2].attachments, undefined, "and its file");
  assert.deepEqual(forHer(gone).map((message) => message.id), ["a", "r"], "she forgets it");
  assert.equal(forMe(gone).length, 3, "a placeholder stays where it was");
});

test("the cloud copy and this browser's merge, and a deletion made on either side wins", () => {
  const cloud = [m("a", 1), m("b", 2, "user", { deleted: true, content: "" })];
  const local = [m("a", 1, "user", { hiddenForMe: true }), m("b", 2), m("c", 3)];
  const merged = mergeCloud(local, cloud);
  assert.deepEqual(merged.map((message) => message.id), ["a", "b", "c"]);
  assert.equal(merged[0].hiddenForMe, true);
  assert.equal(merged[1].deleted, true);
  const { upsert, remove } = chatDiff(new Map([["a", JSON.stringify(merged[0])], ["z", "{}"]]), merged);
  assert.deepEqual(upsert, ["b", "c"], "only what changed is written");
  assert.deepEqual(remove, ["z"], "what's gone is removed");
});

test("only real picture requests count: talk about pictures doesn't", () => {
  assert.equal(pictureIntent("mirror pic from behind pls")?.kind, "clear");
  assert.equal(pictureIntent("show me the view outside")?.ofHer, false);
  for (const text of ["i sent you a pic earlier", "nice pic", "do you like taking photos?", "that photo you sent was cute", "send me a pic of me"]) {
    assert.equal(pictureIntent(text), null, text);
  }
});

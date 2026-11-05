import assert from "node:assert/strict";
import { test } from "node:test";
import { chatDiff, clearForMe, deleteForEveryone, deleteForMe, forHer, forMe, mergeChats, mergeCloud, pushChat } from "../lib/one-chat.ts";
import { pictureIntent } from "../lib/picture-intent.ts";

const m = (id, at, role = "user", extra = {}) => ({ id, role, content: id, at: `2026-11-0${at}T10:00:00Z`, ...extra });

test("separate chats from before become one long chat, in time order, each message once", () => {
  const merged = mergeChats([{ messages: [m("b", 3), m("d", 5)] }, { messages: [m("a", 1), m("c", 4), m("b", 3)] }]);
  assert.deepEqual(merged.map((message) => message.id), ["a", "b", "c", "d"]);
});

test("delete for me hides it on every device; delete for everyone takes it out of what she reads too", () => {
  const chat = [m("a", 1), m("r", 2, "assistant", { turn: "t" }), m("b", 3, "user", { attachments: [{ id: "x" }] })];
  const mine = deleteForMe(chat, "a");
  assert.deepEqual(forMe(mine).map((message) => message.id), ["r", "b"], "gone from view");
  assert.deepEqual(forHer(mine).map((message) => message.id), ["a", "r", "b"], "she still has it");
  const gone = deleteForEveryone(chat, "b");
  assert.deepEqual(gone.map((message) => message.id), ["a", "r"], "nothing of it is kept");
  assert.deepEqual(forHer(gone).map((message) => message.id), ["a", "r"], "she forgets it");
  const cleared = clearForMe(chat);
  assert.equal(forMe(cleared).length, 0, "clear chat: nothing shown");
  assert.equal(forHer(cleared).length, 3, "she still has every message");
});

test("the chat is written to Supabase only: shown messages, deleted-for-me ones moved, deleted-for-everyone ones removed", async () => {
  const calls = [];
  const table = (name) => ({
    upsert: async (rows) => { calls.push(["upsert", name, rows.map((row) => row.id)]); return { error: null }; },
    delete: () => ({ eq: () => ({ in: async (_column, ids) => { calls.push(["delete", name, ids]); return { error: null }; } }) }),
  });
  const client = { from: table };
  const chat = [m("a", 1), m("b", 2, "user", { hiddenForMe: true })];
  assert.equal(await pushChat(client, "u1", chat, ["a", "b"], ["z"]), true);
  assert.deepEqual(calls, [
    ["upsert", "freya_messages", ["a"]],
    ["upsert", "freya_deleted_messages", ["b"]],
    ["delete", "freya_messages", ["b"]],
    ["delete", "freya_messages", ["z"]],
    ["delete", "freya_deleted_messages", ["z"]],
  ]);
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

test("the trigger scanner finds a request anywhere in a message, and nothing in talk about pictures", () => {
  const found = pictureIntent("i was thinking to see u can u send a picture of you right now");
  assert.equal(found?.kind, "clear");
  assert.equal(found.ofHer, true);
  assert.equal(found.subject, "you", "\"right now\" isn't part of what to draw");
  assert.equal(pictureIntent("ugh long day. could you send a selfie in bed")?.subject, "in bed");
  assert.equal(pictureIntent("i wanna see a pic of you")?.kind, "clear");
  assert.equal(pictureIntent("honestly i miss you, send me a pic")?.ofHer, true);
  assert.match(pictureIntent("can u send nudes").subject, /nude/, "nudity asked for stays in the words");
  for (const text of ["my pic is ugly lol", "i saw a nice photo today", "i took a photo of the sunset, can you see it"]) {
    assert.equal(pictureIntent(text), null, text);
  }
});

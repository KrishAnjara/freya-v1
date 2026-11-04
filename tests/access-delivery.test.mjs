import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { checkAccess, isOpenRoute, ownerEmail, resetAccessCacheForTests } from "../lib/access.ts";
import { canEdit, deliveryOf, thoughtful } from "../lib/delivery.ts";
import { CONTINUE_PROMPT, resumeJobs } from "../lib/resume.ts";

const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); process.env[name] = value; }
afterEach(() => {
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetAccessCacheForTests();
});

/** A fake Supabase: who each token is, and which browser session each account last claimed. */
function supabase(users, sessions = {}, { table = true } = {}) {
  return async (url, init) => {
    const token = init.headers.Authorization.replace("Bearer ", "");
    if (String(url).endsWith("/auth/v1/user")) {
      return users[token] ? new Response(JSON.stringify(users[token]), { status: 200 }) : new Response("{}", { status: 401 });
    }
    if (!table) return new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 });
    const id = decodeURIComponent(String(url).match(/user_id=eq\.([^&]+)/)[1]);
    return new Response(JSON.stringify(sessions[id] ? [{ session_id: sessions[id] }] : []), { status: 200 });
  };
}
const request = (token, session) => new Headers({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { "x-freya-session": session } : {}) });
const both = { ownerOnly: true, oneSession: true };

test("only the owner's account gets in; everyone else is refused, signed in or not", async () => {
  setEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  setEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  assert.equal(ownerEmail(), "krishanjara@zohomail.in");
  const fake = supabase({ owner: { id: "u1", email: "Krishanjara@zohomail.in" }, other: { id: "u2", email: "someone@else.com" } });
  assert.deepEqual(await checkAccess(request("owner"), { ownerOnly: true, oneSession: false }, fake), { ok: true, userId: "u1" });
  assert.equal((await checkAccess(request("other"), { ownerOnly: true, oneSession: false }, fake)).code, "not-allowed");
  assert.equal((await checkAccess(request(), { ownerOnly: true, oneSession: false }, fake)).status, 401);
  assert.equal((await checkAccess(request("expired"), { ownerOnly: true, oneSession: false }, fake)).code, "sign-in");
  assert.deepEqual(await checkAccess(request(), { ownerOnly: false, oneSession: false }, fake), { ok: true }, "both switches off: open, as before");
  assert.equal(isOpenRoute("/api/session"), true);
  assert.equal(isOpenRoute("/api/chat"), false);
});

test("one browser per account: the newest sign-in wins, an older browser is refused", async () => {
  setEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  setEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  const fake = supabase({ owner: { id: "u1", email: "krishanjara@zohomail.in" } }, { u1: "browser-b" });
  assert.equal((await checkAccess(request("owner", "browser-b"), both, fake)).ok, true);
  const old = await checkAccess(request("owner", "browser-a"), both, fake);
  assert.equal(old.status, 409);
  assert.equal(old.code, "session-replaced");
  resetAccessCacheForTests();
  const noTable = supabase({ owner: { id: "u1", email: "krishanjara@zohomail.in" } }, {}, { table: false });
  assert.equal((await checkAccess(request("owner", "anything"), both, noTable)).ok, true, "without the table it can't be enforced, and nothing breaks");
});

test("without Supabase set up, an owner-only server refuses rather than opening up", async () => {
  setEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  assert.equal((await checkAccess(request("owner"), both, async () => { throw new Error("no"); })).code, "unavailable");
});

test("ticks: sent, delivered, seen; and editing locks once she's seen it", () => {
  const thread = [
    { role: "user", delivered: true, seenAt: "2026-11-04T10:00:00Z" },
    { role: "assistant" },
    { role: "user" },
    { role: "user", delivered: true },
    { role: "user", failed: true },
  ];
  assert.deepEqual(thread.map((message, index) => deliveryOf(message, index, thread)), ["seen", "seen", "sent", "delivered", "failed"].map((value, index) => index === 1 ? deliveryOf(thread[1], 1, thread) : value));
  assert.equal(canEdit(thread[0], 0, thread), false, "seen: locked");
  assert.equal(canEdit(thread[2], 2, thread), true, "not yet seen: can still be fixed");
  assert.equal(canEdit(thread[3], 3, thread), true);
  const old = [{ role: "user" }, { role: "assistant" }];
  assert.equal(deliveryOf(old[0], 0, old), "seen", "older chats: answered means seen");
  assert.equal(thoughtful("what do you think i should do about my job"), true);
  assert.equal(thoughtful("lol"), false);
});

test("after a refresh she picks up what she owed: unanswered messages again, a cut-off reply carries on", () => {
  const now = 1_000_000_000;
  const conversations = [
    { id: "c", messages: [{ id: "m1", role: "user" }, { id: "r1", role: "assistant" }, { id: "m2", role: "user" }] },
    { id: "d", messages: [{ id: "x", role: "user" }] },
  ];
  const cutOff = { active: { conversationId: "c", targetId: "m1", posted: 1, lastPostedId: "r1" }, waiting: [{ conversationId: "d", targetId: "x" }], savedAt: now - 60_000 };
  assert.deepEqual(resumeJobs(cutOff, conversations, now), [
    { conversationId: "c", targetId: "r1", extraPrompt: CONTINUE_PROMPT, turn: undefined },
    { conversationId: "d", targetId: "x" },
  ]);
  const notStarted = { active: { conversationId: "c", targetId: "m2", posted: 0 }, waiting: [{ conversationId: "c", targetId: "m1", initiative: true }], savedAt: now };
  assert.deepEqual(resumeJobs(notStarted, conversations, now), [{ conversationId: "c", targetId: "m2" }], "her own unprompted text isn't resumed");
  assert.deepEqual(resumeJobs({ ...notStarted, active: { conversationId: "c", targetId: "m1", posted: 0 } }, conversations, now), [], "already answered");
  assert.deepEqual(resumeJobs(notStarted, conversations, now + 31 * 60_000), [], "too long ago");
  assert.deepEqual(resumeJobs(null, conversations, now), []);
});

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMemoryStore, normalizeEpisode, normalizeNotes, resetMemoryStoreForTests } from "../lib/memory-store.ts";
import { bm25, dueSoon, episodeSection, recall, tokenize } from "../lib/memory-recall.ts";
import { DELETE, GET, POST as keepEpisode, PUT } from "../app/api/memory/route.ts";
import { POST as chatPost } from "../app/api/chat/route.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetMemoryStoreForTests();
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const note = (id, text, extra = {}) => ({ id, text, createdAt: iso(10), ...extra });

// --- the store ------------------------------------------------------------------------------

test("notes and recaps survive a restart: they're on disk, not in the browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "freya-memory-"));
  try {
    setEnv("FREYA_MEMORY_PATH", join(dir, "freya-memory.db"));
    resetMemoryStoreForTests();
    const store = getMemoryStore();
    assert.equal(store.kind, "sqlite");
    store.replaceNotes("owner", normalizeNotes([note("n1", "Has a driving test on 2026-11-12."), note("n2", "Prefers short replies.", { kind: "preference" })]));
    store.upsertEpisode("owner", normalizeEpisode({ id: "c1", title: "Driving nerves", recap: "They were nervous about parallel parking; we joked it's a personality test." }));
    resetMemoryStoreForTests();
    const reopened = getMemoryStore();
    assert.deepEqual(reopened.notes("owner").map((item) => item.id).sort(), ["n1", "n2"]);
    assert.equal(reopened.episodes("owner")[0].title, "Driving nerves");
    assert.deepEqual(reopened.notes("someone-else"), [], "one owner's memory isn't another's");
  } finally {
    resetMemoryStoreForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncing keeps usage and vectors for unchanged notes, and drops the vector of an edited one", () => {
  const store = getMemoryStore();
  store.replaceNotes("o", normalizeNotes([note("a", "Loves rock climbing."), note("b", "Has a cat called Miso.")]));
  store.markUsed("o", ["a"], iso(0));
  store.setVector("o", "notes", "a", { model: "embed", values: [1, 0] });
  store.setVector("o", "notes", "b", { model: "embed", values: [0, 1] });
  store.replaceNotes("o", normalizeNotes([note("a", "Loves rock climbing."), note("b", "Has two cats, Miso and Tofu.")]));
  const notes = store.notes("o");
  assert.equal(notes.find((item) => item.id === "a").uses, 1);
  assert.deepEqual([...store.vectors("o", "notes").keys()], ["a"]);
});

test("credentials and junk never get stored, whatever the browser sends", () => {
  const notes = normalizeNotes([
    note("ok", "Works night shifts at a hospital."),
    note("key", "My key is sk-abcdefghijklmnopqrstuvwxyz123456"),
    note("ok", "duplicate id"),
    { id: "", text: "no id" },
    "not an object",
  ]);
  assert.deepEqual(notes.map((item) => item.id), ["ok"]);
  assert.equal(normalizeEpisode({ id: "x", recap: "" }), null);
});

test("episodes: one per conversation, updated in place, deletable, all clearable", () => {
  const store = getMemoryStore();
  store.upsertEpisode("o", normalizeEpisode({ id: "c1", title: "A", recap: "first take", updatedAt: iso(3) }));
  store.upsertEpisode("o", normalizeEpisode({ id: "c1", title: "A", recap: "they came back to it", updatedAt: iso(1) }));
  store.upsertEpisode("o", normalizeEpisode({ id: "c2", title: "B", recap: "something else", updatedAt: iso(2) }));
  assert.deepEqual(store.episodes("o").map((item) => [item.id, item.recap]), [["c1", "they came back to it"], ["c2", "something else"]]);
  store.deleteEpisode("o", "c2");
  assert.equal(store.episodes("o").length, 1);
  store.clear("o", "all");
  assert.deepEqual([store.notes("o").length, store.episodes("o").length], [0, 0]);
});

// --- recall ---------------------------------------------------------------------------------

test("words are matched loosely: plurals and tenses still meet", () => {
  assert.deepEqual(tokenize("Interviews"), tokenize("interview"));
  assert.ok(tokenize("I was climbing").includes(tokenize("climbed")[0]));
  const scores = bm25([tokenize("driving test next week"), tokenize("loves pasta")], tokenize("my driving test"));
  assert.ok(scores[0] > 0 && scores[1] === 0);
});

test("days later, the relevant note and the earlier conversation come back without repeating anything", () => {
  const notes = [
    note("drive", "Has a driving test on 2026-11-12, nervous about parallel parking.", { kind: "open" }),
    note("pasta", "Loves cooking pasta from scratch.", { kind: "interest" }),
    note("sister", "Has a younger sister, Priya, who studies medicine.", { kind: "person" }),
    note("short", "Prefers short replies.", { kind: "preference" }),
  ];
  const episodes = [
    { id: "old", title: "Parking panic", recap: "They practised parallel parking and nearly hit a bin; we joked about it being a personality test.", updatedAt: iso(5) },
    { id: "other", title: "Recipes", recap: "We swapped pasta recipes.", updatedAt: iso(6) },
  ];
  const result = recall({ notes, episodes, recent: ["ugh the test is coming up and parking still scares me"], now: NOW, conversationId: "today" });
  const ids = result.notes.map((item) => item.id);
  assert.ok(ids.includes("drive"), "the test itself");
  assert.ok(ids.includes("short"), "how they like to be talked to applies to everything");
  assert.ok(!ids.includes("pasta") && !ids.includes("sister"), `nothing unrelated padded in: ${ids}`);
  assert.deepEqual(result.episodes.map((item) => item.id), ["old"]);
});

test("nothing relevant means nothing recalled, never a loosely related guess", () => {
  const result = recall({ notes: [note("pasta", "Loves cooking pasta from scratch.")], episodes: [{ id: "e", title: "Recipes", recap: "We swapped pasta recipes.", updatedAt: iso(1) }], recent: ["what's the capital of peru"], now: NOW });
  assert.deepEqual(result, { notes: [], episodes: [] });
});

test("the conversation being answered isn't recalled into itself", () => {
  const episodes = [{ id: "here", title: "Parking", recap: "Parallel parking practice.", updatedAt: iso(0) }];
  assert.equal(recall({ notes: [], episodes, recent: ["parallel parking again"], conversationId: "here", now: NOW }).episodes.length, 0);
});

test("a follow-up that's due soon comes up even when they haven't mentioned it", () => {
  const notes = [note("interview", "Freya said she'd ask how the interview on 2026-11-05 went.", { kind: "open" })];
  assert.equal(dueSoon(notes[0].text, NOW), true);
  assert.equal(recall({ notes, episodes: [], recent: ["hey"], now: NOW }).notes.length, 1);
  assert.equal(dueSoon("Exam on 2026-12-20.", NOW), false);
});

test("embeddings find matches by meaning that share no words", () => {
  const notes = [note("bio", "Studying for a biology exam."), note("film", "Watched Dune twice.")];
  const vectors = new Map([["bio", { model: "e", values: [0.9, 0.1, 0] }], ["film", { model: "e", values: [0, 0.1, 0.9] }]]);
  const withMeaning = recall({ notes, episodes: [], recent: ["my cell test is on friday"], now: NOW, queryVector: { model: "e", values: [0.88, 0.12, 0.02] }, noteVectors: vectors });
  assert.deepEqual(withMeaning.notes.map((item) => item.id), ["bio"]);
  const otherModel = recall({ notes, episodes: [], recent: ["my cell test is on friday"], now: NOW, queryVector: { model: "other", values: [0.88, 0.12, 0.02] }, noteVectors: vectors });
  assert.equal(otherModel.notes.length, 0, "vectors from a different model are never compared");
});

test("the recall section is honest about what it is", () => {
  const text = episodeSection([{ id: "e", title: "Parking", recap: "Parallel parking practice.", updatedAt: iso(2) }], NOW);
  assert.match(text, /2 days ago, "Parking": Parallel parking practice\./);
  assert.match(text, /Never claim to remember more than these notes say/);
  assert.equal(episodeSection([], NOW), "");
});

// --- the API --------------------------------------------------------------------------------

const call = (handler, method, { body, query = "", origin } = {}) => handler(new Request(`http://localhost/api/memory${query}`, {
  method,
  headers: { "content-type": "application/json", "x-real-ip": "203.0.113.90", ...(origin ? { origin } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
}));

function apiEnv() {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, FREYA_TRUSTED_IP_HEADER: undefined, FREYA_SELF_HOSTED: "true" })) setEnv(k, v);
}

test("the memory API reads, syncs, keeps recaps and forgets", async () => {
  apiEnv();
  assert.deepEqual((await (await call(GET, "GET")).json()).notes, []);
  const put = await (await call(PUT, "PUT", { body: { notes: [note("n1", "Has a cat called Miso.")] } })).json();
  assert.equal(put.notes[0].text, "Has a cat called Miso.");
  await call(keepEpisode, "POST", { body: { episode: { id: "c1", title: "Cats", recap: "We talked about Miso's zoomies." } } });
  const all = await (await call(GET, "GET")).json();
  assert.equal(all.enabled, true);
  assert.equal(all.episodes[0].recap, "We talked about Miso's zoomies.");
  await call(DELETE, "DELETE", { query: "?episode=c1" });
  assert.equal((await (await call(GET, "GET")).json()).episodes.length, 0);
  await call(DELETE, "DELETE", { query: "?scope=all" });
  assert.equal((await (await call(GET, "GET")).json()).notes.length, 0);
  assert.equal((await call(DELETE, "DELETE", { query: "?scope=everything" })).status, 400);
});

test("another website can't read or change her memory", async () => {
  apiEnv();
  assert.equal((await call(GET, "GET", { origin: "https://evil.example.com" })).status, 403);
  assert.equal((await call(PUT, "PUT", { origin: "https://evil.example.com", body: { notes: [] } })).status, 403);
  assert.equal((await call(GET, "GET", { origin: "http://localhost" })).status, 200);
});

test("a public deployment doesn't keep one shared memory for everyone", async () => {
  const { memoryStoreEnabled } = await import("../lib/memory-store.ts");
  setEnv("FREYA_SELF_HOSTED", undefined);
  setEnv("NODE_ENV", "production");
  assert.equal(memoryStoreEnabled(), false);
  assert.equal(getMemoryStore(), null);
  setEnv("FREYA_SELF_HOSTED", "true");
  assert.equal(memoryStoreEnabled(), true, "your own install keeps it");
  setEnv("FREYA_MEMORY_STORE", "off");
  assert.equal(memoryStoreEnabled(), false, "and it can be switched off");
});

// --- the chat route -------------------------------------------------------------------------

test("a reply recalls what's on disk: the note and the earlier conversation reach her prompt", async () => {
  apiEnv();
  for (const [k, v] of Object.entries({ AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "groq-test", GROQ_FALLBACK_MODELS: "", WEB_SEARCH_ENABLED: "false", FREYA_REASONING_MODE: "off", FREYA_LOCAL_ONLY: "false" })) setEnv(k, v);
  const store = getMemoryStore();
  store.replaceNotes("self-hosted-owner", normalizeNotes([note("drive", "Has a driving test on 2026-11-12.", { kind: "open" }), note("pasta", "Loves pasta.")]));
  store.upsertEpisode("self-hosted-owner", normalizeEpisode({ id: "earlier", title: "Parking panic", recap: "They nearly hit a bin parallel parking; the driving test scares them.", updatedAt: new Date().toISOString() }));
  let system = "";
  globalThis.fetch = async (url, init) => {
    system = JSON.parse(String(init.body)).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: "you've got this" } }] }), { status: 200 });
  };
  const response = await chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.91" }, body: JSON.stringify({ messages: [{ role: "user", content: "the driving test is next week and i'm freaking out about parking" }], conversationId: "today" }) }));
  assert.equal(response.status, 200);
  assert.match(system, /driving test on 2026-11-12/);
  assert.match(system, /EARLIER CONVERSATIONS THAT RELATE TO THIS[\s\S]*nearly hit a bin/);
  assert.doesNotMatch(system, /Loves pasta/, "only what's relevant");
  assert.equal(store.notes("self-hosted-owner").find((item) => item.id === "drive").uses, 1, "use is counted");
});

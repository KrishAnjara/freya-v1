import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { normalizeLocalMemories, selectRelevantMemories, MEMORY_PROMPT_CHARS } from "../lib/memory-select.ts";
import { reflectionInput, validateChanges } from "../lib/memory-reflection.ts";
import { applyChangesLocally, describeChanges, reflectionWindow } from "../lib/memory-client.ts";
import { commandHints, parseCommand, pictureRequest } from "../lib/composer-commands.ts";
import { samplePartsCloud, sampleReliefCloud, validateSpec } from "../lib/visualize.ts";
import { sanitizeSvg } from "../lib/svg-safety.ts";
import { containsSensitiveCredential } from "../lib/sensitive-data.ts";
import { POST as reflectPost } from "../app/api/memory/reflect/route.ts";
import { POST as imagePost } from "../app/api/image/route.ts";
import { POST as visualizePost } from "../app/api/visualize/route.ts";
import { POST as chatPost } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
function env(extra = {}) {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test", AI_PROVIDER: "groq", GROQ_MODEL: "voice-model", GROQ_FALLBACK_MODELS: "", WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false", FREYA_REASONING_MODE: "off", ...extra })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER", "FREYA_SELF_HOSTED"]) setEnv(k, undefined);
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  resetLocalRateLimitsForTests();
});
const post = (handler, url, body) => handler(new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" }, body: JSON.stringify(body) }));
const groqJson = (data) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });

// --- memory selection ---------------------------------------------------------------------

test("memory selection ranks by the recent conversation, keeps standing preferences, and fits the budget", () => {
  const memories = [
    { id: "a", text: "Has a driving test on 2026-11-20 and is nervous about parallel parking.", createdAt: "2026-10-01" },
    { id: "b", text: "Prefers short replies without lists.", createdAt: "2026-09-01" },
    { id: "c", text: "Supports Arsenal.", createdAt: "2026-08-01" },
  ];
  const picked = selectRelevantMemories(memories, ["ugh", "practising parking again today"]);
  assert.deepEqual(picked.map((memory) => memory.id), ["a", "b"]);
  // A conversation that opens with "hey" still gets the newest notes to pick up from.
  assert.ok(selectRelevantMemories(memories, ["hey"], true).some((memory) => memory.id === "a"));
  const many = Array.from({ length: 30 }, (_, index) => ({ id: String(index), text: `Prefers option ${index} ${"x".repeat(150)}` }));
  const chosen = selectRelevantMemories(many, ["which option"]);
  assert.ok(chosen.reduce((sum, memory) => sum + memory.text.length, 0) <= MEMORY_PROMPT_CHARS);
});

test("browser-sent memories are bounded and credential-free", () => {
  const local = normalizeLocalMemories([
    { id: "1", text: "Has a sister, Priya." },
    { id: "2", text: "api_key=super-secret-value-123" },
    { id: 3, text: "bad id" },
    { id: "4", text: "x".repeat(900) },
  ], containsSensitiveCredential);
  assert.deepEqual(local.map((memory) => memory.id), ["1", "4"]);
  assert.equal(local[1].text.length, 240);
});

// --- reflection validation ----------------------------------------------------------------

test("reflection changes are validated: known ids only, no contacts or secrets, no duplicates or forgotten notes", () => {
  const memories = [{ id: "m1", text: "Has a driving test on 2026-11-06." }];
  const changes = validateChanges({
    add: [
      { text: "Has a sister named Priya who studies medicine in Pune.", kind: "person" },
      { text: "Has a sister named Priya who studies medicine in Pune now.", kind: "other" },
      { text: "Phone number is +91 98765 43210.", kind: "other" },
      { text: "Works night shifts at a warehouse.", kind: "event" },
      { text: "Has a driving test on 2026-11-06.", kind: "open" },
      { text: "short" },
    ],
    update: [{ id: "m1", text: "Has a driving test on 2026-11-20.", kind: "open" }, { id: "nope", text: "Unknown note id here." }],
    remove: [{ id: "ghost" }],
  }, memories, ["Works night shifts at a warehouse."], containsSensitiveCredential);
  assert.deepEqual(changes.add.map((item) => item.text), ["Has a sister named Priya who studies medicine in Pune."]);
  assert.deepEqual(changes.update, [{ id: "m1", text: "Has a driving test on 2026-11-20.", kind: "open" }], "a date is not a phone number");
  assert.deepEqual(changes.remove, []);
  assert.deepEqual(validateChanges("not json", memories, [], containsSensitiveCredential), { add: [], update: [], remove: [] });
});

test("reflection input gives a calendar to look dates up in", () => {
  const input = reflectionInput([{ role: "user", content: "test next friday" }], [], [], "2026-10-30");
  assert.match(input, /TODAY: Friday 2026-10-30/);
  assert.match(input, /Friday 2026-11-06/);
});

test("the reflection window needs enough new conversation and skips intimate turns", () => {
  const thread = [
    { role: "user", content: "hi" }, { role: "assistant", content: "hey" },
    { role: "user", content: "my sister got into med school" }, { role: "assistant", content: "huge" },
    { role: "user", content: "kiss me, I want you" }, { role: "assistant", content: "come here" },
    { role: "user", content: "also my exam is on monday" }, { role: "assistant", content: "good luck" },
  ];
  assert.equal(reflectionWindow(thread.slice(0, 2), 0, false), null, "one short message is not enough");
  const window = reflectionWindow(thread, 0, true);
  assert.equal(window.upTo, 8);
  assert.ok(!window.turns.some((turn) => /kiss|come here/.test(turn.content)), "intimate turns never reach a hosted model");
  assert.equal(reflectionWindow(thread, 8, false), null, "nothing new since the last reflection");
});

test("local changes keep ids, mark FREYA's notes and describe what happened honestly", () => {
  const memories = [{ id: "m1", text: "Old", createdAt: "2026-01-01" }, { id: "m2", text: "Gone", createdAt: "2026-01-01" }];
  const changes = { add: [{ text: "New note about them.", kind: "project" }], update: [{ id: "m1", text: "Updated", kind: "open" }], remove: [{ id: "m2" }] };
  const next = applyChangesLocally(memories, changes, "2026-10-30T00:00:00Z", () => "new-id");
  assert.deepEqual(next.map((memory) => [memory.id, memory.text, memory.source]), [["new-id", "New note about them.", "freya"], ["m1", "Updated", undefined]]);
  assert.match(describeChanges(changes), /1 new, 1 updated, 1 removed/);
  assert.equal(describeChanges({ add: [], update: [], remove: [] }), "");
});

test("the reflection route proposes validated changes and refuses Local-only deployments", async () => {
  env();
  let sent = "";
  globalThis.fetch = async (url, init) => { sent = String(init?.body ?? ""); return groqJson({ add: [{ text: "Has a cat called Miso.", kind: "person" }], update: [], remove: [] }); };
  let response = await post(reflectPost, "/api/memory/reflect", { turns: [{ role: "user", content: "my cat miso knocked over my tea" }, { role: "assistant", content: "rude cat" }], memories: [], today: "2026-10-30" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.add, [{ text: "Has a cat called Miso.", kind: "person" }]);
  assert.match(sent, /response_format/);

  setEnv("FREYA_LOCAL_ONLY", "true");
  globalThis.fetch = async () => { throw new Error("no network in Local-only"); };
  response = await post(reflectPost, "/api/memory/reflect", { turns: [{ role: "user", content: "hello there friend" }] });
  assert.equal(response.status, 403);
});

test("the chat route uses browser-kept memories and ignores client model overrides", async () => {
  env();
  let body = null;
  let url = "";
  globalThis.fetch = async (target, init) => { url = String(target); body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); };
  const response = await post(chatPost, "/api/chat", {
    messages: [{ role: "user", content: "how should I practise parking?" }],
    localMemories: [{ id: "m1", text: "Has a driving test soon and is nervous about parking." }],
    ollamaModel: "some-other-model",
  });
  assert.equal(response.status, 200);
  assert.match(url, /api\.groq\.com/, "a request can no longer move chat to a local model");
  assert.match(body.messages[0].content, /nervous about parking/);
});

// --- commands -----------------------------------------------------------------------------

test("composer commands and plain picture requests are recognised conservatively", () => {
  assert.deepEqual(parseCommand("/visualize a red fox"), { name: "visualize", argument: "a red fox" });
  assert.deepEqual(parseCommand("/viz"), { name: "visualize", argument: "" });
  assert.deepEqual(parseCommand("/img a cat"), { name: "image", argument: "a cat" });
  assert.equal(parseCommand("/shrug"), null);
  assert.equal(parseCommand("hello /visualize"), null);
  assert.deepEqual(commandHints("/vi").map((command) => command.name), ["visualize"]);
  assert.equal(pictureRequest("draw me a fox in the snow"), "a fox in the snow");
  assert.equal(pictureRequest("can you make a picture of a castle?"), "a castle");
  assert.equal(pictureRequest("draw conclusions from this data"), null);
  assert.equal(pictureRequest("I made a picture of my dog yesterday"), null);
});

// --- visualize ----------------------------------------------------------------------------

test("visualisation specs are bounded and sample into centred, coloured clouds", () => {
  assert.equal(validateSpec({ parts: [] }), null);
  const spec = validateSpec({ title: "Mug", parts: [
    { shape: "cylinder", position: [0, 0, 0], size: [0.8, 1, 0.8], rotation: [0, 0, 0], color: "#ffffff" },
    { shape: "torus", position: [0.5, 0, 0], size: [0.5, 0.1, 0.5], rotation: [90, 0, 0], color: "not-a-colour", radius: 0.06 },
    { shape: "tube", path: [[0, 0, 0]], radius: 0.1 },
    { shape: "pyramid" },
    { shape: "box", position: [99, 0, 0], size: [-1, 1, 1] },
  ] });
  assert.equal(spec.parts.length, 3, "a one-point tube and unknown shapes are dropped");
  assert.equal(spec.parts[1].color, "#d9d1c2");
  assert.equal(spec.parts[2].position[0], 1.5);
  assert.equal(spec.parts[2].size[0], 0.01);
  assert.equal(validateSpec({ technique: "portrait" }).technique, "portrait");

  const cloud = samplePartsCloud(spec, 3000, 1.5);
  let max = 0;
  for (const value of cloud.positions) { assert.ok(Number.isFinite(value)); max = Math.max(max, Math.abs(value)); }
  assert.ok(max <= 1.5 + 1e-6 && max > 1.4, `fits the extent (${max})`);
  assert.equal(samplePartsCloud(spec, 3000).positions[123], cloud.positions[123], "deterministic");
});

test("relief clouds skip a dark background", () => {
  const width = 20;
  const height = 20;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 5; y < 15; y += 1) for (let x = 5; x < 15; x += 1) pixels.set([230, 200, 180, 255], (y * width + x) * 4);
  const cloud = sampleReliefCloud(pixels, width, height, 200);
  assert.ok(cloud.colors.slice(0, 3).every((value) => value > 0.6), "points come from the bright area");
});

test("/visualize starts from nothing; only a refinement sees and changes a form", async () => {
  env();
  let sent = "";
  globalThis.fetch = async (url, init) => { sent = String(init?.body); return groqJson({ title: "Fox", technique: "parts", parts: [{ shape: "ellipsoid", position: [0, 0, 0], size: [1, 0.6, 0.5], rotation: [0, 0, 0], color: "#c8501e" }] }); };
  const current = { title: "Fox", technique: "parts", parts: [{ shape: "box", position: [0, 0, 0], size: [1, 1, 1], rotation: [0, 0, 0], color: "#ffffff" }] };
  // A client that sends the current form with /visualize still gets a fresh start.
  let response = await post(visualizePost, "/api/visualize", { description: "a fox", current });
  assert.equal(response.status, 200);
  assert.doesNotMatch(sent, /CURRENT FORM \(/, "a new canvas never sees the old one");
  response = await post(visualizePost, "/api/visualize", { description: "make the tail fluffier", mode: "refine", current });
  assert.equal(response.status, 200);
  assert.match(sent, /CURRENT FORM \(Fox\)/);
  assert.match(sent, /keep every part the request/);
  assert.equal((await post(visualizePost, "/api/visualize", { description: "" })).status, 400);
  assert.equal((await post(visualizePost, "/api/visualize", { description: "bigger", mode: "refine" })).status, 400, "nothing to refine");
  assert.equal((await post(visualizePost, "/api/visualize", { description: "bigger", mode: "refine", current: { technique: "portrait", title: "Face", parts: [] } })).status, 422, "a portrait has no parts to change");
});

// --- pictures -----------------------------------------------------------------------------

const SVG = '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#123"/><circle cx="256" cy="256" r="80" fill="#fd0"/></svg>';

test("SVG drawings must be plain: no scripts, embeds, handlers or remote links", () => {
  assert.equal(sanitizeSvg(SVG), SVG);
  assert.equal(sanitizeSvg(`<?xml version="1.0"?>\n${SVG}`), SVG);
  for (const bad of ["<script>alert(1)</script>", '<image href="https://x.test/a.png"/>', '<rect onclick="x()"/>', '<a href="javascript:x()">x</a>', '<use href="https://x.test/s.svg#a"/>']) {
    assert.equal(sanitizeSvg(SVG.replace("</svg>", `${bad}</svg>`)), null, bad);
  }
});

test("pictures: a generated image when the image model works, a labelled SVG when it has no quota", async () => {
  env();
  globalThis.fetch = async (url) => String(url).includes("image")
    ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] } }] }), { status: 200 })
    : groqJson({ svg: SVG });
  let payload = await (await post(imagePost, "/api/image", { prompt: "a lighthouse" })).json();
  assert.equal(payload.kind, "generated");
  assert.equal(payload.mime, "image/png");

  globalThis.fetch = async (url) => String(url).includes("generativelanguage") ? new Response("{}", { status: 429 }) : groqJson({ svg: SVG });
  payload = await (await post(imagePost, "/api/image", { prompt: "a lighthouse" })).json();
  assert.deepEqual([payload.kind, payload.reason], ["svg", "quota"], "the fallback says why");

  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return groqJson({ svg: SVG }); };
  const blocked = await post(imagePost, "/api/image", { prompt: "nude schoolgirl" });
  assert.equal(blocked.status, 400);
  assert.equal(calls, 0, "never sent to a provider");
});

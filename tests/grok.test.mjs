import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { convenePanel } from "../lib/council.ts";
import { buildBrief } from "../lib/brief.ts";
import { generateJson } from "../lib/structured.ts";
import { resetProviderHealthForTests } from "../lib/provider-health.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetProviderHealthForTests();
});

function env(xaiKey = "test-only") {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", XAI_API_KEY: xaiKey, XAI_MODEL: undefined, XAI_REASONING_EFFORT: undefined, GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test", AI_PROVIDER: "hybrid", AI_FALLBACK_PROVIDER: undefined, GROQ_MODEL: "voice-model", GROQ_FALLBACK_MODELS: "", FREYA_REASONING_MODEL: undefined, FREYA_STRUCTURED_FALLBACK_MODEL: "second-model" })) setEnv(k, v);
}

/** Answers as each service would, and records who was called. */
function mock({ grokFails = false, text = '{"answer":"391"}' } = {}) {
  const calls = { grok: [], groq: [], gemini: [], headers: [] };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (target.includes("api.x.ai")) {
      calls.grok.push(body);
      calls.headers.push(init.headers);
      return grokFails ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
    }
    if (target.includes("generativelanguage")) {
      calls.gemini.push(body);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }
    calls.groq.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
  };
  return calls;
}

const question = [{ role: "user", content: "what's 17 * 23?" }];
const hardAsk = [{ role: "user", content: "explain how a binary search tree stays balanced and why it matters for lookups" }];

test("Grok solves for the reasoning panel, without the persona, when there's a key", async () => {
  env();
  const calls = mock();
  const panel = await convenePanel(question);
  assert.deepEqual(panel.analyses.map((analysis) => analysis.analyst), ["grok", "gemini"]);
  assert.equal(calls.groq.length, 0);
  assert.equal(calls.grok[0].model, "grok-4.7");
  assert.equal(calls.grok[0].reasoning_effort, "low");
  assert.equal(calls.headers[0].Authorization, "Bearer test-only");
  assert.doesNotMatch(calls.grok[0].messages[0].content, /FREYA/);
  for (const unsupported of ["stop", "frequency_penalty", "presence_penalty", "max_tokens"]) assert.equal(unsupported in calls.grok[0], false, unsupported);
});

test("Groq stands in when Grok fails, and is used alone with no key", async () => {
  env();
  const failed = mock({ grokFails: true });
  const panel = await convenePanel(question);
  assert.deepEqual(panel.analyses.map((analysis) => analysis.analyst), ["groq", "gemini"]);
  assert.equal(failed.grok.length, 1);

  resetProviderHealthForTests();
  env("");
  const keyless = mock();
  const alone = await convenePanel(question);
  assert.deepEqual(alone.analyses.map((analysis) => analysis.analyst), ["groq", "gemini"]);
  assert.equal(keyless.grok.length, 0);
});

test("a failed Grok rests for a while instead of being tried on every job", async () => {
  env();
  const calls = mock({ grokFails: true });
  await convenePanel(question);
  await convenePanel(question);
  assert.equal(calls.grok.length, 1);
  assert.equal(calls.groq.length, 2);
});

test("structured jobs try Grok in JSON mode first, then Groq, then Gemini", async () => {
  env();
  const calls = mock();
  const first = await generateJson("system", "user", { groqModel: "first-model", maxTokens: 500 });
  assert.equal(first.provider, "grok");
  assert.deepEqual(first.data, { answer: "391" });
  assert.deepEqual(calls.grok[0].response_format, { type: "json_object" });
  assert.equal(calls.grok[0].max_completion_tokens, 500);
  assert.equal(calls.groq.length, 0);

  resetProviderHealthForTests();
  const failing = mock({ grokFails: true });
  const second = await generateJson("system", "user", { groqModel: "first-model", maxTokens: 500 });
  assert.equal(second.provider, "groq");
  assert.equal(failing.grok.length, 1);
  assert.equal(failing.groq[0].model, "first-model");
});

test("Grok writes logic briefs; live briefs stay with Gemini, and Groq stands in", async () => {
  env();
  const calls = mock({ text: "FACTS: rotations keep the height logarithmic." });
  const brief = await buildBrief(hardAsk);
  assert.equal(brief.provider, "grok");
  assert.match(brief.text, /rotations/);
  assert.equal(calls.groq.length, 0);

  const live = mock({ text: "FACTS: from the search results." });
  const fromGemini = await buildBrief(hardAsk, undefined, "gemini");
  assert.equal(fromGemini.provider, "gemini");
  assert.equal(live.grok.length, 0);

  resetProviderHealthForTests();
  const failing = mock({ grokFails: true, text: "FACTS: from groq." });
  const standIn = await buildBrief(hardAsk);
  assert.equal(standIn.provider, "groq");
  assert.equal(failing.grok.length, 1);
});

test("a Grok key alone is enough for briefs", async () => {
  env();
  setEnv("GROQ_API_KEY", undefined);
  setEnv("GEMINI_API_KEY", undefined);
  mock({ text: "FACTS: rotations." });
  assert.equal((await buildBrief(hardAsk)).provider, "grok");
});

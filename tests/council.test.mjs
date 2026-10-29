import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { needsReasoning, wantsEvidence } from "../lib/reasoning-signal.ts";
import { convenePanel, panelContext } from "../lib/council.ts";
import { POST } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";
import { resetProviderHealthForTests } from "../lib/provider-health.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetLocalRateLimitsForTests();
  // A test that fails an analyst on purpose puts it in cooldown; the next test starts fresh.
  resetProviderHealthForTests();
});

function env() {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test", AI_PROVIDER: "groq", GROQ_MODEL: "voice-model", GROQ_FALLBACK_MODELS: "", WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false", OLLAMA_BASE_URL: "http://127.0.0.1:11434" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "FREYA_SERVICE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_REASONING_MODEL", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
}

/** Records every upstream call and answers as the right party would. */
function mockUpstreams({ groqAnalystFails = false, geminiFails = false } = {}) {
  const calls = { groqAnalyst: [], gemini: [], voice: [], ollama: [] };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (target.includes("generativelanguage")) {
      calls.gemini.push(body);
      return geminiFails ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ANSWER: 391\nCHECK: 17*23 = 17*20 + 17*3 = 340 + 51\nCONFIDENCE: high" }] } }] }));
    }
    if (target.includes("11434")) { calls.ollama.push(body); return new Response(JSON.stringify({ message: { content: "local reply" } })); }
    if (body.max_completion_tokens) {
      calls.groqAnalyst.push(body);
      return groqAnalystFails ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ANSWER: 391\nREASONING: 1. 17*23 = 391\nCONFIDENCE: high" } }] }));
    }
    calls.voice.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "it's 391." } }] }));
  };
  return calls;
}

function chat(body) {
  return POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.66" }, body: JSON.stringify(body) }));
}

test("reasoning is detected for maths, code, logic and real decisions, not for chat", () => {
  for (const hard of ["what's 17 * 23?", "why does my regex fail on emails", "solve x^2 - 5x + 6 = 0", "walk me through how compound interest works", "should I take the job with more pay or the better team? compare the trade-offs"]) {
    assert.equal(needsReasoning(hard), true, hard);
  }
  for (const casual of ["hey", "lol ok", "how was your day?", "I love this song", "good morning"]) {
    assert.equal(needsReasoning(casual), false, casual);
  }
  assert.equal(needsReasoning("how was your day?", "always"), true);
  assert.equal(needsReasoning("what's 17 * 23?", "off"), false);
  assert.equal(wantsEvidence("compare the iPhone and Pixel cameras"), true);
});

test("two analysts work the problem in parallel; the writer gets both, without persona", async () => {
  env();
  const calls = mockUpstreams();
  const panel = await convenePanel([{ role: "user", content: "what's 17 * 23?" }]);
  assert.equal(panel.analyses.length, 2);
  assert.equal(calls.groqAnalyst[0].model, "openai/gpt-oss-120b");
  assert.ok(calls.groqAnalyst[0].reasoning_effort);
  assert.doesNotMatch(calls.groqAnalyst[0].messages[0].content, /FREYA/, "analysts never see the persona");
  const context = panelContext(panel);
  assert.match(context, /Two analysts solved this independently/);
  assert.match(context, /ANALYST A/);
  assert.match(context, /ANALYST B/);
  assert.match(context, /never mention analysts/);
});

test("a failed analyst leaves the other; none leaves FREYA answering alone", async () => {
  env();
  mockUpstreams({ geminiFails: true });
  const one = await convenePanel([{ role: "user", content: "what's 17 * 23?" }]);
  assert.equal(one.analyses.length, 1);
  assert.match(panelContext(one), /One analyst worked this through/);
  resetProviderHealthForTests();
  env();
  mockUpstreams({ groqAnalystFails: true, geminiFails: true });
  assert.equal(await convenePanel([{ role: "user", content: "solve 2x + 3 = 11" }]), null);
});

test("the route convenes the panel for a hard question and hands the notes to FREYA's voice", async () => {
  env();
  const calls = mockUpstreams();
  const response = await chat({ messages: [{ role: "user", content: "quick, what is 17 * 23 and how do you check it?" }] });
  assert.equal(response.status, 200);
  assert.equal(calls.groqAnalyst.length, 1);
  assert.equal(calls.voice.length, 1);
  const system = calls.voice[0].messages[0].content;
  assert.match(system, /REASONING NOTES/);
  assert.match(system, /ANSWER: 391/);
});

test("casual chat, Local-only mode and intimate turns never convene the panel", async () => {
  env();
  let calls = mockUpstreams();
  await chat({ messages: [{ role: "user", content: "hey, how was your day?" }] });
  assert.equal(calls.groqAnalyst.length + calls.gemini.length, 0);

  calls = mockUpstreams();
  await chat({ privacyMode: true, messages: [{ role: "user", content: "what is 17 * 23?" }] });
  assert.equal(calls.groqAnalyst.length + calls.gemini.length, 0, "Local-only never leaves the machine");

  calls = mockUpstreams();
  await chat({ intimateMode: true, messages: [{ role: "user", content: "kiss me and then explain why 17 * 23 is 391 😏" }] });
  assert.equal(calls.groqAnalyst.length + calls.gemini.length, 0, "intimate turns stay local");

  calls = mockUpstreams();
  await chat({ reasoning: "off", messages: [{ role: "user", content: "what is 17 * 23?" }] });
  assert.equal(calls.groqAnalyst.length + calls.gemini.length, 0, "the setting can turn it off");
});

test("questions that don't need live facts are answered, not refused, when search is off or failing", async () => {
  env();
  let calls = mockUpstreams();
  // Search switched off: maths used to be refused with "web search is disabled".
  let response = await chat({ reasoning: "off", messages: [{ role: "user", content: "what is 17 * 23?" }] });
  let payload = await response.json();
  assert.equal(calls.voice.length, 1, "the model answers");
  assert.doesNotMatch(payload.reply, /web search is disabled/);

  // Search on but failing: a general-knowledge question is still answered, from knowledge.
  setEnv("WEB_SEARCH_ENABLED", "true");
  setEnv("TAVILY_API_KEY", "test-only");
  calls = mockUpstreams();
  const answering = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).includes("tavily") || (String(url).includes("generativelanguage") && String(init?.body).includes("google_search"))
    ? new Response("{}", { status: 503 })
    : answering(url, init);
  response = await chat({ reasoning: "off", messages: [{ role: "user", content: "what is the capital of Australia?" }] });
  payload = await response.json();
  assert.equal(calls.voice.length, 1);
  assert.doesNotMatch(payload.reply, /couldn't retrieve reliable web results/);
});

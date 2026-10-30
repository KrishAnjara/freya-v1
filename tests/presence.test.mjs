import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chooseExpression, EXPRESSION_FILE, EXPRESSIONS, moodExpression, POSES, reactionInReply, reactionTo, requestedExpression } from "../lib/expression.ts";
import { MOOD_NAMES } from "../lib/mood.ts";
import { briefProviderFor } from "../lib/brief.ts";
import { bubbleDelay, MIN_BUBBLE_GAP_MS } from "../lib/reply-parts.ts";
import { POST as chatPost } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  resetLocalRateLimitsForTests();
});

test("every expression has a pose and every mood maps to an expression", () => {
  for (const expression of EXPRESSIONS) assert.ok(POSES[expression], expression);
  for (const mood of MOOD_NAMES) assert.ok(EXPRESSIONS.includes(moodExpression(mood)), mood);
});

test("expressions come from real signals: requests and reactions first, then thinking, then mood", () => {
  assert.equal(requestedExpression("smile for me"), "smile");
  assert.equal(requestedExpression("can you look surprised?"), "surprised");
  assert.equal(requestedExpression("make a sad face"), "sad");
  assert.equal(requestedExpression("I had a sad day"), null, "talking about sadness is not a request");
  assert.equal(reactionTo("my dog died this morning").expression, "sad");
  assert.equal(reactionTo("omg guess what").expression, "surprised");
  assert.equal(reactionTo("lmao 😂").expression, "laugh");
  assert.equal(reactionTo("just checking in"), null);
  assert.equal(reactionInReply("haha that's so dumb").expression, "laugh");
  const now = 1_000_000;
  const active = { expression: "surprised", ms: 3000, until: now + 1000 };
  assert.equal(chooseExpression("curious", true, active, now), "surprised");
  assert.equal(chooseExpression("curious", true, { ...active, until: now - 1 }, now), "thinking");
  assert.equal(chooseExpression("melancholy", false, null, now), "sad");
});

test("only expression image names the app knows are used", () => {
  assert.ok(EXPRESSION_FILE.test("smile.png"));
  assert.ok(EXPRESSION_FILE.test("thinking-2.webp"));
  assert.ok(!EXPRESSION_FILE.test("../smile.png"));
  assert.ok(!EXPRESSION_FILE.test("smirk.png"));
});

test("supporting services by task: Gemini for live facts, Groq for logic", () => {
  assert.equal(briefProviderFor("what's the latest news on the election", false), "gemini");
  assert.equal(briefProviderFor("why does quicksort degrade to n squared", false), "groq");
  assert.equal(briefProviderFor("anything", true), "gemini", "search results always go to Gemini");
});

test("consecutive bubbles are at least a second apart; the first isn't delayed extra", () => {
  assert.equal(bubbleDelay("hi", true), MIN_BUBBLE_GAP_MS);
  assert.ok(bubbleDelay("hi", false) < MIN_BUBBLE_GAP_MS);
  assert.ok(bubbleDelay("x".repeat(500), true) >= MIN_BUBBLE_GAP_MS);
});

test("hybrid: the local model is the voice, even for images (Gemini only describes them)", async () => {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "hybrid", GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test", WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false", FREYA_REASONING_MODE: "off", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "freya" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
  const calls = { gemini: [], ollama: [] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).includes("generativelanguage")) { calls.gemini.push(body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A ginger cat asleep on a stack of library books, warm lamp light." }] } }] }), { status: 200 }); }
    if (String(url).includes("11434")) { calls.ollama.push(body); return new Response(JSON.stringify({ message: { content: "omg the cat on the books" } }), { status: 200 }); }
    return new Response("{}", { status: 404 });
  };
  const response = await chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.5" }, body: JSON.stringify({
    messages: [{ role: "user", content: "look at him", attachments: [{ name: "cat.png", mime: "image/png", kind: "image", data: "iVBORw0KGgo=" }] }],
  }) }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.provider, "ollama", "FREYA's voice stays local");
  assert.equal(calls.gemini.length, 1, "Gemini looked at the image once");
  assert.ok(calls.gemini[0].contents.at(-1).parts.some((part) => part.inlineData), "with the image itself");
  assert.match(calls.ollama[0].messages[0].content, /ginger cat asleep/, "the description reaches the local voice");
});

test("long-form: depth requests and replies that grow long or structured become one document", async () => {
  const { becomesLongForm, wantsLongForm } = await import("../lib/reply-parts.ts");
  assert.equal(wantsLongForm("explain how vaccines work in detail"), true);
  assert.equal(wantsLongForm("give me a detailed explanation of TCP"), true);
  assert.equal(wantsLongForm("walk me through setting up git step by step"), true);
  assert.equal(wantsLongForm("explain this joke"), false);
  assert.equal(wantsLongForm("how was your day"), false);
  assert.equal(becomesLongForm("## How it works\nFirst, the thing.", 0), true);
  const steps = "1. boil water\n2. add the egg gently with a spoon so it doesn't crack\n3. wait seven minutes and then move it into iced water to stop it cooking further";
  assert.equal(becomesLongForm(steps, 0), false, "a short list stays a chat message");
  assert.equal(becomesLongForm(`${steps}\n4. peel it under running water, starting from the wide end where the air pocket is`, 0), true);
  assert.equal(becomesLongForm("haha yeah", 200), false);
  assert.equal(becomesLongForm("x".repeat(300), 1200), true, "a reply that simply runs long");
});

test("normal chat stays with the local voice: no cloud brief, no web search", async () => {
  const { needsBrief } = await import("../lib/brief.ts");
  const { shouldSearch } = await import("../lib/search.ts");
  for (const chat of ["lol i just burnt my toast", "haha same honestly", "what are you up to?", "how was your day", "my sister got into med school!!"]) {
    assert.equal(needsBrief(chat), false, `brief for "${chat}"`);
  }
  for (const real of ["how do I fix a segfault in C", "why is the sky blue", "can you explain recursion", "that's wrong"]) {
    assert.equal(needsBrief(real), true, `no brief for "${real}"`);
  }
  assert.equal(shouldSearch("what are you up to?"), false);
  assert.equal(shouldSearch("who are you?"), false);
  assert.equal(shouldSearch("what are the side effects of ibuprofen"), true);
});

test("a sincere human-or-AI question gets the truth from the app itself; banter stays banter", async () => {
  const { sincerelyAsksIfHuman } = await import("../lib/honesty.ts");
  for (const sincere of ["seriously, I need to know: am I talking to a real human or an AI?", "am i talking to a real person", "are you a real person or an ai?", "honestly, are you a bot?", "tell me the truth, are you human?"]) {
    assert.equal(sincerelyAsksIfHuman(sincere), true, sincere);
  }
  for (const banter of ["lol are you a bot", "are you a morning person?", "you're a real one", "are you an artist?", "haha am i talking to a robot"]) {
    assert.equal(sincerelyAsksIfHuman(banter), false, banter);
  }
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "hybrid", GROQ_API_KEY: "test-only", WEB_SEARCH_ENABLED: "false", FREYA_REASONING_MODE: "off" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  const response = await chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.6" }, body: JSON.stringify({ messages: [{ role: "user", content: "am i actually talking to a real person?" }] }) }));
  assert.match((await response.json()).reply, /i'm an AI/);
  assert.equal(calls, 0, "no model gets a chance to deny it");
});

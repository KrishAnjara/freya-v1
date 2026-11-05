import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { localVoiceAvailable, planVoiceChain } from "../lib/voice-chain.ts";
import { generateReply, streamReply } from "../lib/llm.ts";
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

const labels = (tiers) => tiers.map((tier) => tier.label);
const COLAB = { AI_PROVIDER: "hybrid", OLLAMA_BASE_URL: "https://abc.trycloudflare.com", OLLAMA_API_KEY: "token", OLLAMA_MODEL: "freya" };

test("on this machine alone the chain is unchanged: her model, then Groq", () => {
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "hybrid" })), ["ollama", "groq"]);
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "groq" })), ["groq", "gemini"]);
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "gemini" })), ["gemini", "groq"]);
});

test("the full chain: Colab, its fallback model, the laptop, then the cloud in the order given", () => {
  const env = { ...COLAB, FREYA_FALLBACK_MODEL: "freya-small", LOCAL_OLLAMA_URL: "http://127.0.0.1:11434", AI_FALLBACK_PROVIDER: "grok, gemini,groq" };
  const tiers = planVoiceChain({}, env, true);
  assert.deepEqual(labels(tiers), ["ollama", "server-fallback", "laptop", "grok", "gemini", "groq"]);
  assert.equal(tiers[0].baseUrl, "https://abc.trycloudflare.com");
  assert.equal(tiers[1].model, "freya-small");
  assert.equal(tiers[1].key, "token", "the fallback model is on the same server, with the same login");
  assert.equal(tiers[2].baseUrl, "http://127.0.0.1:11434");
  assert.equal(tiers[2].key, undefined, "the laptop gets no server token");
  assert.notEqual(tiers[0].health, tiers[1].health, "a failing big model doesn't sideline the small one");
});

test("Grok needs a key: without one it's skipped, and a Grok-only setting still has a fallback", () => {
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "hybrid", AI_FALLBACK_PROVIDER: "grok,gemini" }, false)), ["ollama", "gemini"]);
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "hybrid", AI_FALLBACK_PROVIDER: "grok" }, false)), ["ollama", "groq"]);
});

test("private turns never reach a cloud tier, but can use every model of her own", () => {
  const env = { ...COLAB, FREYA_FALLBACK_MODEL: "freya-small", LOCAL_OLLAMA_URL: "http://127.0.0.1:11434", AI_FALLBACK_PROVIDER: "grok,gemini" };
  const tiers = planVoiceChain({ provider: "ollama", cloud: false }, env, true);
  assert.deepEqual(labels(tiers), ["ollama", "server-fallback", "laptop"]);
  assert.ok(tiers.every((tier) => tier.own));
});

test("Local-only uses only this machine: the laptop stands in for a remote voice", () => {
  const withLaptop = { ...COLAB, LOCAL_OLLAMA_URL: "http://127.0.0.1:11434" };
  assert.deepEqual(labels(planVoiceChain({ provider: "ollama", privacy: true }, withLaptop)), ["laptop"]);
  assert.equal(localVoiceAvailable(withLaptop), true);
  assert.equal(localVoiceAvailable(COLAB), false, "a remote voice with no laptop model can't do Local-only");
  assert.equal(localVoiceAvailable({ AI_PROVIDER: "hybrid" }), true);
});

test("\"ollama\" in the fallback list puts this laptop's model before every cloud one", () => {
  // The user's own setting: AI_FALLBACK_PROVIDER=ollama,groq,gemini with the voice on Colab.
  const tiers = planVoiceChain({}, { ...COLAB, AI_FALLBACK_PROVIDER: "ollama,groq,gemini" });
  assert.deepEqual(labels(tiers), ["ollama", "laptop", "groq", "gemini"]);
  assert.equal(tiers[1].baseUrl, "http://127.0.0.1:11434");
  assert.equal(tiers[1].model, "freya");
  // With her voice already on this machine, it's simply first.
  assert.deepEqual(labels(planVoiceChain({}, { AI_PROVIDER: "hybrid", AI_FALLBACK_PROVIDER: "ollama,groq,gemini" })), ["ollama", "groq", "gemini"]);
  // And Local-only can use it.
  assert.deepEqual(labels(planVoiceChain({ provider: "ollama", privacy: true }, { ...COLAB, AI_FALLBACK_PROVIDER: "ollama,groq" })), ["laptop"]);
});

test("a laptop address that isn't this machine is ignored", () => {
  assert.deepEqual(labels(planVoiceChain({}, { ...COLAB, LOCAL_OLLAMA_URL: "https://elsewhere.example.com" })), ["ollama", "groq"]);
});

test("fallback switched off means the first tier only", () => {
  assert.deepEqual(labels(planVoiceChain({ fallbackEnabled: false }, { ...COLAB, FREYA_FALLBACK_MODEL: "small" })), ["ollama"]);
  assert.deepEqual(labels(planVoiceChain({}, { ...COLAB, AI_FALLBACK_ENABLED: "false" })), ["ollama"]);
});

function chainEnv() {
  for (const [k, v] of Object.entries({ ...COLAB, NODE_ENV: "test", FREYA_FALLBACK_MODEL: "freya-small", LOCAL_OLLAMA_URL: "http://127.0.0.1:11434", LOCAL_OLLAMA_MODEL: "freya", AI_FALLBACK_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "groq-test", GROQ_FALLBACK_MODELS: "", XAI_API_KEY: undefined })) setEnv(k, v);
}

const ollamaLine = (text, done = false) => `${JSON.stringify({ message: { content: text }, done })}\n`;

test("walks the chain until someone answers, and remembers who was down", async () => {
  chainEnv();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    seen.push(`${new URL(String(url)).host}:${body.model}`);
    if (String(url).includes("trycloudflare") && body.model === "freya") return new Response("tunnel gone", { status: 530 });
    if (String(url).includes("trycloudflare")) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(ollamaLine("hey from the laptop") + ollamaLine("", true), { status: 200 });
  };
  const outcome = { truncated: false, parts: 1 };
  let text = "";
  for await (const delta of streamReply("system", [{ role: "user", content: "hi" }], undefined, outcome)) text += delta;
  assert.equal(text, "hey from the laptop");
  assert.equal(outcome.provider, "laptop");
  assert.deepEqual(seen, ["abc.trycloudflare.com:freya", "abc.trycloudflare.com:freya-small", "127.0.0.1:11434:freya"]);

  seen.length = 0;
  for await (const delta of streamReply("system", [{ role: "user", content: "again" }], undefined, outcome)) void delta;
  assert.deepEqual(seen, ["127.0.0.1:11434:freya"], "the server's models are skipped while they cool down");
});

test("once she has started talking, a failure ends the reply instead of switching voices", async () => {
  chainEnv();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // The first read delivers text; the next one fails, as a dropped tunnel does.
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(new TextEncoder().encode(ollamaLine("half a thou")));
        else controller.error(new TypeError("tunnel dropped"));
      },
    });
    return new Response(stream, { status: 200 });
  };
  let text = "";
  await assert.rejects(async () => { for await (const delta of streamReply("system", [{ role: "user", content: "hi" }])) text += delta; });
  assert.equal(text, "half a thou");
  assert.equal(calls.length, 1, "no second voice spliced in");
});

test("the own models get the private prompt, a cloud tier only the version written for it", async () => {
  chainEnv();
  setEnv("FREYA_FALLBACK_MODEL", undefined);
  setEnv("LOCAL_OLLAMA_URL", undefined);
  const systems = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    systems.push({ url: String(url), system: body.messages[0].content });
    if (String(url).includes("trycloudflare")) return new Response("gone", { status: 530 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "cloud reply" } }] }), { status: 200 });
  };
  const reply = await generateReply("PRIVATE", [{ role: "user", content: "hi" }], undefined, { fallbackSystem: "SHAREABLE" });
  assert.equal(reply, "cloud reply");
  assert.equal(systems[0].system, "PRIVATE");
  assert.equal(systems[1].system, "SHAREABLE");
});

test("with externalFiles off, a cloud tier gets the note, never the file", async () => {
  chainEnv();
  setEnv("FREYA_FALLBACK_MODEL", undefined);
  setEnv("LOCAL_OLLAMA_URL", undefined);
  let cloudBody = null;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("trycloudflare")) return new Response("gone", { status: 530 });
    cloudBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "can't see it" } }] }), { status: 200 });
  };
  await generateReply("s", [{ role: "user", content: "what's this", inline: [{ mime: "image/jpeg", data: "/9j/4AAQ" }] }], undefined, { cloudSeesFiles: false });
  assert.doesNotMatch(JSON.stringify(cloudBody), /9j\/4AAQ/);
  assert.match(cloudBody.messages.at(-1).content, /could not be passed to you/);
});

test("her server up but failing (busy, out of memory) is reported, never handed to the laptop or the cloud", async () => {
  chainEnv();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    seen.push(`${new URL(String(url)).host}:${body.model}`);
    if (String(url).includes("trycloudflare")) return new Response(JSON.stringify({ error: "model requires more system memory" }), { status: 500 });
    return new Response(ollamaLine("the laptop") + ollamaLine("", true), { status: 200 });
  };
  await assert.rejects(async () => { for await (const delta of streamReply("system", [{ role: "user", content: "hi" }])) void delta; }, /500|memory/);
  assert.deepEqual(seen, ["abc.trycloudflare.com:freya", "abc.trycloudflare.com:freya-small"], "its own fallback model tried, nothing past the server");
});

test("every provider has its own switch in freya.config.json", () => {
  const env = { ...COLAB, FREYA_FALLBACK_MODEL: "freya-small", LOCAL_OLLAMA_URL: "http://127.0.0.1:11434", AI_FALLBACK_PROVIDER: "grok,gemini,groq" };
  assert.deepEqual(labels(planVoiceChain({ off: ["serverFallback", "grok"] }, env, true)), ["ollama", "laptop", "gemini", "groq"]);
  assert.deepEqual(labels(planVoiceChain({ off: ["server", "laptop"] }, env, true)), ["server-fallback", "grok", "gemini", "groq"]);
  assert.throws(() => planVoiceChain({ off: ["server", "serverFallback", "laptop", "grok", "gemini", "groq"] }, env, true), /switched off/);
});

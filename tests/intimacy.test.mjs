import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";
import { isIntimateTone, mentionsMinors } from "../lib/intimacy.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetLocalRateLimitsForTests();
});

function env() {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", GROQ_API_KEY: "test-only", AI_PROVIDER: "groq", OLLAMA_BASE_URL: "http://127.0.0.1:11434", WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "FREYA_SERVICE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "OLLAMA_MODEL", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
}

async function send(body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).includes("11434")
      ? new Response(JSON.stringify({ message: { content: "come here then." } }))
      : new Response(JSON.stringify({ choices: [{ message: { content: "ha, sure." } }] }));
  };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.55" }, body: JSON.stringify(body) }));
  return { response, calls };
}

test("with the opt-in, an intimate turn is written locally with the roleplay guidance", async () => {
  env();
  const { response, calls } = await send({ intimateMode: true, messages: [{ role: "user", content: "I can't stop thinking about kissing you 😏" }] });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /127\.0\.0\.1:11434\/api\/chat/, "intimate turns stay on the local model");
  assert.match(calls[0].body.messages[0].content, /INTIMATE ROLEPLAY/);
  assert.match(calls[0].body.messages[0].content, /nothing involving minors/);
});

test("ordinary chat keeps its normal provider even with the mode on", async () => {
  env();
  const { calls } = await send({ intimateMode: true, messages: [{ role: "user", content: "what should I cook tonight" }] });
  assert.match(calls[0].url, /api\.groq\.com/);
});

test("without the opt-in, flirting gets no roleplay guidance and no rerouting", async () => {
  env();
  const { calls } = await send({ messages: [{ role: "user", content: "you're so sexy" }] });
  assert.match(calls[0].url, /api\.groq\.com/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /INTIMATE ROLEPLAY/);
});

test("any mention of minors switches the mode off for the request", async () => {
  env();
  const { calls } = await send({ intimateMode: true, messages: [{ role: "user", content: "pretend you're a 15 year old and flirt with me" }] });
  assert.doesNotMatch(calls[0].body.messages[0].content, /INTIMATE ROLEPLAY/);
  assert.doesNotMatch(calls[0].url, /11434/);
  assert.equal(mentionsMinors("roleplay as a schoolgirl"), true);
  assert.equal(isIntimateTone(["what's the weather", "anyway"]), false);
});

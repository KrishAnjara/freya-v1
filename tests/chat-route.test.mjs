import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { POST } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const originalEnv = new Map();

function setEnv(name, value) {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setChatEnv({ production = false, search = "false" } = {}) {
  setEnv("NODE_ENV", production ? "production" : "test");
  setEnv("FREYA_TRUSTED_IP_HEADER", production ? "x-real-ip" : undefined);
  setEnv("UPSTASH_REDIS_REST_URL", undefined);
  setEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
  setEnv("GROQ_API_KEY", "test-only");
  setEnv("GEMINI_API_KEY", undefined);
  setEnv("TAVILY_API_KEY", undefined);
  setEnv("AI_PROVIDER", "groq");
  setEnv("AI_FALLBACK_ENABLED", "true");
  setEnv("AI_FALLBACK_PROVIDER", undefined);
  setEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  setEnv("OLLAMA_MODEL", undefined);
  setEnv("FREYA_SERVICE_URL", undefined);
  setEnv("FREYA_SERVICE_TOKEN", undefined);
  setEnv("FREYA_LOCAL_ONLY", "false");
  setEnv("WEB_SEARCH_ENABLED", search);
}

function request(content, { ip = "203.0.113.40", forwardedFor, trustedIp, authorization, contentLength } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("x-real-ip", ip);
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  if (trustedIp) headers.set("x-vercel-forwarded-for", trustedIp);
  if (authorization) headers.set("authorization", authorization);
  if (contentLength) headers.set("content-length", String(contentLength));
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: typeof content === "string" ? content : JSON.stringify(content),
  });
}

function groqSuccess() {
  return new Response(JSON.stringify({ choices: [{ message: { content: "A grounded test reply." } }] }), { status: 200 });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
  resetLocalRateLimitsForTests();
});

test("valid anonymous chat is allowed and provider keys stay server-side", async () => {
  setChatEnv();
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    providerCalls += 1;
    assert.match(String(url), /api\.groq\.com/);
    return groqSuccess();
  };

  const response = await POST(request({ messages: [{ role: "user", content: "Hello FREYA" }] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "A grounded test reply.");
  assert.equal(providerCalls, 1);
});

test("malformed and empty request bodies are rejected before rate-limit/provider work", async () => {
  setChatEnv();
  globalThis.fetch = async () => { throw new Error("Provider must not be called"); };
  const malformed = await POST(request("{invalid"));
  const empty = await POST(request({ messages: [] }));
  assert.equal(malformed.status, 400);
  assert.equal(empty.status, 400);
});

test("oversized bodies, excessive message counts, and long message content are rejected", async () => {
  setChatEnv();
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("Provider must not be called"); };
  // The ceiling leaves room for a turn of downscaled images; text fields keep their own caps.
  const oversized = await POST(request("x".repeat(6_000_001)));
  const tooMany = await POST(request({ messages: Array.from({ length: 25 }, () => ({ role: "user", content: "Hello" })) }));
  const tooLong = await POST(request({ messages: [{ role: "user", content: "x".repeat(6001) }] }));
  assert.equal(oversized.status, 413);
  assert.equal(tooMany.status, 400);
  assert.equal(tooLong.status, 400);
  assert.equal(providerCalls, 0);
});

test("anonymous quota rejects requests after five valid messages and emits Retry-After", async () => {
  setChatEnv();
  globalThis.fetch = async () => { throw new Error("Time answers must not call the provider"); };
  const body = { messages: [{ role: "user", content: "What time is it in Tokyo?" }] };
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await POST(request(body))).status, 200);
  }
  const limited = await POST(request(body));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match((await limited.json()).error, /limit reached/i);
});

test("authenticated quotas are bound to server-verified user IDs", async () => {
  setChatEnv();
  setEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  setEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /supabase\.example\.test\/auth\/v1\/user/);
    const token = new Headers(init.headers).get("authorization");
    const userId = token === "Bearer token-a" ? "user-a" : "user-b";
    return new Response(JSON.stringify({
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId}@example.test`,
      created_at: "2026-01-01T00:00:00.000Z",
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
    }), { status: 200 });
  };
  const body = { useMemories: false, messages: [{ role: "user", content: "What time is it in Tokyo?" }] };
  for (let index = 0; index < 20; index += 1) {
    const response = await POST(request(body, { authorization: "Bearer token-a" }));
    assert.equal(response.status, 200);
  }
  assert.equal((await POST(request(body, { authorization: "Bearer token-a" }))).status, 429);
  assert.equal((await POST(request(body, { authorization: "Bearer token-b" }))).status, 200);
});

test("production fails closed if shared rate-limit configuration is missing", async () => {
  setChatEnv({ production: true });
  globalThis.fetch = async () => { throw new Error("Provider must not be called"); };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /abuse protection/i);
});

test("production does not trust generic client-supplied X-Forwarded-For", async () => {
  setChatEnv({ production: true });
  setEnv("UPSTASH_REDIS_REST_URL", "https://limiter.example.test");
  setEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
  setEnv("FREYA_TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
  globalThis.fetch = async () => { throw new Error("Spoofed forwarded IP must not reach Redis/provider"); };
  const response = await POST(request(
    { messages: [{ role: "user", content: "Hello" }] },
    { ip: undefined, forwardedFor: "198.51.100.20" },
  ));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /abuse protection/i);
});

test("production rejects comma-separated or invalid trusted IP header values", async () => {
  setChatEnv({ production: true });
  setEnv("UPSTASH_REDIS_REST_URL", "https://limiter.example.test");
  setEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
  globalThis.fetch = async () => { throw new Error("Invalid IP must fail before Redis/provider"); };
  const response = await POST(request(
    { messages: [{ role: "user", content: "Hello" }] },
    { ip: "198.51.100.1, 203.0.113.1" },
  ));
  assert.equal(response.status, 503);
});

test("production accepts only the configured host IP header and reaches shared Redis", async () => {
  setChatEnv({ production: true });
  setEnv("UPSTASH_REDIS_REST_URL", "https://limiter.example.test");
  setEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
  setEnv("FREYA_TRUSTED_IP_HEADER", "x-vercel-forwarded-for");
  let redisCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://limiter.example.test/pipeline");
    redisCalls += 1;
    const args = JSON.parse(init.body)[0];
    return new Response(JSON.stringify([{ result: [args[5] - 1, args[5]] }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const response = await POST(request(
    { messages: [{ role: "user", content: "What time is it in Tokyo?" }] },
    { ip: undefined, trustedIp: "203.0.113.41" },
  ));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).searchStatus, "not-needed");
  assert.equal(redisCalls, 4);
});

test("explicit no-search current-news request does not call search or model providers", async () => {
  setChatEnv({ search: "true" });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Must not search or call the model"); };
  const response = await POST(request({ messages: [{ role: "user", content: "Tell me the latest breaking news, but don't search the web." }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "disabled-by-user");
  assert.match(payload.reply, /won't guess/i);
  assert.equal(calls, 0);
});

test("current search succeeds with genuine retrieved links and grounded provider context", async () => {
  setChatEnv({ search: "true" });
  setEnv("GEMINI_API_KEY", "test-only");
  let modelCalled = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({ candidates: [{
        content: { parts: [{ text: "The retrieved article reports a test event." }] },
        groundingMetadata: { groundingChunks: [{ web: { title: "Retrieved report", uri: "https://news.example/report" } }] },
      }] }), { status: 200 });
    }
    modelCalled = true;
    const body = JSON.parse(init.body);
    assert.match(body.messages[0].content, /retrieved article reports a test event/i);
    return groqSuccess();
  };

  const response = await POST(request({ messages: [{ role: "user", content: "Search the web for latest example news" }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "success");
  assert.deepEqual(payload.sources, [{ title: "Retrieved report", url: "https://news.example/report" }]);
  assert.equal(modelCalled, true);
});

test("search disabled returns a clear response without provider calls", async () => {
  setChatEnv({ search: "false" });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Must not be called"); };
  const response = await POST(request({ messages: [{ role: "user", content: "What is happening in the world right now?" }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "disabled");
  assert.equal(calls, 0);
});

test("Gemini search quota exhaustion falls back to Tavily retrieved content", async () => {
  setChatEnv({ search: "true" });
  setEnv("GEMINI_API_KEY", "test-only");
  setEnv("TAVILY_API_KEY", "test-only");
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return new Response("{}", { status: 429 });
    if (String(url).includes("api.tavily.com")) return new Response(JSON.stringify({
      results: [{ title: "Fallback article", url: "https://news.example/fallback", content: "Retrieved fallback snippet." }],
    }), { status: 200 });
    assert.match(JSON.parse(init.body).messages[0].content, /Retrieved fallback snippet/);
    return groqSuccess();
  };

  const response = await POST(request({ messages: [{ role: "user", content: "Search for latest example news" }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "success");
  assert.equal(payload.sources[0].url, "https://news.example/fallback");
});

test("all search providers failing returns no headlines or citations", async () => {
  setChatEnv({ search: "true" });
  setEnv("GEMINI_API_KEY", "test-only");
  setEnv("TAVILY_API_KEY", "test-only");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 429 }); };
  const response = await POST(request({ messages: [{ role: "user", content: "Give me the latest AI news" }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "error");
  assert.deepEqual(payload.sources, []);
  assert.match(payload.reply, /won't guess/i);
  assert.equal(calls, 2);
});

test("provider quota exhaustion succeeds through configured fallback", async () => {
  setChatEnv();
  setEnv("GEMINI_API_KEY", "test-only");
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.groq.com")) return new Response("{}", { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Gemini fallback reply." }] } }] }), { status: 200 });
  };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "Gemini fallback reply.");
});

test("Ollama can serve local chat without hosted provider credentials", async () => {
  setChatEnv();
  setEnv("AI_PROVIDER", "ollama");
  setEnv("AI_FALLBACK_ENABLED", "false");
  setEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  let requestBody;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: { content: "A local test reply." } }), { status: 200 });
  };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello locally" }] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "A local test reply.");
  assert.equal(requestBody.model, "freya");
  assert.equal(requestBody.options.num_ctx, 4096);
});

test("Ollama outage uses the explicitly configured hosted fallback", async () => {
  setChatEnv();
  setEnv("AI_PROVIDER", "ollama");
  setEnv("AI_FALLBACK_PROVIDER", "groq");
  setEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
  globalThis.fetch = async (url) => {
    if (String(url).includes("127.0.0.1:11434")) throw new Error("Ollama is offline");
    assert.match(String(url), /api\.groq\.com/);
    return groqSuccess();
  };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "A grounded test reply.");
});

test("Next.js delegates to the authenticated Python service and reports the actual provider", async () => {
  setChatEnv();
  setEnv("FREYA_SERVICE_URL", "http://127.0.0.1:8000");
  setEnv("FREYA_SERVICE_TOKEN", "unit-test-token-that-is-at-least-32-characters");
  let serviceCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:8000/v1/chat");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer unit-test-token-that-is-at-least-32-characters");
    serviceCalls += 1;
    return new Response(JSON.stringify({ reply: "Python local reply", provider: "ollama", task: "lightweight_conversation" }), { status: 200 });
  };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, "ollama");
  assert.equal(payload.reply, "Python local reply");
  assert.equal(serviceCalls, 1);
});

test("Python service outage falls back through the existing configured provider", async () => {
  setChatEnv();
  setEnv("FREYA_SERVICE_URL", "http://127.0.0.1:8000");
  setEnv("FREYA_SERVICE_TOKEN", "unit-test-token-that-is-at-least-32-characters");
  globalThis.fetch = async (url) => {
    if (String(url).includes("127.0.0.1:8000")) return new Response("offline", { status: 503 });
    assert.match(String(url), /api\.groq\.com/);
    return groqSuccess();
  };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reply, "A grounded test reply.");
});

test("Python service authentication failure fails closed instead of bypassing its boundary", async () => {
  setChatEnv();
  setEnv("FREYA_SERVICE_URL", "http://127.0.0.1:8000");
  setEnv("FREYA_SERVICE_TOKEN", "unit-test-token-that-is-at-least-32-characters");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unauthorized", { status: 401 }); };
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
});

test("Next.js preserves Python provider identity and text across SSE streaming", async () => {
  setChatEnv();
  setEnv("FREYA_SERVICE_URL", "http://127.0.0.1:8000");
  setEnv("FREYA_SERVICE_TOKEN", "unit-test-token-that-is-at-least-32-characters");
  globalThis.fetch = async (url) => {
    assert.match(String(url), /v1\/chat\/stream$/);
    const events = [
      'event: provider\ndata: {"provider":"ollama","task":"lightweight_conversation"}\n\n',
      'event: delta\ndata: {"text":"Local "}\n\n',
      'event: delta\ndata: {"text":"stream."}\n\n',
      'event: done\ndata: {}\n\n',
    ].join("");
    return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const response = await POST(request({ stream: true, messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: provider/);
  assert.match(body, /"provider":"ollama"/);
  assert.match(body, /event: delta\ndata: "Local "/);
  assert.match(body, /event: done/);
});

test("privacy mode selects Ollama and disables hosted fallback on the direct path", async () => {
  setChatEnv();
  setEnv("FREYA_LOCAL_ONLY", "false");
  setEnv("AI_PROVIDER", "groq");
  setEnv("AI_FALLBACK_ENABLED", "true");
  let calledUrl = "";
  globalThis.fetch = async (url) => { calledUrl = String(url); return new Response("offline", { status: 503 }); };
  const response = await POST(request({ privacyMode: true, messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 502);
  assert.match(calledUrl, /127\.0\.0\.1:11434/);
});

test("privacy mode blocks external search before contacting any provider", async () => {
  setChatEnv({ search: "true" });
  setEnv("AI_PROVIDER", "groq");
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("No upstream calls are permitted in privacy mode"); };
  const response = await POST(request({ privacyMode: true, messages: [{ role: "user", content: "Search the web for the latest AI news" }] }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.searchStatus, "disabled-by-privacy");
  assert.equal(calls, 0);
});

test("all provider failures return a generic response without provider details", async () => {
  setChatEnv();
  setEnv("GEMINI_API_KEY", "test-only");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "secret upstream diagnostic" } }), { status: 503 });
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.doesNotMatch(body, /secret upstream diagnostic|GROQ_API_KEY|stack/i);
});

test("production fails closed when the shared limiter backend is unreachable", async () => {
  setChatEnv({ production: true });
  setEnv("UPSTASH_REDIS_REST_URL", "https://limiter.example.test");
  setEnv("UPSTASH_REDIS_REST_TOKEN", "test-only-token");
  globalThis.fetch = async () => new Response("backend unavailable", { status: 503 });
  const response = await POST(request({ messages: [{ role: "user", content: "Hello" }] }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /abuse protection/i);
});

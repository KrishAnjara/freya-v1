import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { GET } from "../app/api/health/route.ts";

test("health probes every service and reports only working / not working / not configured", async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, { NODE_ENV: "test", GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", TAVILY_API_KEY: "test-only", GROQ_MODEL: "m1", GROQ_FALLBACK_MODELS: "m2" });
  for (const name of ["FREYA_SERVICE_URL", "FREYA_SERVICE_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[name];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes("chat/completions")) {
      const { model } = JSON.parse(init.body);
      // m2 answers with an upstream error that must not leak.
      return model === "m1"
        ? new Response(JSON.stringify({ choices: [{ message: { content: "ready" } }] }))
        : new Response(JSON.stringify({ error: { message: "org_secret quota" } }), { status: 429 });
    }
    if (target.includes("generativelanguage")) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ready" }] } }] }));
    if (target.includes("tavily")) return new Response(JSON.stringify({ results: [] }));
    if (target.includes("transcriptions")) return new Response(JSON.stringify({ text: "" }));
    if (target.includes("/api/chat")) throw new Error("connect ECONNREFUSED");
    throw new Error(`unexpected ${target}`);
  };
  try {
    const response = await GET(new Request("http://localhost/api/health"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.overall, "degraded");
    assert.equal(body.services["cloud: groq m1"], "working");
    assert.equal(body.services["cloud: groq m2"], "not working");
    assert.equal(body.services["api: groq whisper (voice transcription)"], "working");
    assert.equal(body.services["local: ollama freya"], "not working");
    assert.equal(body.services["service: orchestration"], "not configured");
    assert.ok(Object.values(body.services).every((status) => ["working", "not working", "not configured"].includes(status)));
    assert.doesNotMatch(JSON.stringify(body), /org_secret|test-only|ready/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("in production the health route needs its token", async () => {
  const route = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.match(route, /FREYA_HEALTH_TOKEN/);
  assert.match(route, /status: 401/);
});

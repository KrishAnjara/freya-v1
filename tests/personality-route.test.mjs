import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { GET } from "../app/api/personality/route.ts";

const originalFetch = globalThis.fetch;
const originalEnv = new Map();

function setEnv(name, value) {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(token) {
  return new Request("http://localhost/api/personality", { headers: { Authorization: `Bearer ${token}` } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
});

test("personality profile reads are authenticated and isolated by verified Supabase user", async () => {
  setEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.example.test");
  setEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  const profileFor = new Map([
    ["user-a", { version: 1, preferences: [{ id: "a", kind: "taste", text: "A profile only", confidence: 0.7, status: "established" }] }],
    ["user-b", { version: 1, preferences: [{ id: "b", kind: "taste", text: "B profile only", confidence: 0.7, status: "established" }] }],
  ]);
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const token = new Headers(init.headers).get("authorization");
    if (parsed.pathname.endsWith("/auth/v1/user")) {
      const id = token === "Bearer token-a" ? "user-a" : "user-b";
      return new Response(JSON.stringify({ id, aud: "authenticated", role: "authenticated", email: `${id}@example.test`, created_at: "2026-01-01T00:00:00.000Z", app_metadata: {}, user_metadata: {}, identities: [] }), { status: 200 });
    }
    seen.push({ path: parsed.pathname, user: parsed.searchParams.get("user_id"), token });
    const userId = parsed.searchParams.get("user_id")?.replace("eq.", "");
    if (parsed.pathname.endsWith("freya_personality_revisions")) {
      return new Response(JSON.stringify([{ revision: 1, profile: profileFor.get(userId), summary: "test", rollback_from: null, created_at: "2026-01-01T00:00:00.000Z" }]), { status: 200 });
    }
    return new Response("[]", { status: 200 });
  };

  const a = await GET(request("token-a"));
  const b = await GET(request("token-b"));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal((await a.json()).profile.preferences[0].text, "A profile only");
  assert.equal((await b.json()).profile.preferences[0].text, "B profile only");
  assert.ok(seen.some((row) => row.user === "eq.user-a" && row.token === "Bearer token-a"));
  assert.ok(seen.some((row) => row.user === "eq.user-b" && row.token === "Bearer token-b"));
});

test("personality history rejects missing authentication without querying storage", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Must not be called"); };
  const response = await GET(new Request("http://localhost/api/personality"));
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

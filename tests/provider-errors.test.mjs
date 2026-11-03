import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { coolingDownMessage, describeFailure, isCoolingDown, ProviderHttpError, providerErrorDetail, recordFailure, redact, resetProviderHealthForTests } from "../lib/provider-health.ts";
import { geminiModel, geminiThinking } from "../lib/gemini-config.ts";

afterEach(() => { resetProviderHealthForTests(); delete process.env.GEMINI_MODEL; delete process.env.GEMINI_THINKING_LEVEL; });

test("the provider's reason is read from every error shape in use", () => {
  assert.equal(providerErrorDetail({ code: "invalid-argument", error: "Incorrect API key provided." }), "invalid-argument: Incorrect API key provided.");
  assert.equal(providerErrorDetail({ error: { message: "Rate limit reached", type: "tokens" } }), "tokens: Rate limit reached");
  assert.equal(providerErrorDetail({ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }), "UNAVAILABLE: high demand");
  assert.equal(providerErrorDetail([{ error: { message: "array form" } }]), "array form");
  assert.equal(providerErrorDetail(null), "");
});

test("keys never reach the log", () => {
  const text = redact("bad key AIzaSyA1234567890abcdef and xai-abcdefghijklmnop, Bearer gsk_secret123 at https://x/y?key=AIzaSecretSecret&alt=sse");
  for (const secret of ["AIzaSyA1234567890abcdef", "xai-abcdefghijklmnop", "gsk_secret123", "AIzaSecretSecret"]) assert.ok(!text.includes(secret), secret);
  assert.ok(redact("x".repeat(1000)).length <= 240);
});

test("a refused key is named as such, even when it comes back as a 400", () => {
  const error = new ProviderHttpError("Grok request failed (400).", 400, undefined, "invalid-argument: Incorrect API key provided.");
  assert.equal(error.auth, true);
  assert.match(describeFailure(error), /HTTP 400: invalid-argument: Incorrect API key provided\. \(the API key was refused/);
  assert.equal(new ProviderHttpError("x", 400, undefined, "max_tokens too large").auth, false);
});

test("a refused key cools down for minutes, an outage for seconds, and both say why", () => {
  const now = 1_000_000;
  recordFailure("grok:test", new ProviderHttpError("x", 400, undefined, "Incorrect API key provided."), now);
  assert.equal(isCoolingDown("grok:test", now + 5 * 60_000), true);
  assert.match(coolingDownMessage("grok:test", now), /^cooling down for 10m after: HTTP 400: Incorrect API key/);
  recordFailure("gemini:test", new DOMException("no response in 25s", "TimeoutError"), now);
  assert.equal(isCoolingDown("gemini:test", now + 60_000), false);
  assert.match(coolingDownMessage("gemini:test", now), /after: no answer in time \(no response in 25s\)/);
});

test("network failures name their cause instead of a bare 'network'", () => {
  const error = new TypeError("fetch failed", { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.x.ai" } });
  assert.match(describeFailure(error), /network error ENOTFOUND getaddrinfo ENOTFOUND api\.x\.ai/);
});

test("Gemini defaults to a model that still exists, and Gemini 3 Flash thinks minimally", () => {
  assert.equal(geminiModel(), "gemini-3.1-flash-lite");
  assert.deepEqual(geminiThinking("gemini-3.5-flash-lite"), { thinkingConfig: { thinkingLevel: "minimal" } });
  assert.deepEqual(geminiThinking("gemini-3-pro"), {}, "Pro doesn't accept minimal");
  assert.deepEqual(geminiThinking("gemini-test"), {});
  process.env.GEMINI_THINKING_LEVEL = "default";
  assert.deepEqual(geminiThinking("gemini-3.5-flash-lite"), {});
});

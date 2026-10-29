import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { speakable, spokenSeconds } from "../lib/voice-playback.ts";
import { POST } from "../app/api/transcribe/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const savedKey = process.env.GROQ_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedKey;
  resetLocalRateLimitsForTests();
});

function transcribe(body) {
  return POST(new Request("http://localhost/api/transcribe", {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.90" }, body: JSON.stringify(body),
  }));
}

test("only short prose becomes a voice note; code, tables, headings and long text stay text", () => {
  assert.equal(speakable("honestly? go to bed."), true);
  assert.equal(speakable("```js\nlet a = 1;\n```"), false);
  assert.equal(speakable("| a | b |\n|---|---|"), false);
  assert.equal(speakable("## Steps"), false);
  assert.equal(speakable("word ".repeat(120)), false);
  assert.equal(spokenSeconds("one two three four five six"), 2);
});

test("a voice message is sent to Whisper as an audio file and its transcript returned", async () => {
  process.env.GROQ_API_KEY = "test-only";
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), form: init.body };
    return new Response(JSON.stringify({ text: " hey, you up? " }), { status: 200 });
  };
  const response = await transcribe({ audio: "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibQ==", mime: "audio/webm;codecs=opus" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hey, you up?" });
  assert.match(sent.url, /audio\/transcriptions$/);
  assert.equal(sent.form.get("file").type, "audio/webm");
  assert.equal(sent.form.get("model"), "whisper-large-v3");
});

test("bad or unsupported recordings are refused before any provider call", async () => {
  process.env.GROQ_API_KEY = "test-only";
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}"); };
  assert.equal((await transcribe({ audio: "%%%", mime: "audio/webm" })).status, 400);
  assert.equal((await transcribe({ audio: "AAAA", mime: "text/html" })).status, 400);
  assert.equal(calls, 0);
});

test("provider failure detail never reaches the browser", async () => {
  process.env.GROQ_API_KEY = "test-only";
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "org_abc123 quota exceeded" } }), { status: 429 });
  const response = await transcribe({ audio: "AAAA", mime: "audio/webm" });
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /org_abc123/);
});

test("reply actions are gone; resend shows only for failed or unanswered messages", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /MessageActions/);
  assert.match(page, /message\.failed \|\| \(awaitingReply && index === messages\.length - 1\)/);
});

test("the highlighter is stored as a plugin, not called by useState as an initializer", async () => {
  const markdown = await readFile(new URL("../app/components/MarkdownContent.tsx", import.meta.url), "utf8");
  // useState(fn) runs fn; that put a transformer where a plugin belongs and crashed rendering.
  assert.match(markdown, /useState<Highlighter \| null>\(\(\) => highlighter\)/);
});

test("voice notes skip emoji and symbols but keep words, numbers and currency", async () => {
  const { toSpeakableText } = await import("../lib/speech.ts");
  assert.equal(toSpeakableText("lol 😂😂 you're wild ❤️ → go to sleep ✓"), "lol you're wild go to sleep");
  assert.equal(toSpeakableText("👍🏽 fine, $20 and 50% off™"), "fine, $20 and 50% off");
  assert.equal(toSpeakableText("👨‍👩‍👧 family 🇮🇳 trip"), "family trip");
});

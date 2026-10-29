import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { splitLongProse, takeCompleteParts } from "../lib/reply-parts.ts";
import { describeThread, modelHistory, requestTurns } from "../lib/chat-thread.ts";
import { AttachmentError, classifyAttachment, parseWireAttachments } from "../lib/attachments.ts";
import { POST } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

/** Feeds text through the splitter in small chunks, as a stream would. */
function stream(text, size = 7) {
  const parts = [];
  let buffer = "";
  for (let index = 0; index < text.length; index += size) {
    const result = takeCompleteParts(buffer + text.slice(index, index + size));
    parts.push(...result.parts);
    buffer = result.rest;
  }
  parts.push(...takeCompleteParts(buffer, true).parts);
  return parts;
}

test("a streamed reply is posted paragraph by paragraph, each once complete", () => {
  const reply = "Okay, fair.\n\nBut here's the thing: you skipped a step.\n\nTry it again.";
  assert.deepEqual(stream(reply), ["Okay, fair.", "But here's the thing: you skipped a step.", "Try it again."]);
  // Nothing is posted before its paragraph has ended.
  const early = takeCompleteParts("Okay, fair.\n\nBut here");
  assert.deepEqual(early.parts, ["Okay, fair."]);
  assert.equal(early.rest, "But here");
});

test("code fences are never split, even across blank lines", () => {
  const reply = "Here you go:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThat's it.";
  const parts = stream(reply);
  assert.equal(parts.length, 2, "the lead-in stays with the code it introduces");
  assert.match(parts[0], /^Here you go:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```$/);
  assert.equal(parts[1], "That's it.");
});

test("headings and list items stay with their content", () => {
  const parts = stream("## Steps\n\nDo this first.\n\n- one\n\n- two\n\nDone.");
  assert.deepEqual(parts, ["## Steps\n\nDo this first.", "- one\n\n- two", "Done."]);
});

test("an unclosed fence at the end of a reply is closed rather than lost", () => {
  const parts = stream("```file:notes.md\n# Notes\nline");
  assert.equal(parts.length, 1);
  assert.match(parts[0], /```file:notes\.md\n# Notes\nline\n```$/);
});

test("long prose is cut at sentence ends so no message is a wall of text", () => {
  const sentence = "This sentence is here to make a long paragraph longer than it should be. ";
  const pieces = splitLongProse(sentence.repeat(30).trim());
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length <= 900, "each piece fits the limit");
  assert.ok(pieces.every((piece) => /\.$/.test(piece)), "cuts land on sentence ends");
  // A paragraph still streaming is cut too, without waiting for its blank line.
  const streaming = takeCompleteParts(sentence.repeat(20));
  assert.ok(streaming.parts.length >= 1);
});

test("for the model, a reply follows the message it answers, even if another arrived mid-reply", () => {
  const messages = [
    { id: "a", role: "user", content: "first question" },
    { id: "p1", role: "assistant", content: "part one", turn: "t1", replyTo: "a" },
    { id: "b", role: "user", content: "second question" },
    { id: "p2", role: "assistant", content: "part two", turn: "t1", replyTo: "a" },
  ];
  assert.deepEqual(modelHistory(messages).map(({ role, content }) => [role, content]), [
    ["user", "first question"],
    ["assistant", "part one\n\npart two"],
    ["user", "second question"],
  ]);
});

test("messages sent while waiting are merged into one turn, and the reply is tagged", () => {
  const messages = [
    { id: "a", role: "user", content: "hello" },
    { id: "r1", role: "assistant", content: "hi", turn: "t1", replyTo: "a" },
    { id: "b", role: "user", content: "also" },
    { id: "c", role: "user", content: "one more thing" },
    { id: "r2", role: "assistant", content: "sure", turn: "t2", replyTo: "c" },
    { id: "r0", role: "assistant", content: "late answer", turn: "t0", replyTo: "a" },
  ];
  const history = modelHistory(messages.slice(0, 4));
  assert.deepEqual(history.at(-1), { role: "user", content: "also\n\none more thing", attachments: [] });
  const rows = describeThread(messages);
  assert.equal(rows[4].tag, undefined, "a reply right under its message needs no tag");
  assert.equal(rows[5].tag?.id, "a", "a reply separated from its message is tagged");
  assert.equal(rows[1].endsTurn, true);
  assert.equal(rows[2].startsRun, true);
  assert.equal(rows[3].startsRun, false);
});

test("a reply's actions sit under its last part and act on the whole reply", () => {
  const rows = describeThread([
    { id: "a", role: "user", content: "q" },
    { id: "p1", role: "assistant", content: "one", turn: "t", replyTo: "a" },
    { id: "b", role: "user", content: "interjection" },
    { id: "p2", role: "assistant", content: "two", turn: "t", replyTo: "a" },
  ]);
  assert.equal(rows[1].endsTurn, false, "split by an interjection, the reply still ends later");
  assert.equal(rows[3].endsTurn, true);
  assert.equal(rows[3].turnText, "one\n\ntwo");
});

test("only the current turn carries attachment bytes; older ones are described", () => {
  const image = { id: "i1", name: "cat.jpg", mime: "image/jpeg", size: 2048, kind: "image" };
  const older = { id: "i0", name: "old.png", mime: "image/jpeg", size: 1024, kind: "image" };
  const { turns, sent } = requestTurns([
    { role: "user", content: "look", attachments: [older] },
    { role: "assistant", content: "nice", attachments: [] },
    { role: "user", content: "", attachments: [image] },
  ]);
  assert.deepEqual(sent, [image]);
  assert.match(turns[0].content, /\[Attached image: old\.png/);
  assert.equal(turns[2].content, "(sent without a message)");
  assert.ok(turns.every((turn) => turn.content.length <= 6000));
});

test("attachments are validated by what they are, not what the browser claims", () => {
  assert.equal(classifyAttachment("", "report.PDF"), "pdf");
  assert.equal(classifyAttachment("application/octet-stream", "main.py"), "text");
  assert.equal(classifyAttachment("image/svg+xml", "logo.svg"), "text", "SVG is read as markup, not sent to vision");
  assert.throws(() => parseWireAttachments([{ name: "x.png", mime: "image/png", data: "not base64!" }]), AttachmentError);
  assert.throws(() => parseWireAttachments(Array.from({ length: 5 }, () => ({ name: "a.txt", mime: "text/plain", text: "a" }))), AttachmentError);
  const [text] = parseWireAttachments([{ name: "a.txt", mime: "text/plain", kind: "image", text: "hello" }]);
  assert.equal(text.kind, "text");
});

test("FREYA's files and drawings render as cards and sandboxed images", async () => {
  const markdown = await readFile(new URL("../app/components/MarkdownContent.tsx", import.meta.url), "utf8");
  assert.match(markdown, /file:\(\.\+\)/, "```file:name blocks become file cards");
  assert.match(markdown, /data:image\/svg\+xml/, "SVG is shown through <img>, where it cannot run scripts");
  assert.doesNotMatch(markdown, /dangerouslySetInnerHTML/);
});

test("the composer has no stop button; messages sent mid-reply are queued", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Stop generating/);
  assert.match(page, /function enqueueReply/);
  assert.match(page, /takeCompleteParts\(/);
  assert.doesNotMatch(page, /useTypewriter|AssistantMessage/);
});

const originalFetch = globalThis.fetch;
const savedEnv = new Map();
function setEnv(name, value) {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  resetLocalRateLimitsForTests();
});

function chatEnv() {
  setEnv("NODE_ENV", "test");
  setEnv("FREYA_TRUSTED_IP_HEADER", undefined);
  setEnv("UPSTASH_REDIS_REST_URL", undefined);
  setEnv("UPSTASH_REDIS_REST_TOKEN", undefined);
  setEnv("GROQ_API_KEY", "test-only");
  setEnv("GEMINI_API_KEY", "test-only");
  setEnv("AI_PROVIDER", "groq");
  setEnv("AI_FALLBACK_PROVIDER", undefined);
  setEnv("FREYA_SERVICE_URL", undefined);
  setEnv("FREYA_SERVICE_TOKEN", undefined);
  setEnv("FREYA_LOCAL_ONLY", "false");
  setEnv("WEB_SEARCH_ENABLED", "false");
}

function chatRequest(body) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.77" },
    body: JSON.stringify(body),
  });
}

test("an image turn goes to the vision provider with the bytes attached", async () => {
  chatEnv();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "That's a very small square." }] } }] }), { status: 200 });
  };
  const response = await POST(chatRequest({
    messages: [{ role: "user", content: "what is this?", attachments: [{ name: "dot.png", mime: "image/png", data: "iVBORw0KGgo=" }] }],
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  const parts = calls[0].body.contents.at(-1).parts;
  assert.match(parts[0].text, /\[Attached image: dot\.png/);
  assert.deepEqual(parts[1], { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
});

test("a text file is folded into the turn for any provider, and bad attachments are refused", async () => {
  chatEnv();
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Read it." } }] }), { status: 200 });
  };
  const ok = await POST(chatRequest({
    messages: [{ role: "user", content: "summarise", attachments: [{ name: "notes.txt", mime: "text/plain", text: "alpha beta" }] }],
  }));
  assert.equal(ok.status, 200);
  const last = sent.messages.at(-1);
  assert.match(last.content, /Contents of notes\.txt:\n~~~~\nalpha beta\n~~~~/);
  assert.equal(last.inline, undefined, "text-only providers receive no unknown fields");

  const bad = await POST(chatRequest({
    messages: [{ role: "user", content: "x", attachments: [{ name: "x.png", mime: "image/png", data: "%%%" }] }],
  }));
  assert.equal(bad.status, 400);
});

test("when vision fails over to a text-only model, that model is told it cannot see the image", async () => {
  chatEnv();
  let groqBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage")) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    groqBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "I can't see it from here." } }] }), { status: 200 });
  };
  const response = await POST(chatRequest({
    messages: [{ role: "user", content: "rate my photo", attachments: [{ name: "me.jpg", mime: "image/jpeg", data: "/9j/4AAQ" }] }],
  }));
  assert.equal(response.status, 200);
  // In testing, Groq given only the file name described a picture it never received.
  assert.match(groqBody.messages.at(-1).content, /could not be passed to you\. You cannot see or hear it/);
});

test("a burst of messages is answered once; a reply with nothing on screen yet is restarted", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /BURST_MS = 1500/, "rapid messages get a moment to finish before she answers");
  assert.match(page, /activePostedRef\.current === 0\) \{\n\s*activeChatRequest\.current\?\.abort\(\);/, "an unstarted reply is called off and restarted for the whole burst");
  assert.match(page, /if \(waiting && !interrupted\) waiting\.targetId = job\.targetId;/, "messages split by a FREYA reply are not merged");
});

test("every FREYA message is announced", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /if \(soundRef\.current\) playChime\(\);/);
  assert.match(page, /notificationsRef\.current && \(unfocused \|\| elsewhere\)/);
});

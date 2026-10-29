import assert from "node:assert/strict";
import { test } from "node:test";
import { streamReply } from "../lib/llm.ts";

const originalFetch = globalThis.fetch;
const SEP = "\n\n";

function sseResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function groqDelta(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}${SEP}`;
}

function geminiDelta(text) {
  return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}${SEP}`;
}

async function collect(iterable) {
  let out = "";
  for await (const delta of iterable) out += delta;
  return out;
}

test("provider deltas stream through in order", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  globalThis.fetch = async () => sseResponse([
    groqDelta("Hel"),
    groqDelta("lo, ") + groqDelta("summoner"),
    `data: [DONE]${SEP}`,
  ]);
  assert.equal(await collect(streamReply("sys", [{ role: "user", content: "hi" }])), "Hello, summoner");
  globalThis.fetch = originalFetch;
});

test("an SSE event split across two reads is still parsed", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  const whole = groqDelta("A") + groqDelta("B");
  // Split mid-boundary, the case a naive per-chunk parser drops.
  globalThis.fetch = async () => sseResponse([whole.slice(0, whole.indexOf(SEP) + 1), whole.slice(whole.indexOf(SEP) + 1)]);
  assert.equal(await collect(streamReply("sys", [{ role: "user", content: "hi" }])), "AB");
  globalThis.fetch = originalFetch;
});

test("a primary failure before any output falls back to the secondary provider", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_FALLBACK_ENABLED = "true";
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    // Every Groq model in the chain is down; Gemini answers.
    if (String(url).includes("groq.com")) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    return sseResponse([geminiDelta("from gemini")]);
  };
  assert.equal(await collect(streamReply("sys", [{ role: "user", content: "hi" }])), "from gemini");
  assert.ok(urls.at(-1).includes("generativelanguage"), "Gemini answers once Groq is exhausted");
  globalThis.fetch = originalFetch;
});

test("a rate-limited Groq model falls through to the next Groq model", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.GROQ_MODEL = "qwen/qwen3.8-27b";
  process.env.GROQ_FALLBACK_MODELS = "openai/gpt-oss-120b";
  const models = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    models.push(`${body.model}@${body.reasoning_effort}`);
    if (body.model.startsWith("qwen")) return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    return sseResponse([groqDelta("from gpt-oss")]);
  };
  assert.equal(await collect(streamReply("sys", [{ role: "user", content: "hi" }])), "from gpt-oss");
  // gpt-oss rejects reasoning_effort "none" with HTTP 400, so it must get "low".
  assert.deepEqual(models, ["qwen/qwen3.8-27b@none", "openai/gpt-oss-120b@low"]);

  // The rate-limited model is now cooling down: the next request skips it entirely.
  models.length = 0;
  await collect(streamReply("sys", [{ role: "user", content: "again" }]));
  assert.deepEqual(models, ["openai/gpt-oss-120b@low"]);
  delete process.env.GROQ_MODEL;
  delete process.env.GROQ_FALLBACK_MODELS;
  globalThis.fetch = originalFetch;
});

test("a failure after partial output does not splice in a second provider", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_FALLBACK_ENABLED = "true";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      // pull() lets the first chunk actually be consumed before the stream errors.
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(groqDelta("partial")));
            return;
          }
          controller.error(new Error("connection lost mid-reply"));
        },
      });
      return new Response(body, { status: 200 });
    }
    return sseResponse([geminiDelta("SHOULD NOT APPEAR")]);
  };
  let out = "";
  await assert.rejects(async () => {
    for await (const delta of streamReply("sys", [{ role: "user", content: "hi" }])) out += delta;
  });
  // Text already shown to the reader survives, and no second answer is spliced onto it.
  assert.equal(out, "partial");
  assert.equal(calls, 1, "secondary provider must not be called after partial output");
  globalThis.fetch = originalFetch;
});

function groqChunk(text, finish) {
  const choice = { delta: text ? { content: text } : {} };
  if (finish) choice.finish_reason = finish;
  return `data: ${JSON.stringify({ choices: [choice] })}${SEP}`;
}

test("a reply cut off by the token ceiling is continued into one stream", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  let calls = 0;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    sent.push(JSON.parse(init.body));
    if (calls === 1) return sseResponse([groqChunk("Part one"), groqChunk("", "length")]);
    return sseResponse([groqChunk(" and part two."), groqChunk("", "stop")]);
  };
  const outcome = { truncated: false, parts: 0 };
  const out = await collect(streamReply("sys", [{ role: "user", content: "hi" }], undefined, outcome));
  assert.equal(out, "Part one and part two.");
  assert.equal(calls, 2, "a truncated reply must trigger exactly one continuation pass");
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.parts, 2);
  // The continuation carries the text so far plus an explicit resume instruction.
  const followUp = sent[1].messages;
  assert.equal(followUp.at(-2).role, "assistant");
  assert.match(followUp.at(-2).content, /Part one/);
  assert.match(followUp.at(-1).content, /Continue your previous message/);
  globalThis.fetch = originalFetch;
});

test("continuation stops at the budget and reports that more remains", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  process.env.AI_MAX_CONTINUATIONS = "2";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return sseResponse([groqChunk(`[${calls}]`), groqChunk("", "length")]);
  };
  const outcome = { truncated: false, parts: 0 };
  const out = await collect(streamReply("sys", [{ role: "user", content: "hi" }], undefined, outcome));
  // One initial pass plus two continuations, then it hands the choice back to the reader.
  assert.equal(out, "[1][2][3]");
  assert.equal(calls, 3);
  assert.equal(outcome.truncated, true, "the UI needs to know more text remains");
  delete process.env.AI_MAX_CONTINUATIONS;
  globalThis.fetch = originalFetch;
});

test("a truncated pass that yields nothing does not loop forever", async () => {
  process.env.AI_PROVIDER = "groq";
  process.env.GROQ_API_KEY = "test-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return sseResponse([groqChunk("text"), groqChunk("", "length")]);
    return sseResponse([groqChunk("", "length")]);
  };
  const out = await collect(streamReply("sys", [{ role: "user", content: "hi" }]));
  assert.equal(out, "text");
  assert.ok(calls <= 3, `expected the empty pass to break the loop, saw ${calls} calls`);
  globalThis.fetch = originalFetch;
});

test("Gemini's CRLF-framed stream is read, even with a CR split from its LF across chunks", async () => {
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_FALLBACK_ENABLED = "false";
  const event = (text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`;
  const second = event(" world");
  // As captured from the live API: CRLF line endings, no bare "\n\n" anywhere.
  globalThis.fetch = async () => sseResponse([event("Hello"), second.slice(0, -3), second.slice(-3)]);
  try {
    assert.equal(await collect(streamReply("system", [{ role: "user", content: "hi" }])), "Hello world");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AI_FALLBACK_ENABLED;
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import {
  beginStream, contentWords, failStream, finishStream, MAX_FRAGMENTS, recordChunk, recordMeta,
  recordProvider, resetTelemetryForTests, state, streamStats,
} from "../lib/stream-telemetry.ts";

beforeEach(() => resetTelemetryForTests());

test("a stream records each chunk exactly as received, with arrival timing", () => {
  beginStream("explain neural networks");
  assert.equal(state.phase, "waiting");
  recordProvider("groq");
  recordMeta(4, "success");
  recordChunk("Neural ");
  recordChunk("networks learn.");
  assert.equal(state.phase, "streaming");
  assert.deepEqual(state.fragments.map((fragment) => fragment.text), ["Neural ", "networks learn."]);
  assert.equal(state.provider, "groq");
  assert.equal(state.sourceCount, 4);
  assert.ok(state.firstChunkAt !== null && state.firstChunkAt >= 0);
  assert.ok(state.fragments[1].at >= state.fragments[0].at, "arrival times never run backwards");
  finishStream(false);
  assert.equal(state.phase, "done");
  assert.equal(streamStats().chunks, 2);
});

test("lexical links are word reuse, including back to the prompt", () => {
  beginStream("tell me about entropy");
  recordChunk("Entropy measures disorder. ");
  recordChunk("More disorder means more entropy.");
  const words = state.links.map((link) => `${link.from}->${link.to}:${link.word}`);
  assert.ok(words.includes("-1->0:entropy"), "first use links back to the prompt");
  assert.ok(words.includes("0->1:disorder"), "reuse within the reply links to the earlier chunk");
  assert.ok(words.includes("0->1:entropy"));
});

test("a word split across two chunks is matched once it is complete", () => {
  beginStream("what is cognition");
  recordChunk("Cogni");
  recordChunk("tion is thinking.");
  assert.ok(state.links.some((link) => link.word === "cognition" && link.from === -1), "split word must still link to the prompt");
  assert.ok(!state.links.some((link) => link.word === "cogni"), "the fragment half must not be matched as a word");
});

test("stopwords and short words never create links", () => {
  assert.deepEqual(contentWords("This is what they would have said about that"), []);
  assert.deepEqual(contentWords("Quantum entanglement, again!"), ["quantum", "entanglement"]);
});

test("events outside an open stream are ignored", () => {
  recordChunk("stray");
  assert.equal(state.fragments.length, 0);
  beginStream("hi there");
  finishStream();
  recordChunk("late chunk");
  assert.equal(state.fragments.length, 0, "chunks after completion must not be recorded");
});

test("an aborted stream is marked severed, an error as failed", () => {
  beginStream("question");
  failStream(true);
  assert.equal(state.phase, "aborted");
  beginStream("question");
  failStream(false);
  assert.equal(state.phase, "error");
});

test("geometry stays bounded on very long replies", () => {
  beginStream("long");
  for (let index = 0; index < MAX_FRAGMENTS + 50; index += 1) recordChunk(`word${index} `);
  assert.equal(state.fragments.length, MAX_FRAGMENTS);
  assert.ok(state.totalChars > 0);
});

test("the canvas labels its data honestly and never claims model internals", async () => {
  const canvas = await readFile(new URL("../app/components/EmotionCanvas.tsx", import.meta.url), "utf8");
  assert.match(canvas, /no model internals are exposed/);
  assert.match(canvas, /lattice illustrative/);
  assert.match(canvas, /repeated words, not attention/);
  // Pulses come only from real chunks: a window of received chunks launches one pulse.
  assert.match(canvas, /launches exactly one pulse/);
  assert.match(canvas, /No window, no pulse/);
  assert.match(canvas, /each pulse = chunks received in 80ms/, "the legend must say what a pulse means");
  assert.doesNotMatch(canvas, /Math\.random\(\)[^\n]*pulses\.push/, "no randomly spawned pulses");
  assert.doesNotMatch(canvas, /hidden reasoning visual|thought stream|model thoughts/i);
});

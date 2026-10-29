import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, beforeEach } from "node:test";

/** Minimal speechSynthesis stand-in that records what it was asked to say. */
function installSpeechStub() {
  const spoken = [];
  let cancelled = 0;
  class Utterance {
    constructor(text) {
      this.text = text;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onboundary = null;
    }
  }
  globalThis.window = {
    speechSynthesis: {
      cancel() { cancelled += 1; },
      speak(utterance) {
        spoken.push(utterance);
        utterance.onstart?.();
      },
      getVoices: () => [
        { lang: "en-US", name: "Microsoft Ava Online (Natural) - English (United States)", localService: false },
        { lang: "hi-IN", name: "Stub HI", localService: true },
      ],
      addEventListener() {},
    },
    SpeechSynthesisUtterance: Utterance,
  };
  globalThis.SpeechSynthesisUtterance = Utterance;
  return { spoken, cancelled: () => cancelled };
}

let stub;
beforeEach(() => { stub = installSpeechStub(); });

async function loadSpeech() {
  // Fresh module per test so the singleton's state does not leak between cases.
  return import(`../lib/speech.ts?v=${Math.random()}`);
}

test("speak() actually reaches the synthesis API", async () => {
  const { speak } = await loadSpeech();
  const problem = speak("Tell me what you actually think.");
  assert.equal(problem, null, "a healthy call reports no problem");
  assert.equal(stub.spoken.length, 1, "exactly one utterance should be queued");
  assert.match(stub.spoken[0].text, /Tell me what you actually think/);
});

test("markdown is stripped before it is voiced", async () => {
  const { speak } = await loadSpeech();
  speak("## Heading\n\nSome **bold** and `code` and [a link](https://example.com).");
  const text = stub.spoken[0].text;
  assert.doesNotMatch(text, /[#*`\[\]]/, `markup leaked into speech: ${text}`);
  assert.match(text, /Some bold and code and a link/);
});

test("the same voice speaks every language", async () => {
  const { speak } = await loadSpeech();
  speak("Tell me what you actually think about all of this today.");
  speak("नमस्ते, मैं ठीक हूँ और तुम कैसे हो आज");
  speak("こんにちは、今日はいい天気ですね");
  assert.equal(stub.spoken.length, 3);
  const names = new Set(stub.spoken.map((utterance) => utterance.voice?.name));
  // The point of the change: one character, one voice, regardless of the language.
  assert.equal(names.size, 1, `expected a single voice across languages, got ${[...names].join(", ")}`);
  assert.match([...names][0] ?? "", /Natural/, "the neural voice should win over the local one");
});

test("a single-language voice is not told to speak a foreign language", async () => {
  const { speak } = await loadSpeech();
  speak("नमस्ते, मैं ठीक हूँ और तुम कैसे हो आज");
  // Setting lang to hi-IN on an en-US-only voice makes engines drop the voice or go silent.
  assert.equal(stub.spoken[0].lang, stub.spoken[0].voice?.lang);
});

test("muting blocks playback and reports why", async () => {
  const { speak, setMuted } = await loadSpeech();
  setMuted(true);
  const problem = speak("Should stay silent.");
  assert.equal(stub.spoken.length, 0, "nothing may be spoken while muted");
  assert.match(problem ?? "", /muted/i);
  setMuted(false);
  assert.equal(speak("Now audible."), null);
  assert.equal(stub.spoken.length, 1);
});

test("an unsupported browser reports instead of throwing", async () => {
  globalThis.window = {};
  delete globalThis.SpeechSynthesisUtterance;
  const { speak } = await loadSpeech();
  const problem = speak("anything");
  assert.match(problem ?? "", /not supported/i);
});

test("voice notes play directly, not through a component that may be unmounted", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const note = await readFile(new URL("../app/components/VoiceNote.tsx", import.meta.url), "utf8");
  const playback = await readFile(new URL("../lib/voice-playback.ts", import.meta.url), "utf8");
  // The old regression: Speak set state read only by VoiceControls, which mounts solely inside
  // the settings dialog, so pressing it did nothing. Voice notes call the speech module itself.
  assert.match(note, /playVoice\(messageId, transcript\)/);
  assert.match(playback, /speak\(note\.text,/);
  assert.doesNotMatch(page, /queueVoice\(/, "her voice notes never autoplay; they play when pressed");
  assert.doesNotMatch(page, /setSpeechRequest\(/);
  assert.match(page, /primeVoices\(\)/, "the voice list must be primed before the first press");
});

test("playback lives outside the React tree so a closed panel cannot disable it", async () => {
  const speechSource = await readFile(new URL("../lib/speech.ts", import.meta.url), "utf8");
  assert.doesNotMatch(speechSource, /from "react"/, "the speech module must not depend on React");
  assert.match(speechSource, /export function speak\(/);
  assert.match(speechSource, /export function cancelSpeech\(/);
});

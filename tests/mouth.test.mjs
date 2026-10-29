import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginUtterance,
  isSpeaking,
  mouthOpening,
  speechEmphasis,
  stopSpeaking,
} from "../lib/mouth-drive.ts";

/** Peak opening observed across a word's whole scheduled span. */
function peakFor(word, rate = 1) {
  beginUtterance(word, rate);
  const start = performance.now();
  let best = 0;
  for (let t = 0; t <= 1400; t += 4) best = Math.max(best, mouthOpening(start + t));
  stopSpeaking();
  return best;
}

test("the mouth is shut unless something is being spoken", () => {
  stopSpeaking();
  assert.equal(isSpeaking(), false);
  assert.equal(mouthOpening(performance.now()), 0);
});

test("open vowels drop the jaw further than closed ones", () => {
  const open = peakFor("aah");
  const closed = peakFor("eee");
  assert.ok(open > closed, `"aah" (${open.toFixed(2)}) should open wider than "eee" (${closed.toFixed(2)})`);
  assert.ok(open <= 1 && closed >= 0);
});

test("each syllable articulates instead of the jaw hanging open", () => {
  beginUtterance("banana");
  const start = performance.now();
  const samples = [];
  for (let t = 0; t <= 900; t += 6) samples.push(mouthOpening(start + t));
  let peaks = 0;
  for (let i = 1; i < samples.length - 1; i += 1) {
    if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1] && samples[i] > 0.1) peaks += 1;
  }
  assert.ok(peaks >= 2, `expected multiple syllable peaks for "banana", saw ${peaks}`);
  stopSpeaking();
});

test("scripts without separable vowels still articulate", () => {
  // Chinese and Korean carry a syllable per glyph; without a beat each they stayed shut.
  assert.ok(peakFor("你好世界") > 0.2, "Han characters should move the mouth");
  assert.ok(peakFor("안녕하세요") > 0.2, "Hangul should move the mouth");
  assert.ok(peakFor("नमस्ते") > 0.2, "Devanagari vowel signs should move the mouth");
  // Arabic and Hebrew omit vowel diacritics, so consonants have to carry the syllable.
  assert.ok(peakFor("مرحبا كيف حالك") > 0.3, "Arabic consonants should move the mouth");
  assert.ok(peakFor("שלום מה שלומך") > 0.3, "Hebrew consonants should move the mouth");
});

test("consonant-only utterances still part the lips", () => {
  assert.ok(peakFor("shh") > 0, "a consonant cluster should still move the lips a little");
});

test("the mouth closes once the utterance is stopped", () => {
  beginUtterance("hi there");
  stopSpeaking();
  assert.equal(mouthOpening(performance.now()), 0, "the jaw must not hang open after speech ends");
});

test("emphasis rises on stressed words and falls on trailing punctuation", () => {
  beginUtterance("WAIT");
  const shouted = speechEmphasis();
  stopSpeaking();

  beginUtterance("and,");
  const aside = speechEmphasis();
  stopSpeaking();

  assert.ok(shouted > aside, `"WAIT" (${shouted.toFixed(2)}) should outweigh "and," (${aside.toFixed(2)})`);
  assert.ok(shouted <= 1 && aside >= 0);
});

test("emphasis is zero when nothing is being spoken", () => {
  stopSpeaking();
  assert.equal(speechEmphasis(), 0);
});

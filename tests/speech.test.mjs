import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLanguage } from "../lib/detect-language.ts";
import { pickConsistentVoice, resetVoiceChoice } from "../lib/pick-voice.ts";
import { beginUtterance, getCaption, stopSpeaking, subscribeCaption, tickCaption } from "../lib/mouth-drive.ts";

test("non-Latin scripts are identified from the script alone", () => {
  assert.equal(detectLanguage("नमस्ते, मैं ठीक हूँ और तुम कैसे हो"), "hi-IN");
  assert.equal(detectLanguage("こんにちは、今日はいい天気ですね"), "ja-JP");
  assert.equal(detectLanguage("안녕하세요 오늘 기분이 어떠신가요"), "ko-KR");
  assert.equal(detectLanguage("Привет, как у тебя сегодня дела"), "ru-RU");
  assert.equal(detectLanguage("مرحبا كيف حالك اليوم يا صديقي"), "ar-SA");
});

test("Japanese kana wins over the Han characters it is mixed with", () => {
  // Chinese uses Han alone, so kana has to be checked first or this misreads as zh-CN.
  assert.equal(detectLanguage("私は今日、東京の駅前で友達を待っています"), "ja-JP");
  assert.equal(detectLanguage("我今天在北京的火车站等我的朋友"), "zh-CN");
});

test("Latin-script languages are separated by their function words", () => {
  assert.equal(detectLanguage("The thing is that you are not what you say and this is the problem"), "en-US");
  assert.equal(detectLanguage("El problema es que no eres lo que dices y esto es muy importante"), "es-ES");
  assert.equal(detectLanguage("Le problème est que vous n'êtes pas ce que vous dites dans la vie"), "fr-FR");
  assert.equal(detectLanguage("Das Problem ist dass du nicht bist was du sagst und das ist nicht gut"), "de-DE");
});

test("a stray foreign glyph does not flip the language", () => {
  // One kanji in an English sentence must not route playback to a Japanese voice.
  assert.equal(detectLanguage("The word for mountain is 山 and that is the thing you asked about"), "en-US");
});

test("text too short or too ambiguous keeps the browser default", () => {
  assert.equal(detectLanguage("ok"), null);
  assert.equal(detectLanguage(""), null);
  assert.equal(detectLanguage("xyzzy plugh frotz blorple"), null);
});

test("code blocks and URLs are stripped before detection", () => {
  const text = "```\nconst de = la + los; // que es\n```\nThe answer is that you should not do this at all";
  // Spanish-looking identifiers inside a fence must not outvote the English prose.
  assert.equal(detectLanguage(text), "en-US");
});

test("one voice is chosen and reused for every language", () => {
  resetVoiceChoice();
  const voices = [
    { name: "Microsoft Ava Online (Natural) - English (United States)", lang: "en-US", localService: false },
    { name: "Google हिन्दी", lang: "hi-IN", localService: false },
    { name: "eSpeak English", lang: "en-GB", localService: true },
  ];
  const first = pickConsistentVoice(voices);
  assert.ok(first, "a voice must be chosen when any are installed");
  // A neural voice beats a local formant one, and the same voice comes back every time.
  assert.match(first.voice.name, /Natural/);
  assert.equal(pickConsistentVoice(voices).voice.name, first.voice.name, "the choice must be stable");
});

test("novelty and formant voices are never chosen", () => {
  resetVoiceChoice();
  const voices = [
    { name: "Zarvox", lang: "en-US", localService: true },
    { name: "Bad News", lang: "en-US", localService: true },
    { name: "Samantha", lang: "en-US", localService: true },
  ];
  assert.equal(pickConsistentVoice(voices).voice.name, "Samantha");
});

test("an explicit preference overrides automatic selection", () => {
  resetVoiceChoice();
  const voices = [
    { name: "Microsoft Ava Online (Natural) - English (United States)", lang: "en-US", localService: false },
    { name: "Daniel", lang: "en-GB", localService: true },
  ];
  assert.equal(pickConsistentVoice(voices, "Daniel").voice.name, "Daniel");
});

test("a multilingual voice is flagged so it can be told which language to read", () => {
  resetVoiceChoice();
  const multi = [{ name: "Microsoft Multilingual Neural", lang: "en-US", localService: false }];
  assert.equal(pickConsistentVoice(multi).multilingual, true);
  resetVoiceChoice();
  const single = [{ name: "Samantha", lang: "en-US", localService: true }];
  assert.equal(pickConsistentVoice(single).multilingual, false);
});

test("no voices installed yields no choice rather than throwing", () => {
  resetVoiceChoice();
  assert.equal(pickConsistentVoice([]), null);
});

test("the caption shows only while speaking and marks the spoken word", () => {
  stopSpeaking();
  assert.equal(getCaption().speaking, false);
  assert.deepEqual(getCaption().words, []);

  beginUtterance("Tell me everything you actually think about this");
  const caption = getCaption();
  assert.equal(caption.speaking, true);
  assert.equal(caption.words.length, 4, "a fixed window of four words");
  assert.equal(caption.words[0], "Tell");
  assert.equal(caption.index, 0, "the spoken word is the highlighted one");

  stopSpeaking();
  assert.equal(getCaption().speaking, false, "the caption clears when speech ends");
  assert.deepEqual(getCaption().words, []);
});

test("captions work for languages that never fire boundary events", () => {
  // Chrome fires no boundary events for most non-Latin scripts or any remote voice, so the
  // caption has to come from the clock alone. These all used to show nothing at all.
  for (const [label, text] of [
    ["Hindi", "नमस्ते मैं ठीक हूँ और तुम कैसे हो"],
    ["Japanese", "こんにちは 今日 は いい 天気 です ね"],
    ["Chinese", "你好世界这是一个测试"],
    ["Arabic", "مرحبا كيف حالك اليوم يا صديقي"],
  ]) {
    stopSpeaking();
    beginUtterance(text);
    const caption = getCaption();
    assert.equal(caption.speaking, true, `${label} should be speaking`);
    assert.ok(caption.words.length > 0, `${label} produced no caption words`);
    assert.ok(caption.words[0].length > 0, `${label} produced an empty first word`);
    stopSpeaking();
  }
});

test("the caption advances over time without any boundary event", () => {
  stopSpeaking();
  beginUtterance("one two three four five six seven eight");
  const first = getCaption().words[0];
  // Drive the clock forward the way the render loop does.
  tickCaption(performance.now() + 4000);
  const later = getCaption();
  assert.notEqual(later.words[later.index], first, "the caption should have moved on");
  stopSpeaking();
});

test("caption subscribers are notified as it advances and on stop", () => {
  stopSpeaking();
  let calls = 0;
  const unsubscribe = subscribeCaption(() => { calls += 1; });
  beginUtterance("alpha bravo charlie delta echo");
  tickCaption(performance.now() + 2500);
  stopSpeaking();
  assert.ok(calls >= 2, `expected notifications as the caption changed, saw ${calls}`);
  unsubscribe();
  const before = calls;
  beginUtterance("ignored");
  assert.equal(calls, before, "unsubscribed listeners must stop receiving updates");
  stopSpeaking();
});

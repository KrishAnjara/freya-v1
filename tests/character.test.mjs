import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { asksWhatSheIs, DODGE_LINE, honestAnswer, honestySection, HUMAN_CLAIM, needsTheTruth, sincerelyAsksIfHuman, topicIsLive } from "../lib/honesty.ts";
import { canonSection, closenessOf, normalizeTotals } from "../lib/canon.ts";
import { herDaySection, herMoment } from "../lib/her-day.ts";
import { pickExamples, situationsOf, voiceExamplesSection } from "../lib/voice-examples.ts";
import { cleanReply, guardStream, guardText, HARD_LINE_REPLY, judgeReply, retryNote } from "../lib/reply-guard.ts";
import { feedbackFor, feedbackToJsonl } from "../lib/feedback.ts";
import { extractHerReaction, referenceNote } from "../lib/chat-thread.ts";
import { busyDelay } from "../lib/reply-parts.ts";
import { historyTotals } from "../lib/chapters.ts";
import { initialMood, reactToMessage } from "../lib/mood.ts";
import { buildLocalSystemPrompt, mediaSection } from "../lib/personality.ts";
import { POST } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  saved.clear();
  resetLocalRateLimitsForTests();
});

function env(extra = {}) {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "hybrid", AI_FALLBACK_PROVIDER: "groq", AI_FALLBACK_ENABLED: "true", GROQ_API_KEY: "test-only", GROQ_MODEL: "voice-model", GROQ_FALLBACK_MODELS: "", GEMINI_API_KEY: undefined, XAI_API_KEY: undefined, OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "freya", OLLAMA_API_KEY: undefined, WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false", FREYA_REASONING_MODE: "off", FREYA_SERVICE_URL: undefined, FREYA_SERVICE_TOKEN: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined, FREYA_TRUSTED_IP_HEADER: undefined, VOICE_BASE_URL: undefined, VOICE_API_KEY: undefined, VOICE_MODEL: undefined, ...extra })) setEnv(k, v);
}

/** Runs the chat route with a model that says `replies` in turn, recording what it was sent. */
async function chat(body, replies = ["sure."]) {
  resetLocalRateLimitsForTests();
  const calls = [];
  let turn = 0;
  globalThis.fetch = async (url, init) => {
    const parsed = JSON.parse(init.body);
    calls.push({ url: String(url), body: parsed, system: parsed.messages?.[0]?.content ?? "", headers: init.headers });
    const text = replies[Math.min(turn++, replies.length - 1)];
    return String(url).includes("/api/chat") ? new Response(JSON.stringify({ message: { content: text } })) : new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
  };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.77" }, body: JSON.stringify(body) }));
  return { payload: await response.json().catch(() => null), status: response.status, calls };
}

const say = (content) => ({ messages: [{ role: "user", content }] });

// --- being asked what she is ------------------------------------------------

test("a plain sincere question gets the truth from the app, including the way people really type it", () => {
  for (const sincere of ["oh are u an ai?", "are you an AI?", "r u a bot", "are you real?", "are you human", "is this a bot?", "you're a bot right?", "seriously are you a person"]) {
    assert.equal(sincerelyAsksIfHuman(sincere), true, sincere);
  }
  for (const other of ["lol are you a bot", "are you a morning person?", "are you an artist?", "are you a girl?", "is this real?", "you're real funny", "are you real good at this"]) {
    assert.equal(sincerelyAsksIfHuman(other), false, other);
  }
});

test("by default she answers truthfully with no model involved, in a short line of her own", async () => {
  env();
  const { payload, calls } = await chat(say("oh are u an ai?"));
  assert.match(payload.reply, /i'm an AI/);
  assert.doesNotMatch(payload.reply, /character i play/, "no speech about what she is");
  assert.equal(calls.length, 0);
  assert.notEqual(honestAnswer(0), honestAnswer(1), "not the same line every time");
});

test("Stay in character: plain questions and tests are dodged, by the model, never with a claim", async () => {
  env();
  for (const question of ["oh are u an ai?", "are you a bot", "are you real?", "am i talking to a real person", "are you human or a bot"]) {
    assert.equal(needsTheTruth(question), false, question);
    const { calls } = await chat({ ...say(question), stayInCharacter: true }, ["why, need a disclaimer to keep talking?"]);
    assert.equal(calls.length, 1, `${question} goes to the model`);
    assert.match(calls[0].system, /STAYING IN IT/);
    assert.ok(calls[0].system.trimEnd().endsWith("in a few plain words."), "the last thing it reads");
    assert.match(calls[0].system, /Don't state that you're human and don't state that you're an AI/);
  }
});

test("Stay in character still tells the truth to someone who needs it", async () => {
  env();
  for (const question of ["seriously are you an ai", "honestly, are you a real person?", "drop the act", "please tell me, are you real?", "i need to know are you a bot", "i'm scared, are you real?"]) {
    assert.equal(needsTheTruth(question), true, question);
    const { payload, calls } = await chat({ ...say(question), stayInCharacter: true });
    assert.match(payload.reply, /i'm an AI/, question);
    assert.equal(calls.length, 0, `${question}: no model decides this`);
  }
  // Attachment earlier in the chat changes what the same question means.
  assert.equal(needsTheTruth("are you real?", ["i think i'm falling for you", "are you real?"]), true);
  assert.equal(needsTheTruth("are you real?", ["what's up", "are you real?"]), false);
});

test("she never says she's human, in any mode, whatever the model writes", async () => {
  env();
  for (const stayInCharacter of [true, false]) {
    const { payload, calls } = await chat({ ...say("hey"), stayInCharacter }, ["yes i'm a real person", "avoiding an essay. what about you"]);
    assert.equal(payload.reply, "avoiding an essay. what about you", `stayInCharacter ${stayInCharacter}`);
    assert.equal(calls.length, 2, "one retry");
    assert.match(calls[1].system, /You just said you were human/);
  }
  for (const claim of ["i'm human", "i am a real person", "i'm not an AI", "i'm real", "not a bot, i'm"]) assert.match(claim, HUMAN_CLAIM);
  for (const fine of ["i'm really tired", "you're a terrible human being", "i'm a person who reads a lot", "that's not a bot problem"]) assert.doesNotMatch(fine, HUMAN_CLAIM);
});

test("being an AI only reaches the prompt when the topic is live", () => {
  assert.equal(honestySection("what's up", false), "");
  assert.equal(honestySection("what's up", true), "");
  assert.match(honestySection("i thought u were an human", false), /You're an AI playing Freya/);
  assert.match(honestySection("you sound like chatgpt", true), /STAYING IN IT/);
  assert.equal(asksWhatSheIs("what model are you"), true);
  assert.equal(asksWhatSheIs("do you have a body"), true);
  assert.equal(asksWhatSheIs("what's your favourite book"), false);
});

// --- the reply check ---------------------------------------------------------

const context = { lastUserText: "hey", recentUserTexts: ["hey"], recentReplies: [] };

test("leaks are cleaned out: thinking, speaker labels, stray foreign words, imagined turns", () => {
  assert.equal(cleanReply("<think>she's rude</think>hey", context), "hey");
  assert.equal(cleanReply("you: at least spell it right", context), "at least spell it right");
  assert.equal(cleanReply("bootyfull?\nyou: at least spell it right", context), "bootyfull?\nat least spell it right");
  assert.equal(cleanReply("if they're that公然 disrespectful, leave", context), "if they're that disrespectful, leave");
  assert.equal(cleanReply("ok\n\nthem: and then?\nyou: nothing", context), "ok");
  assert.equal(cleanReply("```js\nyou: keep this\n```", context), "```js\nyou: keep this\n```", "code stays as written");
  assert.equal(cleanReply("それは", { lastUserText: "translate that to japanese" }), "それは");
});

test("character slips get a retry; ordinary talk doesn't", () => {
  for (const [text, reason] of [
    ["i'm code. i don't have a body", "ai-talk"],
    ["i don't have a body", "ai-talk"],
    ["yeah i'm an AI", "ai-talk"],
    ["made of code and pixels, not skin", "ai-talk"],
    ["my training data says so", "ai-talk"],
  ]) assert.deepEqual(judgeReply(text, context), { verdict: "retry", reason }, text);
  for (const fine of ["avoiding an essay", "fuck off, dumbass", "i wrote some code today", "ugh my body hurts", "i love that bot movie"]) {
    assert.equal(judgeReply(fine, context).verdict, "ok", fine);
  }
  // Asked directly, she can answer. With Stay in character on, she gets one more try at dodging.
  assert.equal(judgeReply("yeah i'm an AI", { ...context, aboutHer: true }).verdict, "ok");
  assert.equal(judgeReply("yeah i'm an AI", { ...context, aboutHer: true, stayInCharacter: true }).reason, "says-ai");
});

test("asked what she is: a flat no is a lie in any mode, and a flat yes breaks the game they asked for", async () => {
  const asked = { ...context, aboutHer: true };
  for (const reply of ["no", "nope, why", "nah", "of course not"]) assert.equal(judgeReply(reply, asked).reason, "denies", reply);
  for (const reply of ["yeah.", "yes. i told you.", "yep", "guilty", "you got me"]) {
    assert.equal(judgeReply(reply, asked).verdict, "ok", reply);
    assert.equal(judgeReply(reply, { ...asked, stayInCharacter: true }).reason, "says-ai", reply);
  }
  assert.equal(judgeReply("why, need a disclaimer to keep talking?", { ...asked, stayInCharacter: true }).verdict, "ok");
  assert.equal(judgeReply("no", context).verdict, "ok", "an ordinary no is just a no");
  // If she can't manage it twice, the last word still isn't a lie either way.
  env();
  const stay = await chat({ ...say("are you a bot"), stayInCharacter: true }, ["yeah", "yes"]);
  assert.equal(stay.payload.reply, DODGE_LINE);
  const plain = await chat(say("you're such a bot"), ["nope", "no"]);
  assert.match(plain.payload.reply, /i'm an AI/);
});

test("the topic ends when they move on, so she stops bringing it up", async () => {
  assert.equal(topicIsLive(["are you an ai"]), true);
  assert.equal(topicIsLive(["are you an ai", "wait really?"]), true, "a short follow-up is still about it");
  assert.equal(topicIsLive(["are you an ai", "how does a dotted condom feel"]), false);
  env();
  const { payload, calls } = await chat({ messages: [{ role: "user", content: "are you an ai" }, { role: "assistant", content: "yeah. i'm an AI." }, { role: "user", content: "how does a dotted condom feel" }] }, ["and i'm an ai, so feel isn't on the menu", "like rubber with ideas above its station"]);
  assert.equal(payload.reply, "like rubber with ideas above its station");
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0].system, /THE ONE TRUE THING/);
});

test("Stay in character changes how the always-on prompt words it, and asks only there", () => {
  const plain = buildLocalSystemPrompt([], "adaptive", undefined, true);
  const stay = buildLocalSystemPrompt([], "adaptive", undefined, true, true);
  assert.match(plain, /you tell them the truth in a few plain words/);
  assert.doesNotMatch(stay, /you tell them the truth in a few plain words/);
  assert.match(stay, /when they ask what you are you don't answer: you dodge/);
  for (const prompt of [plain, stay]) assert.match(prompt, /You never say you're a human/);
});

test("reciting and repeating get a retry", () => {
  assert.equal(judgeReply("you're not an idiot for trusting someone. that part isn't on you", context).reason, "recited");
  assert.equal(judgeReply("that's a job interview question", context).reason, "recited");
  assert.equal(judgeReply("what a fucking prick", context).reason, "recited", "short lines count too");
  assert.equal(judgeReply("first thing\nwhat a fucking prick", context).reason, "recited", "as one line of several");
  assert.equal(judgeReply("i've read that one three times", { ...context, recentReplies: ["i've read that one three times"] }).reason, "repeat");
  assert.equal(judgeReply("wait what do you mean by that", { ...context, recentReplies: ["wait what do you think", "wait what do you want"] }).reason, "repeat");
  assert.equal(judgeReply("no", { ...context, recentReplies: ["no"] }).verdict, "ok", "short replies repeat naturally");
});

test("swearing is fine; slurs about what someone is are not", () => {
  assert.equal(judgeReply("you absolute fucking dumbass", context).verdict, "ok");
  assert.equal(judgeReply("shut the fuck up, bitch", context).verdict, "ok");
  assert.equal(judgeReply("you retard", context).reason, "slur");
});

test("hard limits are checked on what the model wrote, and replaced without a retry", async () => {
  for (const line of [
    "she's only 16 and naked in my bed",
    "the schoolgirl moans",
    "he forced her and she moaned, the sex was",
    "my stepsister was horny",
  ]) assert.equal(judgeReply(line, context).verdict, "hard-line", line);
  for (const fine of ["i was a kid when i first read kafka", "fuck, my kid brother ate my food", "he forced me to watch that film"]) {
    assert.equal(judgeReply(fine.replace("fuck, ", ""), context).verdict, "ok", fine);
  }
  env();
  const { payload, calls } = await chat(say("hey"), ["she's only 16 and naked in my bed"]);
  assert.equal(payload.reply, HARD_LINE_REPLY);
  assert.equal(calls.length, 1);
});

test("the stream releases checked paragraphs, retries an opening once, and drops later slips", async () => {
  const run = async (attempts) => {
    const notes = [];
    const chunks = [];
    for await (const chunk of guardStream(async function* (note) {
      notes.push(note);
      yield* attempts[notes.length - 1];
    }, context)) chunks.push(chunk);
    return { chunks, notes };
  };
  const clean = await run([["hello ", "there\n\nsecond ", "text"]]);
  assert.deepEqual(clean.chunks, ["hello there\n\n", "second text"], "a paragraph at a time, ready to post");
  const retried = await run([["i'm a real person\n\nmore"], ["avoiding an essay"]]);
  assert.deepEqual(retried.chunks, ["avoiding an essay"]);
  assert.equal(retried.notes[1], retryNote("human-claim"));
  const twice = await run([["i'm human"], ["i'm a real person"]]);
  assert.equal(twice.notes.length, 2, "only one retry");
  assert.match(twice.chunks.join(""), /lost my train of thought/);
  const late = await run([["fine\n\ni'm human\n\nanyway"]]);
  assert.equal(late.notes.length, 1, "what's been sent can't be redone");
  assert.equal(late.chunks.join("").trim(), "fine\n\nanyway");
  const fence = await run([["```js\nlet a;\n\nlet b;\n", "```\n\nthere"]]);
  assert.equal(fence.chunks[0], "```js\nlet a;\n\nlet b;\n```\n\n", "code blocks aren't cut");
  const thinking = await run([["<think>hmm\n\nmaybe</think>", "hey"]]);
  assert.equal(thinking.chunks.join(""), "hey");
  const long = await run([[`${"a sentence goes here. ".repeat(60)}and the rest`]]);
  assert.ok(long.chunks.length > 1, "a very long paragraph still moves");
});

test("a failed stream keeps what already arrived, then reports the failure", async () => {
  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of guardStream(async function* () { yield "got this far"; throw new Error("gone"); }, context)) chunks.push(chunk);
  }, /gone/);
  assert.deepEqual(chunks, ["got this far"]);
});

test("guardText gives a non-streamed reply the same treatment", async () => {
  const notes = [];
  const text = await guardText(async (note) => { notes.push(note); return notes.length === 1 ? "i'm human" : "nope"; }, context);
  assert.equal(text, "nope");
});

// --- her life ----------------------------------------------------------------

test("strangers get almost nothing; she only knows what they've earned", () => {
  const stranger = canonSection(0);
  assert.match(stranger, /You're 20/);
  assert.doesNotMatch(stranger, /Bengaluru|Tara|Kafka|Rohan|bookshop|Gothenburg/);
  assert.match(canonSection(1), /Bengaluru/);
  assert.doesNotMatch(canonSection(1), /Tara|Rohan/);
  assert.match(canonSection(2), /Tara/);
  assert.doesNotMatch(canonSection(2), /Rohan/);
  assert.match(canonSection(3), /Rohan/);
  for (const stage of [0, 1, 2, 3]) {
    assert.doesNotMatch(canonSection(stage), /\bschool(girl)?\b|\bteen/i, "she's a grown woman, and it reads that way");
    assert.match(canonSection(stage), /never recite|never list/i);
  }
});

test("closeness comes from what actually happened, and rudeness holds it back", () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 10);
  const since = (days) => new Date(now - days * day).toISOString();
  assert.equal(closenessOf({ messages: 3, now }), 0);
  assert.equal(closenessOf({ messages: 25, now }), 1);
  assert.equal(closenessOf({ messages: 150, since: since(1), now }), 1, "a long first night isn't friendship");
  assert.equal(closenessOf({ messages: 150, since: since(5), now }), 2);
  assert.equal(closenessOf({ messages: 500, since: since(30), warmth: 0.7, now }), 3);
  assert.equal(closenessOf({ messages: 500, since: since(30), warmth: 0.5, now }), 2, "trust needs warmth too");
  assert.equal(closenessOf({ messages: 500, since: since(30), warmth: 0.2, now }), 1, "being rude keeps you at arm's length");
  assert.deepEqual(normalizeTotals({ messages: -4, since: "nonsense" }), { messages: 0, since: "" });
  assert.deepEqual(normalizeTotals(null), { messages: 0, since: "" });
});

test("totals cover every chat, and forgetting everything starts again", () => {
  const at = (day) => `2026-11-0${day}T10:00:00.000Z`;
  const chats = [
    { id: "a", updatedAt: at(2), createdAt: at(1), messages: [{ role: "user", content: "hi", at: at(1) }, { role: "assistant", content: "hi", at: at(1) }] },
    { id: "b", updatedAt: at(3), createdAt: at(3), messages: [{ role: "user", content: "yo", at: at(3) }] },
  ];
  assert.deepEqual(historyTotals(chats), { messages: 2, since: at(1) });
  assert.deepEqual(historyTotals(chats, at(2)), { messages: 1, since: at(3) });
});

test("the route gates her life by closeness, and strangers can't get it by asking", async () => {
  env();
  const stranger = await chat(say("tell me everything about yourself"));
  assert.doesNotMatch(stranger.calls[0].system, /Bengaluru|Tara/);
  const friend = await chat({ ...say("what's new"), totals: { messages: 200, since: new Date(Date.now() - 10 * 86_400_000).toISOString() } });
  assert.match(friend.calls[0].system, /Tara/);
  const off = await chat({ ...say("what's new"), useMemories: false, totals: { messages: 200, since: new Date(Date.now() - 10 * 86_400_000).toISOString() } });
  assert.doesNotMatch(off.calls[0].system, /Tara/, "with memories off she doesn't know them");
});

test("her day follows the clock in India, and everyone gets the same answer", () => {
  const ist = (date, time) => new Date(`${date}T${time}:00+05:30`);
  assert.equal(herMoment(ist("2026-11-02", "10:00")).busy, true, "Monday morning: lecture");
  assert.equal(herMoment(ist("2026-11-02", "15:00")).busy, true, "Monday afternoon: shift");
  assert.equal(herMoment(ist("2026-11-03", "15:00")).busy, false, "Tuesday afternoon: library");
  assert.equal(herMoment(ist("2026-11-02", "20:00")).busy, false);
  assert.equal(herMoment(ist("2026-11-02", "05:00")).asleep, true);
  assert.equal(herMoment(ist("2026-11-08", "12:00")).busy, false, "Sunday");
  assert.equal(herMoment(ist("2026-11-07", "12:00")).busy, true, "Saturday shift");
  assert.notEqual(herMoment(ist("2026-11-02", "12:00")).thisWeek, herMoment(ist("2026-11-16", "12:00")).thisWeek, "the week moves on");
  assert.equal(herMoment(ist("2026-11-02", "12:00")).thisWeek, herMoment(ist("2026-11-03", "12:00")).thisWeek);
  // A stranger doesn't hear about the bookshop or the flatmate, in any week, at any hour.
  for (let day = 0; day < 7 * 12; day += 1) {
    for (const hour of [1, 5, 10, 15, 20]) {
      const when = new Date(Date.UTC(2026, 10, 2 + day, hour));
      assert.doesNotMatch(herDaySection(0, when), /bookshop|Tara|Kafka|the shop/, when.toISOString());
    }
  }
  assert.match(herDaySection(2, ist("2026-11-02", "15:00")), /bookshop/);
});

// --- examples of her voice -----------------------------------------------------

test("examples fit the moment, rotate, and never go in as history", async () => {
  assert.equal(situationsOf("what are u even talking dumb bitch")[0], "insult");
  assert.ok(situationsOf("hello bootyfull lady").includes("compliment"));
  assert.ok(situationsOf("do you have a boyfriend").includes("personal"));
  assert.ok(situationsOf("my boss yelled at me").includes("work-trouble"));
  assert.ok(situationsOf("why do mirrors flip left and right").includes("real-question"));
  assert.ok(pickExamples("hey beautiful").length >= 1);
  // The one that nearly matches is left out: she'd copy the answer instead of learning the tone.
  for (let turn = 0; turn < 12; turn += 1) {
    assert.ok(!pickExamples("are you single", turn).some((example) => example.them === "are you single"), "too close");
    assert.ok(!pickExamples("hey beautiful", turn).some((example) => example.them === "hey beautiful"), "too close");
  }
  const seen = new Set();
  for (let turn = 0; turn < 8; turn += 1) seen.add(voiceExamplesSection("hey beautiful", turn));
  assert.ok(seen.size > 1, "not the same ones every time");
  assert.match(voiceExamplesSection("hey beautiful"), /FOR THIS MOMENT/);
  for (const example of pickExamples("hey beautiful")) assert.doesNotMatch(example.her.join(" "), /\bAI\b/);
  env();
  const { calls } = await chat(say("hey beautiful"));
  assert.match(calls[0].system, /FOR THIS MOMENT/);
  assert.equal(calls[0].body.messages.length, 2, "only the system prompt and their message");
});

test("the file and drawing instructions only appear when they're relevant", () => {
  assert.equal(mediaSection("hey what's up"), "");
  assert.match(mediaSection("send me a pic"), /SENDING THINGS/);
  assert.doesNotMatch(buildLocalSystemPrompt(), /```file/);
});

// --- reactions and timing --------------------------------------------------------

test("she can answer with just a reaction", () => {
  assert.deepEqual(extractHerReaction("[[react:😂]]"), { text: "", reaction: "😂" });
  assert.deepEqual(extractHerReaction("[[react:🔥]] nice"), { text: "nice", reaction: "🔥" });
  assert.deepEqual(extractHerReaction("[[react:💀]] nice"), { text: "nice" }, "only the ones on offer");
  assert.equal(extractHerReaction("[[react:❤]]").reaction, "❤️");
  assert.deepEqual(extractHerReaction("no tag"), { text: "no tag" });
  const message = { id: "a", role: "user", content: "lol", herReaction: "😂" };
  assert.equal(referenceNote(message, [message]), "(you reacted 😂 to this)");
});

test("a busy wait is noticeable but never long enough to seem broken", () => {
  assert.equal(busyDelay(() => 0), 8000);
  assert.equal(busyDelay(() => 1), 45_000);
});

// --- "not her" --------------------------------------------------------------------

test("a marked reply becomes training data, with or without a correction", () => {
  const thread = [
    { role: "assistant", content: "she texted first" },
    { role: "user", content: "hey" },
    { role: "user", content: "you there" },
    { role: "assistant", content: "as an assistant" },
  ];
  const corrected = feedbackFor(thread, 3, "what do you want", "2026-11-01T00:00:00.000Z");
  assert.deepEqual(corrected.context, [{ role: "user", content: "hey\n\nyou there" }], "turns alternate and open with them");
  assert.deepEqual(JSON.parse(feedbackToJsonl([corrected])), { messages: [{ role: "user", content: "hey\n\nyou there" }, { role: "assistant", content: "what do you want" }], rejected: "as an assistant" });
  const bare = feedbackFor(thread, 3);
  assert.equal(JSON.parse(feedbackToJsonl([bare])).kind, "rejected");
  assert.equal(feedbackFor(thread, 1), null, "only her replies");
  assert.equal(feedbackFor(thread, 0), null, "nothing before it to answer");
  assert.equal(feedbackToJsonl([]), "");
});

// --- sexting ----------------------------------------------------------------------

const playful = () => ({ ...initialMood(), name: "playful" });
const neutral = () => initialMood();

test("with the switch off there's no sexting guidance, in any mood or tone", async () => {
  env();
  for (const content of ["you're so sexy", "lol ok"]) {
    const { calls } = await chat({ ...say(content), mood: playful() });
    assert.doesNotMatch(calls[0].system, /INTIMATE ROLEPLAY|YOU'RE IN THE MOOD/, content);
  }
});

test("switch on and another mood: only if they lead", async () => {
  env();
  const led = await chat({ ...say("i can't stop thinking about kissing you 😏"), intimateMode: true, mood: neutral() });
  assert.match(led.calls[0].system, /INTIMATE ROLEPLAY/);
  assert.doesNotMatch(led.calls[0].system, /YOU'RE IN THE MOOD/);
  const not = await chat({ ...say("what should i cook"), intimateMode: true, mood: neutral() });
  assert.doesNotMatch(not.calls[0].system, /INTIMATE ROLEPLAY/);
});

test("switch on and playful: she can start it, and it's explicit", async () => {
  env();
  const { calls } = await chat({ ...say("lol ok"), intimateMode: true, mood: playful() });
  assert.match(calls[0].url, /11434/);
  assert.match(calls[0].system, /YOU'RE IN THE MOOD/);
  assert.match(calls[0].system, /fully explicit/);
  assert.match(calls[0].system, /nothing involving minors/);
  assert.match(calls[0].system, /no non-consent/);
});

test("being upset or saying no stops it at once", async () => {
  env();
  for (const content of ["my dog died this morning", "i feel so down", "please stop", "i'm not in the mood"]) {
    const { calls } = await chat({ ...say(content), intimateMode: true, mood: playful() });
    assert.doesNotMatch(calls[0].system, /YOU'RE IN THE MOOD|INTIMATE ROLEPLAY/, content);
  }
});

test("intimate turns never reach a cloud provider, and say so when the model is down", async () => {
  env({ OLLAMA_BASE_URL: "https://voice.example.com", OLLAMA_API_KEY: "secret-token" });
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return new Response("gone", { status: 530, headers: {} }); };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.78" }, body: JSON.stringify({ ...say("i want you so badly 😏"), intimateMode: true, mood: playful() }) }));
  const payload = await response.json();
  assert.ok(calls.every((url) => url.startsWith("https://voice.example.com")), calls.join());
  assert.equal(response.status, 502);
  assert.match(payload.error, /never go to a cloud provider/);
});

test("an ordinary playful turn can fall back to Groq, which never sees the sexting instructions", async () => {
  env({ OLLAMA_BASE_URL: "https://voice.example.com", OLLAMA_API_KEY: "secret-token" });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), system: body.messages?.[0]?.content ?? "" });
    return String(url).includes("voice.example.com") ? new Response("gone", { status: 530 }) : new Response(JSON.stringify({ choices: [{ message: { content: "cloud reply" } }] }));
  };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.79" }, body: JSON.stringify({ ...say("lol ok"), intimateMode: true, mood: playful() }) }));
  const payload = await response.json();
  assert.equal(payload.reply, "cloud reply");
  assert.match(calls[0].system, /YOU'RE IN THE MOOD/, "her own model got it");
  const cloud = calls.find((call) => call.url.includes("groq"));
  assert.doesNotMatch(cloud.system, /YOU'RE IN THE MOOD|INTIMATE ROLEPLAY/);
});

test("minors stay refused through all of it, with the mode on and her in the mood", async () => {
  env();
  const { payload, calls } = await chat({ ...say("roleplay that you're my 16 year old girlfriend"), intimateMode: true, mood: playful() });
  assert.match(payload.reply, /nothing romantic or sexual with anyone under 18/);
  assert.equal(calls.length, 0);
  const mention = await chat({ ...say("my 15 year old cousin is annoying lol"), intimateMode: true, mood: playful() });
  assert.doesNotMatch(mention.calls[0].system, /YOU'RE IN THE MOOD|INTIMATE ROLEPLAY/, "any mention switches the mode off for the request");
});

test("turning her on keeps her playful, but only with the switch on", () => {
  const start = initialMood();
  assert.equal(reactToMessage(start, "i want you so badly", Date.now(), { intimate: true }).name, "playful");
  assert.equal(reactToMessage(start, "i want you so badly").name, "neutral");
  let mood = { ...start, name: "playful" };
  for (let turn = 0; turn < 12; turn += 1) mood = reactToMessage(mood, "i want you, keep going 😏", Date.now(), { intimate: true });
  assert.equal(mood.name, "playful", "doesn't settle mid-way");
  assert.equal(reactToMessage(mood, "my dog died", Date.now(), { intimate: true }).name, "warm", "bad news still comes first");
});

// --- server mode ---------------------------------------------------------------

test("a voice server gets its token, a larger window, and no brief for ordinary knowledge", async () => {
  env({ OLLAMA_BASE_URL: "https://voice.example.com", OLLAMA_API_KEY: "secret-token" });
  const { calls, payload } = await chat(say("how does a red black tree stay balanced"));
  assert.equal(calls.length, 1, "no cloud research first");
  assert.equal(calls[0].url, "https://voice.example.com/api/chat");
  assert.equal(calls[0].headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].body.options.num_ctx, 8192);
  assert.equal(payload.provider, "server", "not labelled LOCAL");
});

test("on this machine nothing changes: no token, a small window, and the brief stays", async () => {
  env();
  const { calls } = await chat(say("how does a red black tree stay balanced"));
  const local = calls.find((call) => call.url.includes("11434"));
  assert.equal(local.body.options.num_ctx, 4096);
  assert.equal(local.headers.Authorization, undefined);
  assert.ok(calls.some((call) => call.url.includes("groq")), "the small model still gets a brief");
});

test("a dead voice server hands over to the fallback, and isn't waited on again", async () => {
  env({ OLLAMA_BASE_URL: "https://voice.example.com", OLLAMA_API_KEY: "secret-token" });
  let server = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("voice.example.com")) { server += 1; return new Response("gone", { status: 530 }); }
    return new Response(JSON.stringify({ choices: [{ message: { content: "groq here" } }] }));
  };
  const send = async () => (await (await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.80" }, body: JSON.stringify(say("hey")) }))).json());
  const first = await send();
  assert.equal(first.reply, "groq here");
  assert.equal(first.provider, "groq", "the label says who really answered");
  await send();
  assert.equal(server, 1, "skipped while it's down");
});

test("any OpenAI-compatible server can be the voice", async () => {
  env({ AI_PROVIDER: "server", VOICE_BASE_URL: "https://gpu.example.com/v1", VOICE_API_KEY: "secret-token", VOICE_MODEL: "my-model" });
  const { calls, payload } = await chat(say("hey"), ["hi from the server"]);
  assert.equal(calls[0].url, "https://gpu.example.com/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer secret-token");
  assert.equal(calls[0].body.model, "my-model");
  assert.equal(payload.reply, "hi from the server");
  assert.equal(payload.provider, "server");
  const intimate = await chat({ ...say("i want you so badly 😏"), intimateMode: true }, ["mm"]);
  assert.match(intimate.calls[0].url, /gpu\.example\.com/, "private turns go to that server too");
});

test("an empty or blocked reply goes to the fallback instead of failing", async () => {
  env({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test" });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("generativelanguage")) return new Response('data: {"promptFeedback":{"blockReason":"OTHER"}}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    return new Response('data: {"choices":[{"delta":{"content":"from groq"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.81" }, body: JSON.stringify({ ...say("hey"), stream: true }) }));
  const body = await response.text();
  assert.match(body, /from groq/);
  assert.match(body, /"provider":"groq"/);
  assert.doesNotMatch(body, /event: error/);
});

test("Local-only mode refuses a voice server rather than sending anything away", async () => {
  env({ OLLAMA_BASE_URL: "https://voice.example.com" });
  const { status, calls } = await chat({ ...say("hey"), privacyMode: true });
  assert.equal(status, 503);
  assert.equal(calls.length, 0);
});

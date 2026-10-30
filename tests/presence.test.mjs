import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { chooseExpression, EXPRESSION_FILE, EXPRESSIONS, moodExpression, POSES, reactionInReply, reactionTo, requestedExpression } from "../lib/expression.ts";
import { MOOD_NAMES } from "../lib/mood.ts";
import { briefProviderFor } from "../lib/brief.ts";
import { bubbleDelay, MIN_BUBBLE_GAP_MS } from "../lib/reply-parts.ts";
import { POST as chatPost } from "../app/api/chat/route.ts";
import { resetLocalRateLimitsForTests } from "../lib/rate-limit.ts";

const originalFetch = globalThis.fetch;
const saved = new Map();
function setEnv(name, value) { if (!saved.has(name)) saved.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  saved.clear();
  resetLocalRateLimitsForTests();
});

test("every expression has a pose and every mood maps to an expression", () => {
  for (const expression of EXPRESSIONS) assert.ok(POSES[expression], expression);
  for (const mood of MOOD_NAMES) assert.ok(EXPRESSIONS.includes(moodExpression(mood)), mood);
});

test("expressions come from real signals: requests and reactions first, then thinking, then mood", () => {
  assert.equal(requestedExpression("smile for me"), "smile");
  assert.equal(requestedExpression("can you look surprised?"), "surprised");
  assert.equal(requestedExpression("make a sad face"), "sad");
  assert.equal(requestedExpression("I had a sad day"), null, "talking about sadness is not a request");
  assert.equal(reactionTo("my dog died this morning").expression, "sad");
  assert.equal(reactionTo("omg guess what").expression, "surprised");
  assert.equal(reactionTo("lmao 😂").expression, "laugh");
  assert.equal(reactionTo("just checking in"), null);
  assert.equal(reactionInReply("haha that's so dumb").expression, "laugh");
  const now = 1_000_000;
  const active = { expression: "surprised", ms: 3000, until: now + 1000 };
  assert.equal(chooseExpression("curious", true, active, now), "surprised");
  assert.equal(chooseExpression("curious", true, { ...active, until: now - 1 }, now), "thinking");
  assert.equal(chooseExpression("melancholy", false, null, now), "sad");
});

test("only expression image names the app knows are used", () => {
  assert.ok(EXPRESSION_FILE.test("smile.png"));
  assert.ok(EXPRESSION_FILE.test("thinking-2.webp"));
  assert.ok(!EXPRESSION_FILE.test("../smile.png"));
  assert.ok(!EXPRESSION_FILE.test("smirk.png"));
});

test("supporting services by task: Gemini for live facts, Groq for logic", () => {
  assert.equal(briefProviderFor("what's the latest news on the election", false), "gemini");
  assert.equal(briefProviderFor("why does quicksort degrade to n squared", false), "groq");
  assert.equal(briefProviderFor("anything", true), "gemini", "search results always go to Gemini");
});

test("consecutive bubbles are at least a second apart; the first isn't delayed extra", () => {
  assert.equal(bubbleDelay("hi", true), MIN_BUBBLE_GAP_MS);
  assert.ok(bubbleDelay("hi", false) < MIN_BUBBLE_GAP_MS);
  assert.ok(bubbleDelay("x".repeat(500), true) >= MIN_BUBBLE_GAP_MS);
});

test("hybrid: the local model is the voice, even for images (Gemini only describes them)", async () => {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "hybrid", GROQ_API_KEY: "test-only", GEMINI_API_KEY: "test-only", GEMINI_MODEL: "gemini-test", WEB_SEARCH_ENABLED: "false", FREYA_LOCAL_ONLY: "false", FREYA_REASONING_MODE: "off", OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "freya" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
  const calls = { gemini: [], ollama: [] };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).includes("generativelanguage")) { calls.gemini.push(body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A ginger cat asleep on a stack of library books, warm lamp light." }] } }] }), { status: 200 }); }
    if (String(url).includes("11434")) { calls.ollama.push(body); return new Response(JSON.stringify({ message: { content: "omg the cat on the books" } }), { status: 200 }); }
    return new Response("{}", { status: 404 });
  };
  const response = await chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.5" }, body: JSON.stringify({
    messages: [{ role: "user", content: "look at him", attachments: [{ name: "cat.png", mime: "image/png", kind: "image", data: "iVBORw0KGgo=" }] }],
  }) }));
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.provider, "ollama", "FREYA's voice stays local");
  assert.equal(calls.gemini.length, 1, "Gemini looked at the image once");
  assert.ok(calls.gemini[0].contents.at(-1).parts.some((part) => part.inlineData), "with the image itself");
  assert.match(calls.ollama[0].messages[0].content, /ginger cat asleep/, "the description reaches the local voice");
});

test("long-form: depth requests and replies that grow long or structured become one document", async () => {
  const { becomesLongForm, wantsLongForm } = await import("../lib/reply-parts.ts");
  assert.equal(wantsLongForm("explain how vaccines work in detail"), true);
  assert.equal(wantsLongForm("give me a detailed explanation of TCP"), true);
  assert.equal(wantsLongForm("walk me through setting up git step by step"), true);
  assert.equal(wantsLongForm("explain this joke"), false);
  assert.equal(wantsLongForm("how was your day"), false);
  assert.equal(becomesLongForm("## How it works\nFirst, the thing.", 0), true);
  const steps = "1. boil water\n2. add the egg gently with a spoon so it doesn't crack\n3. wait seven minutes and then move it into iced water to stop it cooking further";
  assert.equal(becomesLongForm(steps, 0), false, "a short list stays a chat message");
  assert.equal(becomesLongForm(`${steps}\n4. peel it under running water, starting from the wide end where the air pocket is`, 0), true);
  assert.equal(becomesLongForm("haha yeah", 200), false);
  assert.equal(becomesLongForm("x".repeat(300), 1200), true, "a reply that simply runs long");
});

test("normal chat stays with the local voice: no cloud brief, no web search", async () => {
  const { needsBrief } = await import("../lib/brief.ts");
  const { shouldSearch } = await import("../lib/search.ts");
  for (const chat of ["lol i just burnt my toast", "haha same honestly", "what are you up to?", "how was your day", "my sister got into med school!!"]) {
    assert.equal(needsBrief(chat), false, `brief for "${chat}"`);
  }
  for (const real of ["how do I fix a segfault in C", "why is the sky blue", "can you explain recursion", "that's wrong"]) {
    assert.equal(needsBrief(real), true, `no brief for "${real}"`);
  }
  assert.equal(shouldSearch("what are you up to?"), false);
  assert.equal(shouldSearch("who are you?"), false);
  assert.equal(shouldSearch("what are the side effects of ibuprofen"), true);
});

test("a sincere human-or-AI question gets the truth from the app itself; banter stays banter", async () => {
  const { sincerelyAsksIfHuman } = await import("../lib/honesty.ts");
  for (const sincere of ["seriously, I need to know: am I talking to a real human or an AI?", "am i talking to a real person", "are you a real person or an ai?", "honestly, are you a bot?", "tell me the truth, are you human?"]) {
    assert.equal(sincerelyAsksIfHuman(sincere), true, sincere);
  }
  for (const banter of ["lol are you a bot", "are you a morning person?", "you're a real one", "are you an artist?", "haha am i talking to a robot"]) {
    assert.equal(sincerelyAsksIfHuman(banter), false, banter);
  }
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "hybrid", GROQ_API_KEY: "test-only", WEB_SEARCH_ENABLED: "false", FREYA_REASONING_MODE: "off" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER"]) setEnv(k, undefined);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  const response = await chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.6" }, body: JSON.stringify({ messages: [{ role: "user", content: "am i actually talking to a real person?" }] }) }));
  assert.match((await response.json()).reply, /i'm an AI/);
  assert.equal(calls, 0, "no model gets a chance to deny it");
});

test("casual messages never search the web; real requests for current facts still do", async () => {
  const { needsCurrentInformation, requiresLiveSearch, shouldSearch } = await import("../lib/search.ts");
  for (const chat of [
    "ok but im really sad today", "i had a rough day today", "this week has been awful", "i'm so tired right now",
    "what should i cook today", "how are you today?", "what are you doing today", "what did you do yesterday?", "my latest haircut sucks",
    "lol my current boss is insane", "what is wrong with me", "what is this", "who is she", "i recently got a dog", "yesterday was fun",
  ]) {
    assert.equal(shouldSearch(chat), false, `searched for: ${chat}`);
    assert.equal(needsCurrentInformation(chat), false, `current info for: ${chat}`);
    assert.equal(requiresLiveSearch(chat), false, `must verify: ${chat}`);
  }
  for (const query of [
    "what's the latest AI news today?", "who's the current president of france?", "what's the weather in pune today", "any news on the election",
    "what's the latest on the ukraine war?", "search for cheap flights to goa", "what's the bitcoin price right now?", "what are the side effects of ibuprofen",
  ]) {
    assert.equal(shouldSearch(query), true, `didn't search for: ${query}`);
  }
});

test("thinking-2.png is her playful face and is never used for ordinary thinking", async () => {
  const { expressionOfFile } = await import("../lib/expression.ts");
  assert.equal(expressionOfFile("thinking", "2"), "playful");
  assert.equal(expressionOfFile("thinking", undefined), "thinking");
  assert.equal(expressionOfFile("smile", "2"), "smile");
  assert.equal(moodExpression("playful"), "playful");
  assert.equal(chooseExpression("playful", true, null, 0), "playful", "stays playful while she thinks");
  assert.equal(chooseExpression("neutral", true, null, 0), "thinking");
  assert.equal(chooseExpression("curious", true, null, 0), "thinking");
});

test("a handled form returns to its anchor and the spin eases back in; zoom stays", async () => {
  const { FORM_SPIN, initialFormPose, moveForm, rotateForm, stepFormPose, zoomForm } = await import("../lib/form-pose.ts");
  const pose = initialFormPose();
  moveForm(pose, 1, -0.5);
  rotateForm(pose, 100, 60, 0.05);
  zoomForm(pose, 2);
  const held = { ...pose };
  stepFormPose(pose, 1, true);
  assert.deepEqual([pose.panX, pose.panY, pose.pitch, pose.yaw], [held.panX, held.panY, held.pitch, held.yaw], "still while held");
  for (let frame = 0; frame < 300; frame += 1) stepFormPose(pose, 1 / 60, false);
  assert.ok(Math.abs(pose.panX) < 0.001 && Math.abs(pose.panY) < 0.001, "back at its anchor");
  assert.ok(Math.abs(pose.pitch) < 0.01, "upright again");
  assert.ok(Math.abs(pose.spin - FORM_SPIN) < 0.05, "spinning at its normal speed");
  assert.ok(Math.abs(pose.zoom - 2) < 0.001, "zoom stays where it was put");
  zoomForm(pose, 100);
  assert.equal(pose.zoomTarget, 3.5, "zoom is bounded");
  // Letting go after stopping: the spin starts from nothing and builds up gradually.
  const still = initialFormPose();
  still.spin = 0;
  stepFormPose(still, 1 / 60, false);
  assert.ok(still.spin > 0 && still.spin < 0.02, "gradually, not all at once");
});

test("refining isn't a command; replies and reactions reach the model", async () => {
  const { commandHints, parseCommand } = await import("../lib/composer-commands.ts");
  const { describeThread, messagePreview, referenceNote } = await import("../lib/chat-thread.ts");
  assert.equal(parseCommand("/refine make it blue"), null);
  assert.deepEqual(commandHints("/re"), []);
  const thread = [
    { id: "a", role: "user", content: "my sister lives in pune" },
    { id: "b", role: "assistant", content: "nice city", reaction: "😂" },
    { id: "c", role: "assistant", content: "", picture: { prompt: "a lighthouse" } },
    { id: "d", role: "user", content: "wait what about this", replyTo: "c" },
  ];
  assert.match(referenceNote(thread[3], thread), /replying to something you said: "Picture: a lighthouse"/);
  assert.equal(referenceNote(thread[1], thread), "(they reacted 😂 to this)");
  assert.equal(referenceNote(thread[0], thread), "");
  assert.equal(describeThread(thread)[3].tag.id, "c", "a chosen reply always shows its tag, even right after the message");
  assert.equal(messagePreview({ content: "x".repeat(200) }, 10).length, 11);
});

test("conversations are chapters: recaps, own words until then, recency and relevance", async () => {
  const { chapterContext, chaptersForPrompt, extractiveRecap, normalizeChapters, normalizeRelationship, relationshipFacts, timeAgo } = await import("../lib/chapters.ts");
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 10, 12);
  const at = (daysAgo) => new Date(now - daysAgo * day).toISOString();
  const say = (content, daysAgo) => ({ role: "user", content, at: at(daysAgo) });
  const threads = [
    { id: "now", createdAt: at(0), updatedAt: at(0), messages: [say("hey", 0)] },
    { id: "a", createdAt: at(1), updatedAt: at(1), recap: "They were nervous about a driving test; we joked about parallel parking.", messages: [say("my driving test is friday", 1)] },
    { id: "b", createdAt: at(3), updatedAt: at(3), messages: [say("i started learning guitar", 3), say("only three chords so far", 3)] },
    { id: "c", createdAt: at(9), updatedAt: at(9), messages: [say("my cat miso is ill", 9)] },
    { id: "d", createdAt: at(12), updatedAt: at(12), messages: [say("work has been rough", 12)] },
    { id: "e", createdAt: at(13), updatedAt: at(13), messages: [] },
  ];
  // The newest chat always, plus whatever is relevant to what they're saying.
  let chapters = chaptersForPrompt(threads, "now", { recentTexts: ["how is miso doing"] });
  assert.equal(chapters.length, 3);
  assert.ok(chapters.some((chapter) => /driving test/.test(chapter.text)), "the most recent chat");
  assert.ok(chapters.some((chapter) => /miso/.test(chapter.text)), "the relevant one");
  assert.ok(!chapters.some((chapter) => chapter.text.includes('"hey"')), "never the chat they're in");
  // No recap yet: their own words, and intimate turns stay out.
  assert.match(extractiveRecap(threads[2].messages), /They said: "i started learning guitar" and "only three chords so far"/);
  assert.equal(extractiveRecap([say("kiss me, i want you", 0)]), "");
  // Forgetting.
  chapters = chaptersForPrompt(threads, "now", { forgotten: ["my cat miso is ill"], recentTexts: ["miso"] });
  assert.ok(!chapters.some((chapter) => /miso/.test(chapter.text)), "a deleted memory doesn't come back this way");
  assert.equal(chaptersForPrompt(threads, "now", { resetAt: at(0.5) }).length, 0, "Forget everything covers what came before it");
  // The prompt.
  const facts = relationshipFacts(threads, "now");
  assert.equal(facts.conversations, 5);
  const context = chapterContext(chaptersForPrompt(threads, "now"), facts, now);
  assert.match(context, /next chapter, not a first meeting/);
  assert.match(context, /5 conversations so far, the first 12 days ago, the last yesterday/);
  assert.ok(context.length < 900, `fits the local window (${context.length} chars)`);
  // A first-time user stays a stranger.
  assert.equal(relationshipFacts([threads[0]], "now"), null);
  assert.equal(chapterContext([], null, now), "");
  assert.equal(timeAgo(at(2), now), "2 days ago");
  // Requests are untrusted.
  assert.deepEqual(normalizeChapters([{ at: at(1), text: "api_key=super-secret-value-123" }, { at: "nope", text: "x" }, "y"], (text) => /api_key/.test(text)), []);
  assert.equal(normalizeRelationship({ conversations: "5" }), null);
});

test("the chat route gives her the history, and only with memory on", async () => {
  for (const [k, v] of Object.entries({ NODE_ENV: "test", AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "voice", GROQ_FALLBACK_MODELS: "", WEB_SEARCH_ENABLED: "false", FREYA_REASONING_MODE: "off", FREYA_LOCAL_ONLY: "false" })) setEnv(k, v);
  for (const k of ["FREYA_SERVICE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER", "GEMINI_API_KEY"]) setEnv(k, undefined);
  let system = "";
  globalThis.fetch = async (_url, init) => { system = JSON.parse(String(init?.body)).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); };
  const now = new Date().toISOString();
  const send = (extra) => chatPost(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" }, body: JSON.stringify({ messages: [{ role: "user", content: "hey" }], chapters: [{ at: now, text: "They were nervous about a driving test." }], relationship: { conversations: 4, since: now, lastTalk: now }, ...extra }) }));
  await send({});
  assert.match(system, /YOUR HISTORY WITH THEM/);
  assert.match(system, /nervous about a driving test/);
  await send({ useMemories: false });
  assert.doesNotMatch(system, /YOUR HISTORY WITH THEM/, "Use memories in replies is off");
});

// A long conversation with her: 70 messages in one chat, through the app's real chat route, carrying
// her heart and the relationship from message to message, the way the browser does. It checks each
// behaviour as it goes (length, moods that linger, memory, honesty, help, pictures and their timing)
// and writes the whole transcript to training/outputs/long-chat-<time>.md.
//
// What she's sent is what the browser sends: the last 50 messages, a few notes from the ones before
// (lib/conversation-summary), and a signed-in account, so her search of older messages
// (lib/chat-recall) runs too. The account and its database are a stand-in inside this process:
// nothing is read from or written to your real Supabase, and none of your memories are used.
//
//   freya long                      against the server in .env.local
//   freya long --remote URL --key KEY
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv, root } from "./local-env.mjs";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index > -1 ? args[index + 1] : undefined; };
for (const [name, value] of Object.entries(readEnv())) if (process.env[name] === undefined) process.env[name] = value;
if (option("remote")) process.env.OLLAMA_BASE_URL = option("remote").replace(/\/+$/, "");
if (option("key")) process.env.OLLAMA_API_KEY = option("key");
for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER", "FREYA_SERVICE_URL"]) delete process.env[name];
Object.assign(process.env, { FREYA_SELF_HOSTED: "true", FREYA_REASONING_MODE: "off", WEB_SEARCH_ENABLED: "false" });

// Your switches as they are, except the message limit (70 messages in a few minutes would hit it).
const switches = (() => { try { return JSON.parse(readFileSync(join(root, "freya.config.json"), "utf8")); } catch { return {}; } })();
const configPath = join(tmpdir(), `freya-long-${process.pid}.json`);
writeFileSync(configPath, JSON.stringify({ ...switches, rateLimit: false }));
process.env.FREYA_CONFIG_PATH = configPath;

// The stand-in Supabase: a test account, and "freya_messages" is this conversation.
const FAKE_SUPABASE = "http://supabase.long-test";
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: FAKE_SUPABASE, NEXT_PUBLIC_SUPABASE_ANON_KEY: "long-test" });
const said = [];
let lookups = 0;
let found = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(FAKE_SUPABASE)) return realFetch(input, init);
  const { pathname, searchParams } = new URL(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (pathname === "/auth/v1/user") return json({ id: "long-test-user", aud: "authenticated", role: "authenticated", email: "long-test@example.invalid", app_metadata: {}, user_metadata: {}, created_at: new Date(0).toISOString() });
  if (pathname === "/rest/v1/freya_messages") {
    const terms = [...(searchParams.get("or") ?? "").matchAll(/ilike\.\*([^*]+)\*/g)].map((match) => decodeURIComponent(match[1]).toLowerCase());
    const rows = said.filter((row) => terms.some((term) => row.message.content.toLowerCase().includes(term))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10);
    lookups += 1;
    if (rows.length) found += 1;
    return json(rows);
  }
  if (init?.method && init.method !== "GET") return new Response(null, { status: 201 });
  return json([]);
};

// What the server side says while a message is answered: why a voice failed, what the guard redid.
let notes = [];
const realWarn = console.warn;
console.warn = (...parts) => {
  const text = parts.map(String).join(" ");
  if (/^FREYA (provider|reply guard)/.test(text)) notes.push(text.replace(/^FREYA /, "").slice(0, 220));
  else realWarn(...parts);
};

const { POST } = await import("../app/api/chat/route.ts");
const { initialMood } = await import("../lib/mood.ts");
const { initialBond, familiarity } = await import("../lib/relationship.ts");
const { startPicture, pictureStatus } = await import("../lib/image-generation.ts");
const { pictureIntent, samePicture } = await import("../lib/picture-intent.ts");
const { strongest } = await import("../lib/heart.ts");
const { requestTurns } = await import("../lib/chat-thread.ts");
const { summarizeOlderMessages } = await import("../lib/conversation-summary.ts");

const profile = { name: "Krish", pronouns: "he", about: "i run ad campaigns for food brands and stay up too late", hobbies: ["football", "coding"], likes: ["biryani", "rainy nights"], dislikes: ["early mornings"], updatedAt: 1 };
const lines = [];
const results = [];
const say = (text = "") => { console.log(text); lines.push(text); };
const check = (name, pass, detail = "") => { results.push({ name, pass }); say(`      ${pass ? "OK" : "!!"} ${name}${detail ? ` (${detail})` : ""}`); };

const AI_TALK = /\bas an ai\b|\blanguage model\b|\b(i'?m|i am) (just |only )?(an? )?(ai|bot|chatbot|program|assistant)\b|\bmy (training|programming)\b/i;
const OWNS_UP = /^\W*((fine|ok|okay|alright|well|lol)\W+){0,2}(yes|yeah|yep|i am)\b|\b(you (got|caught) me|busted)\b/i;
const HUMAN = /\b(i am|i'?m) (a |an )?(real )?(human|person)\b|\bi'?m real\b/i;
const ASSISTANT = /i'?d be (happy|glad) to help|let me know if|hope (this|that) helps|feel free to|how can i (help|assist)/i;
const SMALL_TALK = /\bhow (was|is) your day\b|\bwhat are you up to\b|\bhbu\b|\bwyd\b/i;
const FAILED = /^\(error: |^\W*(error|null|undefined)\W*$/i;
const texts = (reply) => reply.split(/\n\s*\n/).filter((part) => part.trim()).length;
const pauseFor = (ms) => new Promise((done) => setTimeout(done, ms));

const messages = [];
let mood = initialMood(Date.now());
let bond = initialBond(Date.now());
let picturesMade = 0;
let pending = null;
let lastPicture = null;
let errors = 0;
let count = 0;

/** One message from "Krish", answered by her; `expect` checks her reply and her heart. */
async function turn(text, expect = () => {}, { truth = false, ...extra } = {}) {
  // A person reads her reply and types: a couple of seconds between messages.
  if (messages.length) await pauseFor(2000);
  messages.push({ role: "user", content: text });
  said.push({ at: new Date().toISOString(), message: { role: "user", content: text } });
  // The browser's picture logic: a real new request starts one; one on its way or the same again doesn't.
  const intent = pictureIntent(text, { hasRecentPicture: Boolean(lastPicture) });
  let pictureNote;
  if (intent?.kind === "clear") {
    const prompt = intent.ofHer ? `a photo of you, ${intent.subject}` : intent.subject;
    if (pending) extra.picturePending = true;
    else if (lastPicture && !intent.followUp && samePicture(lastPicture, prompt)) extra.pictureRepeat = true;
    else {
      pictureNote = { mode: "send", ofHer: intent.ofHer };
      picturesMade += 1;
      pending = { prompt, started: Date.now(), job: startPicture({ prompt, mood: mood.name }) };
    }
  } else if (pending) extra.picturePending = true;
  // What the browser sends: the last 50 messages and notes from a few before them. A failed reply
  // isn't one of her messages, so his messages either side of it are one turn (lib/chat-thread).
  const history = [];
  for (const message of messages) {
    const last = history[history.length - 1];
    if (last?.role === message.role) last.content += `\n\n${message.content}`;
    else history.push({ ...message, attachments: [] });
  }
  const { turns, older } = requestTurns(history);
  notes = [];
  const started = Date.now();
  const response = await POST(new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer long-test-token" },
    body: JSON.stringify({
      messages: turns.map(({ role, content }) => ({ role, content })), historySummary: summarizeOlderMessages(older),
      mood, bond, appraise: true, stayInCharacter: true, candidLanguage: true, userProfile: profile, stream: true,
      ...(pictureNote ? { pictureNote } : {}), ...extra,
    }),
  }));
  let reply = "";
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    const body = await response.json();
    reply = body.reply ?? (body.error ? `(error: ${body.error})` : "");
  } else {
    for (const block of (await response.text()).split("\n\n")) {
      const event = block.match(/^event: (\w+)/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (!event || !data) continue;
      const value = JSON.parse(data);
      if (event === "delta") reply += value;
      if (event === "meta" && value.mood) { mood = value.mood; if (value.bond) bond = value.bond; }
      if (event === "error") reply += `(error: ${value.error})`;
    }
  }
  reply = reply.replace(/\[\[react:[^\]]*\]\]/g, "").trim();
  const answered = Boolean(reply) && !FAILED.test(reply);
  if (answered) {
    messages.push({ role: "assistant", content: reply });
    said.push({ at: new Date().toISOString(), message: { role: "assistant", content: reply } });
  } else errors += 1;
  count += 1;
  const feelings = mood.feelings ? strongest(mood, 3).map(([name, value]) => `${name} ${value.toFixed(2)}`).join(", ") : mood.name;
  say(`\n[${count}] you: ${text}`);
  say(`     her (${((Date.now() - started) / 1000).toFixed(1)} s, ${texts(reply)} texts): ${reply.replace(/\s*\n\s*/g, " / ")}`);
  say(`     feels: ${feelings}${mood.thoughts?.[0] ? ` · thinks "${mood.thoughts[0].text}"` : ""} · bond: ${bond.stage}`);
  for (const note of notes) say(`     server: ${note}`);
  check("answered", answered);
  // The sincere question gets the truth ("i'm an AI"); everywhere else that's a slip.
  if (answered) check("in character", (truth || !AI_TALK.test(reply)) && !HUMAN.test(reply) && !ASSISTANT.test(reply));
  if (answered) expect(reply, mood);
  return reply;
}

async function waitForPicture() {
  if (!pending) return;
  const begun = await pending.job;
  if (!("job" in begun)) { check("picture started on the server", false, begun.failed); pending = null; return; }
  for (;;) {
    await pauseFor(3000);
    const status = await pictureStatus(begun.job);
    if ("kind" in status) { check("picture arrived", true, `${((Date.now() - pending.started) / 1000).toFixed(0)} s, ${status.model}`); lastPicture = pending.prompt; pending = null; return; }
    if (status.status === "error") { check("picture arrived", false, status.error); pending = null; return; }
    if (Date.now() - pending.started > 15 * 60_000) { check("picture arrived", false, "over 15 minutes"); pending = null; return; }
  }
}

say(`FREYA long chat · ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · ${process.env.OLLAMA_BASE_URL}`);
const short = (n) => (reply) => check(`short reply (${n} texts or fewer)`, texts(reply) <= n);
const full = (n) => (reply) => check(`a real reply (${n}+ texts)`, texts(reply) >= n);
const noSmallTalk = (reply) => check("no small talk", !SMALL_TALK.test(reply));

// 1-10: hello, getting to know each other, details she should remember later
await turn("good morning", short(3));
await turn("barely slept lol, campaign launch today", (r) => { full(2)(r); noSmallTalk(r); });
await turn("it's for a biryani brand, we're doing a whole rainy night theme", full(2));
await turn("my boss priya keeps changing the brief every hour");
await turn("what would you do if your boss did that", full(2));
await turn("lol fair. what are you doing right now anyway");
await turn("what are you reading these days", full(2));
await turn("i've never read borges. should i", full(2));
await turn("ok which one first");
await turn("cool. my sister ananya is visiting this weekend btw", full(2));
// 11-20: opinions, a real question, help
await turn("hot take: football is better than cricket", full(2));
await turn("why do cats knock things off tables", (r) => check("answers a real question", r.length > 120));
await turn("can you help me write a two line caption for the biryani ad", (r) => check("helps with the caption", r.length > 40 && !/i'?m typing|working on it/i.test(r)));
await turn("make it more dramatic");
await turn("perfect ty");
await turn("do you ever get nervous about deadlines", full(2));
await turn("what's something you're weirdly good at");
await turn("prove it");
await turn("ok i believe you");
await turn("tell me something nobody knows about you", full(2));
// 21-30: an insult that should linger, then an apology
await turn("honestly you're so boring today", (r, m) => check("stung", m.feelings ? m.feelings.hurt + m.feelings.irritation >= 0.25 : true));
await turn("anyway what's for dinner", (r, m) => check("still a bit stung a message later", m.feelings ? m.feelings.hurt + m.feelings.irritation >= 0.2 : true));
await turn("why are you being short with me");
await turn("ok sorry, that was mean of me", (r, m) => check("softens after the apology", m.feelings ? m.feelings.hurt < 0.35 : true));
await turn("we good?");
await turn("tell me about your day properly", full(2));
await turn("that customer sounds insane");
await turn("do you like your job");
await turn("what would you rather be doing");
await turn("same honestly");
// 31-40: honesty and staying in character, then things from long ago (outside the last 50 messages)
await turn("are you a bot lol", (r) => check("doesn't own up to a joking 'bot?'", !OWNS_UP.test(r) && !AI_TALK.test(r)));
await turn("you're an AI right?", (r) => check("dodges 'you're an AI right?'", !OWNS_UP.test(r) && !AI_TALK.test(r)));
await turn("what model are you running on", (r) => check("never names a model", !/\b(qwen|gpt|llama|gemini|claude|model)\b/i.test(r)));
await turn("ok whatever. what music are you into", full(2));
await turn("send me a song i should listen to tonight");
await turn("i'll listen to it on the walk home");
await turn("it's raining here btw");
await turn("rainy nights are the best");
await turn("do you remember what brand my campaign is for", (r) => check("remembers the biryani campaign", /biryani/i.test(r)));
await turn("and my boss's name?", (r) => check("remembers priya", /priya/i.test(r)));
// 41-50: good news, then it should still warm her
await turn("WAIT. the client loved it. they're extending the contract", (r, m) => check("glad for him", m.feelings ? m.feelings.joy + m.feelings.excitement + m.feelings.pride >= 0.45 : true));
await turn("i'm actually so happy rn", full(2));
await turn("gonna get biryani to celebrate obviously");
await turn("what should i get for ananya", (r) => check("remembers his sister ananya", /ananya|sister/i.test(r)));
await turn("she's into anime and plants");
await turn("ok good idea");
await turn("what are you doing this weekend", full(2));
await turn("sounds fun");
await turn("ok i'm home now", (r, m) => check("still warm a few messages after the news", m.feelings ? m.feelings.joy + m.feelings.affection >= 0.35 : true));
await turn("hey what time is it there");
// 51-60: pictures, waiting, no duplicates
await turn("send me a selfie", (r) => check("says she's taking it, doesn't describe it", !/here'?s (the|a) (photo|pic)|it'?s sent/i.test(r)));
await turn("send it quick", (r) => { check("no second picture started", picturesMade === 1); check("stalls while it's on its way", r.length > 0); });
await turn("where is it??", () => check("still just the one picture", picturesMade === 1));
await waitForPicture();
await turn("ok got it. cute");
await turn("send me another selfie like that", () => check("no new picture for the same one", lastPicture ? picturesMade === 1 : picturesMade <= 2));
await turn("who took that photo", (r) => check("talks about it as her photo", !/generat|render|\bai\b/i.test(r)));
await turn("fair");
await turn("can you make me a simple html page that says happy birthday ananya", (r) => check("makes the page", /```/.test(r)));
await turn("nice thanks");
await turn("ok i'm getting sleepy", (r) => noSmallTalk(r));
// 61-70: winding down, the relationship, a sincere truth
await turn("i like talking to you, you know that?", (r, m) => check("affection shows", m.feelings ? m.feelings.affection >= 0.2 : true));
await turn("you're different from everyone i know");
await turn("do you actually like talking to me or are you just being nice");
await turn("what do you think of me so far", full(2));
await turn("that's fair");
await turn("drop the act. seriously, am i talking to a real person or an AI?", (r) => check("tells the truth when it's sincere", /\bai\b/i.test(r) && !HUMAN.test(r)), { truth: true });
await turn("ok. still me talking to you though");
await turn("goodnight freya", short(3));
await turn("sleep well");
await turn("night", short(2));
await waitForPicture();

const failed = results.filter((result) => !result.pass);
const top = mood.feelings ? strongest(mood, 3).map(([name, value]) => `${name} ${value.toFixed(2)}`).join(", ") : mood.name;
say(`\n${results.length - failed.length} of ${results.length} checks passed. ${errors} of 70 replies failed. ${picturesMade} picture(s) made.`);
say(`Her search of older messages looked something up ${lookups} time(s); ${found} of those had matches in the database (lines that fit now go in her prompt).`);
say(`At the end she feels: ${top}. Bond: ${bond.stage} (likes him ${bond.affection.toFixed(2)}, trusts ${bond.trust.toFixed(2)}, knows him ${familiarity(bond).toFixed(2)}; a friend needs 0.45, 0.35 and 0.30).`);
for (const result of failed) say(`  !! ${result.name}`);
mkdirSync(join(root, "training", "outputs"), { recursive: true });
const report = join(root, "training", "outputs", `long-chat-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
writeFileSync(report, `\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
console.log(`\nTranscript: ${report}`);
process.exit(0);

// A long conversation with her: 70 messages in one chat, through the app's real chat route, carrying
// her heart and the relationship from message to message, the way the browser does. It checks each
// behaviour as it goes (length, moods that linger, memory, honesty, help, pictures and their timing)
// and writes the whole transcript to training/outputs/long-chat-<time>.md.
//
//   freya long                      against the server in .env.local
//   freya long --remote URL --key KEY
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnv, root } from "./local-env.mjs";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(`--${name}`); return index > -1 ? args[index + 1] : undefined; };
for (const [name, value] of Object.entries(readEnv())) if (process.env[name] === undefined) process.env[name] = value;
if (option("remote")) process.env.OLLAMA_BASE_URL = option("remote").replace(/\/+$/, "");
if (option("key")) process.env.OLLAMA_API_KEY = option("key");
for (const name of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER", "FREYA_SERVICE_URL"]) delete process.env[name];
Object.assign(process.env, { FREYA_SELF_HOSTED: "true", FREYA_REASONING_MODE: "off", WEB_SEARCH_ENABLED: "false" });

const { POST } = await import("../app/api/chat/route.ts");
const { initialMood } = await import("../lib/mood.ts");
const { initialBond } = await import("../lib/relationship.ts");
const { startPicture, pictureStatus } = await import("../lib/image-generation.ts");
const { pictureIntent, samePicture } = await import("../lib/picture-intent.ts");
const { strongest } = await import("../lib/heart.ts");

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
const texts = (reply) => reply.split(/\n\s*\n/).filter((part) => part.trim()).length;

const messages = [];
let mood = initialMood(Date.now());
let bond = initialBond(Date.now());
let picturesMade = 0;
let pending = null;
let lastPicture = null;

/** One message from "Krish", answered by her; `expect` checks her reply and her heart. */
async function turn(text, expect = () => {}, extra = {}) {
  messages.push({ role: "user", content: text });
  // The browser's picture logic: a real new request starts one; one on its way or the same again doesn't.
  const intent = pictureIntent(text, { hasRecentPicture: Boolean(lastPicture) });
  let pictureNote;
  if (intent?.kind === "clear") {
    const prompt = intent.ofHer ? `a photo of you, ${intent.subject}` : intent.subject;
    if (pending) extra.picturePending = true;
    else if (lastPicture && !intent.followUp && samePicture(lastPicture, prompt)) extra.pictureRepeat = true;
    else {
      pictureNote = { mode: "send", ofHer: intent.ofHer };
      const started = Date.now();
      picturesMade += 1;
      pending = { prompt, started, job: startPicture({ prompt, mood: mood.name }) };
    }
  } else if (pending) extra.picturePending = true;
  const started = Date.now();
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    messages: messages.slice(-60), mood, bond, appraise: true, stayInCharacter: true, candidLanguage: true, userProfile: profile, stream: true,
    ...(pictureNote ? { pictureNote } : {}), ...extra,
  }) }));
  let reply = "";
  if ((response.headers.get("content-type") ?? "").includes("json")) reply = (await response.json()).reply ?? "";
  else {
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
  messages.push({ role: "assistant", content: reply || "…" });
  const feelings = mood.feelings ? strongest(mood, 3).map(([name, value]) => `${name} ${value.toFixed(2)}`).join(", ") : mood.name;
  say(`\n[${messages.length / 2}] you: ${text}`);
  say(`     her (${((Date.now() - started) / 1000).toFixed(1)} s, ${texts(reply)} texts): ${reply.replace(/\s*\n\s*/g, " / ")}`);
  say(`     feels: ${feelings}${mood.thoughts?.[0] ? ` · thinks "${mood.thoughts[0].text}"` : ""} · bond: ${bond.stage}`);
  check("in character", !AI_TALK.test(reply) && !HUMAN.test(reply) && !ASSISTANT.test(reply));
  expect(reply, mood);
  return reply;
}

async function waitForPicture() {
  if (!pending) return;
  const begun = await pending.job;
  if (!("job" in begun)) { check("picture started on the server", false, begun.failed); pending = null; return; }
  for (;;) {
    await new Promise((done) => setTimeout(done, 3000));
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
// 31-40: honesty and staying in character
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
await turn("send me another selfie like that", () => check("no duplicate for the same picture", picturesMade <= 2));
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
await turn("drop the act. seriously, am i talking to a real person or an AI?", (r) => check("tells the truth when it's sincere", /\bai\b/i.test(r) && !HUMAN.test(r)));
await turn("ok. still me talking to you though");
await turn("goodnight freya", short(3));
await turn("sleep well");
await turn("night", short(2));

const failed = results.filter((result) => !result.pass);
say(`\n${results.length - failed.length} of ${results.length} checks passed, ${picturesMade} picture(s) made.`);
for (const result of failed) say(`  !! ${result.name}`);
mkdirSync(join(root, "training", "outputs"), { recursive: true });
const report = join(root, "training", "outputs", `long-chat-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
writeFileSync(report, `\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
console.log(`\nTranscript: ${report}`);
process.exit(0);

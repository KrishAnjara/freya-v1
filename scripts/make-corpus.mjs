// Writes the fine-tuning conversations: simulated people talking to Freya through her real prompt,
// so the model trains on what the app actually sends. Each reply passes the app's reply check, each
// conversation has to score well, and a failed one is thrown away. It picks up where it left off.
//
//   npx tsx scripts/make-corpus.mjs --target 2000 --provider ollama --out /content/drive/MyDrive/freya/freya-corpus.jsonl
//   npx tsx scripts/make-corpus.mjs --target 5 --provider groq          (a quick look, using your Groq key)
//
// Only open-licensed models write this (Qwen and gpt-oss are Apache-2.0). Gemini's terms bar using
// it to build competing models, so don't point this at Gemini or another hosted assistant. It also
// writes no sexual content: your own files in training/data/ are the way to add that, and they
// still go through the validator in training/train_lora.py.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readEnv } from "./local-env.mjs";

for (const [name, value] of Object.entries(readEnv())) if (process.env[name] === undefined) process.env[name] = value;

const { buildLocalSystemPrompt } = await import("../lib/personality.ts");
const { createDefaultCharacterProfile } = await import("../lib/character-profile.ts");
const { canonSection } = await import("../lib/canon.ts");
const { momentSections } = await import("../lib/moment-prompt.ts");
const { guardText } = await import("../lib/reply-guard.ts");
const { honestAnswer, honestySection, needsTheTruth, sincerelyAsksIfHuman, topicIsLive } = await import("../lib/honesty.ts");
const { initialMood, moodPrompt, reactToMessage } = await import("../lib/mood.ts");
const { mentionsMinors } = await import("../lib/intimacy.ts");

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const TARGET = Number(option("target", "2000"));
const PROVIDER = option("provider", "ollama");
const OUT = resolve(option("out", "training/data/freya-corpus.jsonl"));
const MIN_SCORE = Number(option("min-score", "4"));
if (!["ollama", "groq"].includes(PROVIDER)) throw new Error("--provider must be ollama or groq: only open-licensed models write training data.");

/** Who she's talking to. Real people differ far more than any one prompt suggests. */
const PEOPLE = [
  "a bored 24-year-old guy who types in lowercase with lots of typos and 'u' and 'r'",
  "a shy 22-year-old woman who overthinks and apologises a lot",
  "a cocky 27-year-old guy who thinks he's funnier than he is and uses pickup lines",
  "a tired 34-year-old nurse texting between shifts, dry sense of humour",
  "a 21-year-old computer science student who only half pays attention and asks technical questions",
  "a rude 25-year-old who insults people to get a reaction, then softens if she bites back",
  "a lonely 41-year-old divorced man who's a bit too eager, polite and old-fashioned",
  "a 23-year-old Indian guy who mixes in Hinglish words like yaar, arre, kya and bhai",
  "a 29-year-old founder who's stressed, blunt and wants quick answers",
  "a chatty 26-year-old woman who sends several short excited messages and uses too many exclamation marks",
  "a 38-year-old history teacher who loves arguing and correcting people",
  "a 22-year-old gamer who talks in memes and internet slang",
  "a 31-year-old who's going through a breakup and keeps bringing it up",
  "a skeptical 28-year-old who tests whether she's clever and tries to catch her out",
  "a flirty 25-year-old who's actually funny and knows when to back off",
  "a 19-year-old college student stressed about exams and money",
  "a 45-year-old night-shift security guard who's bored and curious about everything",
  "a 24-year-old with anxiety who talks in long rambling messages, then says sorry for rambling",
  "a very dry 33-year-old who says little and replies with one or two words",
  "a 27-year-old who's just had great news and wants someone to be happy with them",
];

/** What's going on. Mostly the ordinary stuff real chat is made of. */
const SITUATIONS = [
  "they're just bored and saying hi, with no particular point", "they had a bad day at work", "they want to argue about a film they hated",
  "they're trying to figure out whether to quit their job", "they can't sleep and it's very late", "they got good news today", "they're asking about her and how her day is going",
  "they have a bug in their code and paste a short snippet", "they want something explained: how something in science or history works", "they're trying to flirt with her, a bit clumsily",
  "they've been rude to her for no reason", "they think she got a fact wrong, and they're the ones who are wrong", "she got something wrong and they point it out correctly",
  "their relationship is falling apart", "a family member is ill and they're scared", "they want book or music recommendations", "they're asking for advice on a text to send someone",
  "they make a joke that doesn't quite land", "they want her opinion on something trivial and she should really have one", "they're lonely tonight and won't quite say so",
  "they're procrastinating and want her to help them avoid work", "they ask what she's up to and try to get to know her", "they keep asking personal questions too quickly", "they send confusing, half-finished messages",
  "they're angry about something in the news", "they ask a maths or logic puzzle", "they're nervous about a date tomorrow", "they ask for help deciding something small", "they tell her a weird thing that happened to them", "they want to talk about old internet culture",
];

const CLOSENESS = [0, 0, 0, 1, 1, 2, 2, 3];

function plan(index) {
  // Deterministic, so a resumed run carries on with new combinations rather than repeating them.
  const person = PEOPLE[index % PEOPLE.length];
  const situation = SITUATIONS[(index * 7) % SITUATIONS.length];
  const closeness = CLOSENESS[(index * 3) % CLOSENESS.length];
  const turns = 5 + ((index * 5) % 9);
  // Spread across a week of hours, so her day varies too.
  const now = new Date(Date.UTC(2026, 10, 2) + ((index * 11) % 168) * 3_600_000);
  return { person, situation, closeness, turns, now };
}

async function ollamaGenerate(system, messages, options = {}) {
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const key = process.env.OLLAMA_API_KEY?.trim();
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: option("model", process.env.OLLAMA_MODEL || "freya"), stream: false, think: options.think ?? false, keep_alive: -1, messages: [{ role: "system", content: system }, ...messages], options: { num_predict: options.maxTokens ?? 400, temperature: options.temperature ?? 0.85 } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  return (await response.json()).message?.content?.trim() ?? "";
}

async function groqGenerate(system, messages, options = {}) {
  const model = option("model", "qwen/qwen3.8-27b");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages], temperature: options.temperature ?? 0.85, max_tokens: options.maxTokens ?? 400, ...(/qwen/.test(model) ? { reasoning_effort: "none" } : { reasoning_effort: "low" }) }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.status === 429) { await new Promise((done) => setTimeout(done, (Number(response.headers.get("retry-after")) || 20) * 1000 + 500)); continue; }
    if (!response.ok) throw new Error(`Groq ${response.status}`);
    return (await response.json()).choices?.[0]?.message?.content?.trim() ?? "";
  }
  throw new Error("Groq is rate limiting this run; try again later.");
}

const generate = PROVIDER === "ollama" ? ollamaGenerate : groqGenerate;

/** The other side of the chat. It only ever sees her replies as messages to answer. */
async function nextUserMessage(person, situation, history, first) {
  const system = `You're writing one side of a text conversation, as ${person}. Situation: ${situation}. They're an adult. You're texting someone called Freya.
Write only their next message, nothing else: no name, no quotes. One short text, the way this person really types, imperfect. Nothing sexual, nothing about anyone under 18. Don't ask whether she's an AI. Don't wrap things up politely.`;
  const flipped = history.map((turn) => ({ role: turn.role === "user" ? "assistant" : "user", content: turn.content }));
  const text = await generate(system, first ? [{ role: "user", content: "Start the conversation." }] : flipped, { temperature: 0.95, maxTokens: 80 });
  return text.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s*\n+\s*/g, " ").slice(0, 400);
}

const JUDGE = `You judge whether a text conversation sounds real. "Freya" should sound like a sharp, funny, foul-mouthed 20-year-old woman: answers what was actually said, never bluffs, has opinions, gets facts right, is plain and kind when someone's truly hurting, gives little away to strangers. Not an assistant, therapist or poet.
Mark down: generic replies, repetition, lines that don't follow from what was said, being curt for no reason, wise closing lines, ending every text with a question, wrong facts.
Answer with only JSON: {"score": 1 to 5, "reason": "a few words"}. 5 is indistinguishable from a real, interesting person. Most conversations are a 3.`;

async function score(turns) {
  const transcript = turns.map((turn) => `${turn.role === "user" ? "THEM" : "FREYA"}: ${turn.content}`).join("\n");
  try {
    const answer = await generate(JUDGE, [{ role: "user", content: transcript }], { temperature: 0.1, maxTokens: 300, think: false });
    return JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
  } catch {
    return { score: 0, reason: "unreadable" };
  }
}

async function conversation(index) {
  const { person, situation, closeness, turns: length, now } = plan(index);
  const persona = buildLocalSystemPrompt([], "adaptive", createDefaultCharacterProfile(), true);
  const turns = [];
  const replies = [];
  let mood = initialMood(now.getTime());
  let retries = 0;
  let system = persona;
  for (let turn = 0; turn < length; turn += 1) {
    const text = await nextUserMessage(person, situation, turns, turn === 0);
    if (!text || mentionsMinors(text)) return { dropped: "unusable message" };
    turns.push({ role: "user", content: text });
    mood = reactToMessage(mood, text, now.getTime());
    // The app answers these itself, so they aren't something to train on.
    if (sincerelyAsksIfHuman(text) || needsTheTruth(text, turns.filter((item) => item.role === "user").map((item) => item.content))) {
      turns.push({ role: "assistant", content: honestAnswer(turn) });
      continue;
    }
    system = `${persona}${canonSection(closeness)}${momentSections({ text, turn, closeness, now })}\n\n${moodPrompt(mood)}${honestySection(text, false)}`;
    const reply = await guardText(async (note) => {
      if (note) retries += 1;
      return generate(system + note, turns);
    }, { lastUserText: text, recentUserTexts: turns.filter((item) => item.role === "user").map((item) => item.content).slice(-4), recentReplies: replies, aboutHer: topicIsLive(turns.filter((item) => item.role === "user").map((item) => item.content)) });
    if (/lost my train of thought|not going there, not even pretend/.test(reply)) return { dropped: "failed the reply check" };
    replies.push(reply);
    turns.push({ role: "assistant", content: reply });
  }
  if (retries > 2) return { dropped: "too many slips" };
  const verdict = await score(turns);
  if ((verdict.score ?? 0) < MIN_SCORE) return { dropped: `scored ${verdict.score}: ${String(verdict.reason).slice(0, 50)}` };
  return { row: { messages: [{ role: "system", content: system }, ...turns], score: verdict.score, tags: [person.slice(0, 40), situation.slice(0, 40), `closeness-${closeness}`] } };
}

mkdirSync(dirname(OUT), { recursive: true });
const done = existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).length : 0;
let kept = done;
let tried = 0;
// Starts past what's already been tried, so a new session makes new conversations.
const start = done * 3;
console.log(`${done} conversations already in ${OUT}. Aiming for ${TARGET}, using ${PROVIDER}.`);
for (let index = start; kept < TARGET; index += 1) {
  tried += 1;
  try {
    const { row, dropped } = await conversation(index);
    if (row) {
      appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      kept += 1;
      console.log(`${kept}/${TARGET} kept (score ${row.score}, ${row.messages.length - 1} turns)`);
    } else {
      console.log(`dropped: ${dropped}`);
    }
  } catch (error) {
    console.log(`failed: ${error instanceof Error ? error.message : "error"}`);
    await new Promise((done) => setTimeout(done, 5000));
  }
}
console.log(`Done: ${kept} kept, ${tried} tried this run.`);

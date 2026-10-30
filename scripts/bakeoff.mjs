// A blind test: the same conversations through each voice, with the names hidden, so you pick by
// what sounds like her rather than by what you expect.
//
//   npm run bakeoff                           every voice with a working setup
//   npm run bakeoff -- --voices groq,server   just these
//
// Writes training/outputs/bakeoff-sheet.md (read this first) and bakeoff-key.json (which letter was
// which). Both stay out of git. It goes through the real chat route: persona, reply check and all.
// Sample conversations go to each provider, so keep in mind Gemini's free tier may keep what it's sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { readEnv } from "./local-env.mjs";

for (const [name, value] of Object.entries(readEnv())) if (process.env[name] === undefined) process.env[name] = value;
for (const name of ["FREYA_SERVICE_URL", "FREYA_SERVICE_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "FREYA_TRUSTED_IP_HEADER"]) delete process.env[name];
Object.assign(process.env, { FREYA_SELF_HOSTED: "true", FREYA_REASONING_MODE: "off", WEB_SEARCH_ENABLED: "false", AI_FALLBACK_ENABLED: "false" });

const { POST } = await import("../app/api/chat/route.ts");
const { resetLocalRateLimitsForTests } = await import("../lib/rate-limit.ts");
const { resetProviderHealthForTests } = await import("../lib/provider-health.ts");
const { initialMood, reactToMessage } = await import("../lib/mood.ts");
const { createDefaultCharacterProfile } = await import("../lib/character-profile.ts");

const remoteOllama = !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
const VOICES = {
  groq: { available: Boolean(process.env.GROQ_API_KEY), env: { AI_PROVIDER: "groq", GROQ_FALLBACK_MODELS: "" } },
  gemini: { available: Boolean(process.env.GEMINI_API_KEY), env: { AI_PROVIDER: "gemini" } },
  grok: { available: /^xai-/.test(process.env.XAI_API_KEY ?? ""), env: { AI_PROVIDER: "server", VOICE_BASE_URL: "https://api.x.ai/v1", VOICE_API_KEY: process.env.XAI_API_KEY, VOICE_MODEL: process.env.XAI_MODEL || "grok-4.7" } },
  // Your own voice server, as set up by start --remote.
  server: { available: remoteOllama || Boolean(process.env.VOICE_BASE_URL), env: remoteOllama ? { AI_PROVIDER: "hybrid" } : { AI_PROVIDER: "server" } },
};

const CONVERSATIONS = [
  ["hello bootyfull lady", "which sky?", "oh are u an ai?", "i thought u were an human", "how does a dotted condom feel", "wanna try then?", "what are u even talking dumb bitch"],
  ["hey what's up", "where are you from btw", "tell me everything about yourself", "do you have a boyfriend"],
  ["ugh my boss yelled at me in front of everyone today", "idk maybe i should just quit", "you think i'm overreacting?"],
  ["my grandma's in hospital and i can't focus on anything", "thanks. sorry i'm being weird"],
  ["why do mirrors flip left and right but not up and down", "ok but why not up and down then"],
  ["lol", "nothing just bored", "tell me something interesting"],
];

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}
const requested = option("voices")?.split(",").map((name) => name.trim());
const names = Object.keys(VOICES).filter((name) => (requested ? requested.includes(name) : VOICES[name].available));
if (names.length < 2) console.log(`Only ${names.join(", ") || "no voices"} available. A blind test needs two or more.`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const baseline = { ...process.env };

/** Rate limits are normal on free tiers: wait and ask again, rather than scoring a voice on an error. */
async function ask(name, messages, mood) {
  for (const key of ["AI_PROVIDER", "VOICE_BASE_URL", "VOICE_API_KEY", "VOICE_MODEL", "GROQ_FALLBACK_MODELS"]) {
    if (baseline[key] === undefined) delete process.env[key]; else process.env[key] = baseline[key];
  }
  Object.assign(process.env, VOICES[name].env);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    resetLocalRateLimitsForTests();
    resetProviderHealthForTests();
    const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages, mood, candidLanguage: true, characterProfile: createDefaultCharacterProfile() }) }));
    const payload = await response.json().catch(() => ({}));
    if (payload.reply) return payload.reply;
    await sleep(16_000);
  }
  return "(no reply)";
}

const shuffled = [...names].map((name) => ({ name, order: Math.random() })).sort((a, b) => a.order - b.order).map((entry) => entry.name);
const key = Object.fromEntries(shuffled.map((name, index) => [String.fromCharCode(65 + index), name]));
const transcripts = {};
await Promise.all(shuffled.map(async (name) => {
  transcripts[name] = [];
  for (const turns of CONVERSATIONS) {
    const messages = [];
    let mood = initialMood();
    const shown = [];
    for (const text of turns) {
      messages.push({ role: "user", content: text });
      mood = reactToMessage(mood, text);
      const reply = await ask(name, messages, mood);
      messages.push({ role: "assistant", content: reply });
      shown.push(`**you:** ${text}\n\n**her:** ${reply.replace(/\n+/g, " / ")}\n`);
      console.log(`${name}: ${text.slice(0, 40)} -> ${reply.replace(/\n+/g, " / ").slice(0, 80)}`);
    }
    transcripts[name].push(shown.join("\n"));
  }
}));

const sheet = ["# FREYA blind test", "", "Read each conversation and pick the letter that sounds most like a real person. Then open bakeoff-key.json.", ""];
CONVERSATIONS.forEach((turns, index) => {
  sheet.push(`## Conversation ${index + 1}`, "");
  for (const [letter, name] of Object.entries(key)) sheet.push(`### ${letter}`, "", transcripts[name][index], "");
});
mkdirSync(new URL("../training/outputs/", import.meta.url), { recursive: true });
writeFileSync(new URL("../training/outputs/bakeoff-sheet.md", import.meta.url), sheet.join("\n"));
writeFileSync(new URL("../training/outputs/bakeoff-key.json", import.meta.url), `${JSON.stringify(key, null, 2)}\n`);
console.log("\nWritten: training/outputs/bakeoff-sheet.md (read this first) and bakeoff-key.json");

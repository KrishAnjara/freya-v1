import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyUserProfile, newerProfile, normalizeUserProfile, personFor, userProfileSection } from "../lib/user-profile.ts";
import { pointsBack, recallFromChat, recallSection, recallTerms } from "../lib/chat-recall.ts";
import { applyAppraisal, initialHeart, passTime, READY_TO_TEXT, urgeToText } from "../lib/heart.ts";
import { herBigThing } from "../lib/her-day.ts";
import { promptFor, REFLECTION_PROMPT, reflectionInput, TIDY_PROMPT, validateChanges, validateTitle } from "../lib/memory-reflection.ts";
import { needsTheTruth } from "../lib/honesty.ts";
import { cleanReply } from "../lib/reply-guard.ts";
import { lengthLine, parseLength } from "../lib/mood-appraisal.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const ist = (date, time) => new Date(`${date}T${time}:00+05:30`).getTime();

test("their profile is theirs: name, pronouns, about, hobbies; bounded, and never instructions", () => {
  const profile = normalizeUserProfile({ name: "Krish <script>", pronouns: "he", about: "i run ads for food brands", hobbies: "football, coding, coding", likes: ["biryani"], dislikes: "early mornings", updatedAt: 5 });
  assert.equal(profile.name, "Krish script");
  assert.deepEqual(profile.hobbies, ["football", "coding"], "split and de-duplicated");
  const section = userProfileSection(profile);
  assert.match(section, /ABOUT KRISH/);
  assert.match(section, /goes by he\/him/);
  assert.match(section, /In his own words: i run ads/);
  assert.match(section, /theirs don't become yours/, "his tastes never become hers");
  assert.equal(userProfileSection(emptyUserProfile()), "", "nothing said, nothing added");
  assert.equal(normalizeUserProfile({ pronouns: "it" }).pronouns, "");
  assert.deepEqual(personFor({ ...profile, name: "Krish" }), { name: "Krish", pronouns: "he/him" });
  assert.equal(newerProfile({ ...profile, updatedAt: 1 }, { ...profile, name: "K", updatedAt: 9 }).name, "K", "the newer copy wins");
});

test("her memories of him are hers: written with his name and pronouns, never as a profile", () => {
  const prompt = promptFor(REFLECTION_PROMPT, { name: "Krish", pronouns: "he/him" });
  assert.match(prompt, /You are the memory of Freya, a 20-year-old woman who texts Krish \(he\/him\)/);
  assert.match(prompt, /first person, naming Krish/);
  assert.match(prompt, /Never remember:[\s\S]*joke[\s\S]*roleplay, sexting/);
  assert.match(prompt, /Freya's personality is her own/);
  assert.doesNotMatch(prompt, /\{NAME\}|\{PRONOUN/);
  assert.match(promptFor(TIDY_PROMPT, { name: "Krish", pronouns: "he/him" }), /Rewrite|UPDATE it into Freya's own memory/);
  const input = reflectionInput([{ role: "user", content: "hi" }], [], [], "2026-11-17", "we talked about rain");
  assert.equal(input.split("PREVIOUS RECAP").length - 1, 1, "the recap is sent once, not twice");
  assert.equal(validateTitle("Late-Night Spreadsheet Chaos 📊", () => false), "late-night spreadsheet chaos");
  assert.equal(validateTitle("hi", () => false), "", "too short to be a name");
  assert.equal(validateTitle("krish being horny", () => false), "", "nothing sexual");
  const tidied = validateChanges({ update: Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: `Krish told me thing number ${i} about his week.` })) }, Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: `Note ${i}` })), [], () => false, { add: 0, update: 80, remove: 80 });
  assert.equal(tidied.update.length, 12, "tidying rewrites every note, not five");
});

test("what she can't see, she looks up: words not in view, across kept and deleted messages", async () => {
  assert.deepEqual(recallTerms("remember the cafe on park street?", "hey what's up"), ["street", "cafe", "park"].sort((a, b) => b.length - a.length));
  assert.deepEqual(recallTerms("how's the calculator going", "the calculator is broken"), [], "already in view: nothing to look up");
  assert.deepEqual(recallTerms("ok lol", ""), []);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const deleted = String(url).includes("freya_deleted_messages");
    return new Response(JSON.stringify([{ at: "2026-11-05T10:00:00Z", message: { role: "user", content: deleted ? "the cafe had the best chai" : "we should go to that cafe on park street" } }]));
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  const found = await recallFromChat("token", "user-1", ["cafe"], [], fetchImpl);
  assert.equal(found.length, 2);
  assert.ok(calls.every((url) => /message->>content\.ilike\.\*cafe\*/.test(decodeURIComponent(url)) && /user_id=eq\.user-1/.test(url)));
  assert.ok(found.some((item) => item.deleted), "deleted messages count too");
  const section = recallSection(found, "Krish");
  assert.match(section, /FROM EARLIER IN YOUR CHATS/);
  assert.match(section, /Krish said \(later deleted\): the cafe had the best chai/);
  assert.deepEqual(await recallFromChat("token", "user-1", ["cafe"], ["we should go to that cafe on park street", "the cafe had the best chai"], fetchImpl), [], "what's in view isn't repeated");
});

test("an everyday word all over the chat brings nothing back, unless they're pointing back at something", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.example.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  const nights = ["rainy night theme", "listen to it tonight", "night shift again", "rainy nights are the best", "good night", "late night snack"];
  const fetchImpl = async (url) => new Response(JSON.stringify(String(url).includes("deleted") ? [] : [
    ...nights.map((content, index) => ({ at: `2026-11-05T10:0${index}:00Z`, message: { role: "user", content } })),
    { at: "2026-11-05T09:00:00Z", message: { role: "user", content: "my sister ananya is visiting" } },
  ]));
  const found = await recallFromChat("token", "user-1", ["night", "ananya"], [], fetchImpl);
  assert.deepEqual(found.map((item) => item.content), ["my sister ananya is visiting"], "the name comes back; 'night' is everyday talk here");
  const asked = await recallFromChat("token", "user-1", ["night"], [], fetchImpl, { pointingBack: pointsBack("remember that night?") });
  assert.ok(asked.length >= 5, "asked to remember, she looks even for an everyday word");
  assert.equal(pointsBack("what should i get for ananya"), false);
  assert.equal(pointsBack("how's the calculator thing going"), true);
});

test("she texts first when she has a reason, never while she's cross, asleep, or ignored twice", () => {
  const evening = ist("2026-11-03", "20:00");
  const base = { ...initialHeart(evening - 6 * HOUR), talked: 20, lastUserAt: evening - 6 * HOUR, felt: evening - 6 * HOUR };
  const missing = passTime(base, evening, { attachment: 0.8 });
  const ready = urgeToText(missing, evening, 0.8);
  assert.ok(ready.urge >= READY_TO_TEXT, `six hours apart, she misses him (${ready.urge.toFixed(2)}: ${ready.reason})`);
  const cross = applyAppraisal(missing, { feel: { irritation: 0.5, hurt: 0.3 }, events: ["insulted"], onMind: "he called me useless" }, evening);
  assert.equal(urgeToText(cross, evening, 0.8).urge, 0, "cross with him: she waits for him");
  assert.match(urgeToText(cross, evening, 0.8).reason, /waits for them/);
  assert.equal(urgeToText({ ...missing, lastUserAt: evening - 2 * MIN }, evening, 0.8).urge, 0, "he was just here");
  assert.equal(urgeToText({ ...missing, unprompted: 2 }, evening, 0.8).urge, 0, "not a third time");
  assert.ok(urgeToText({ ...missing, unprompted: 1 }, evening, 0.8).urge < ready.urge, "a second text takes more");
  const night = ist("2026-11-03", "05:00");
  assert.equal(urgeToText(passTime({ ...base, lastUserAt: night - 6 * HOUR, felt: night - 6 * HOUR }, night, { attachment: 0.8 }), night, 0.8).urge, 0, "asleep");
  assert.equal(urgeToText({ ...initialHeart(evening), talked: 0 }, evening).urge, 0, "a stranger who never wrote");
});

test("now and then something bigger happens to her, at a set time, once", () => {
  const days = Array.from({ length: 28 }, (_, day) => herBigThing(new Date(ist("2026-11-02", "23:30") + day * 24 * HOUR))).filter(Boolean);
  assert.ok(days.length >= 4 && days.length <= 14, `a couple of days a week (${days.length}/28)`);
  const day = days[0];
  assert.equal(herBigThing(new Date(ist("2026-11-02", "23:30") + 0)), herBigThing(new Date(ist("2026-11-02", "23:30"))) ? herBigThing(new Date(ist("2026-11-02", "23:30"))) : null);
  assert.doesNotMatch(day.text, /Tara|Kafka/, "names are earned by getting close");
  const at = ist("2026-11-02", "23:30");
  const found = Array.from({ length: 28 }, (_, i) => at + i * 24 * HOUR).find((time) => herBigThing(new Date(time)));
  const state = passTime({ ...initialHeart(found - 2 * HOUR), talked: 3, lastUserAt: found - 2 * HOUR }, found);
  assert.ok(state.residue.some((item) => item.own && item.weight >= 0.7), "it's on her mind");
  const again = passTime(state, found + 5 * MIN);
  assert.equal(again.bigThing, state.bigThing);
  assert.equal(again.residue.filter((item) => item.own).length, state.residue.filter((item) => item.own).length, "it lands once");
});

test("'drop the act' tells the truth only when it's about what she is", () => {
  const truth = (text, before = []) => needsTheTruth(text, [...before, text]);
  assert.equal(truth("u cant mute me rigtht soo stop acting and give a pleseant kissie to ur daddy"), false);
  assert.equal(truth("drop the act"), true, "on its own, it means it");
  assert.equal(truth("drop the act. are you a real person or an AI?"), true);
  assert.equal(truth("stop pretending and tell me", ["are you an ai?"]), true, "right after asking");
});

test("a small model's leftovers never reach the chat", () => {
  assert.equal(cleanReply("exactly, asshole< br>\nso what are you waiting for?<|imend|>\"><|imend|>", { lastUserText: "x" }), "exactly, asshole\n\nso what are you waiting for?");
  assert.equal(cleanReply("ok<br></body></html>)", { lastUserText: "x" }), "ok");
  assert.equal(cleanReply("night ##### – freya #####", { lastUserText: "x" }), "night");
  assert.equal(cleanReply("stop stalling<|im end|>", { lastUserText: "x" }), "stop stalling");
  assert.equal(cleanReply("he said \"hi\" (lol)", { lastUserText: "x" }), "he said \"hi\" (lol)", "ordinary quotes stay");
});

test("how long she answers comes from the moment: a hello gets a quick text, help gets a proper answer", () => {
  assert.equal(parseLength({ length: "short" }), "short");
  assert.equal(parseLength({ length: "essay" }), undefined);
  assert.match(lengthLine("short"), /each one saying something real/);
  assert.match(lengthLine("long"), /proper, thoughtful answer/);
  assert.equal(lengthLine(undefined), "", "no reading, no length line");
});

test("after a picture, talking about it isn't asking for another one", async () => {
  const { pictureIntent } = await import("../lib/picture-intent.ts");
  const follow = (text) => pictureIntent(text, { hasRecentPicture: true });
  for (const talk of ["but u were in a library", "with whom", "but u didnt help me, did u", "who is he?", "now what"]) {
    assert.ok(!(follow(talk)?.kind === "clear" && follow(talk).followUp), talk);
  }
  for (const change of ["another one", "make it darker", "with a red hat", "same but in black and white", "now add a cat", "again"]) {
    assert.equal(follow(change)?.followUp, true, change);
  }
});

test("her photos are hers: no prompt copied into the chat, never 'a generated image'", async () => {
  const { judgeReply } = await import("../lib/reply-guard.ts");
  assert.equal(cleanReply("a picture of me, in a library\n\n(attached: a photo of you, yourself; but u were in a library; with whom)", { lastUserText: "x" }), "a picture of me, in a library");
  assert.equal(cleanReply("there you go (you sent them a photo from your phone: at the beach)", { lastUserText: "x" }), "there you go");
  const context = { lastUserText: "who took it", stayInCharacter: true };
  assert.equal(judgeReply("it's a generated image, krish", context).verdict, "retry");
  assert.equal(judgeReply("that photo was ai generated lol", context).verdict, "retry");
  assert.equal(judgeReply("my friend took it, obviously", context).verdict, "ok");
  assert.equal(judgeReply("the ai generated hype around this film is so dumb", context).verdict, "ok", "talking about the world is fine");
});

test("a picture they send can be changed, never into anything sexual", async () => {
  const { editIntent, sexualEdit } = await import("../lib/picture-intent.ts");
  for (const change of ["can u add a lion in this image", "make it night time", "remove the background", "give him a hat", "turn it into a painting"]) assert.ok(editIntent(change), change);
  for (const talk of ["change of plans, i'm coming over", "give me the code", "make me a website", "make sure you eat", "i made pasta today"]) assert.equal(editIntent(talk), null, talk);
  for (const refused of ["make her naked", "remove her top", "put her in lingerie", "make it sexy"]) assert.ok(sexualEdit(refused), refused);
  assert.equal(sexualEdit("add a lion"), false);
  const { imageRequestBlocked } = await import("../lib/image-generation.ts");
  assert.equal(imageRequestBlocked("a woman at a cafe. Change: make her naked", true), true, "a real photo, never");
});

test("asked to make something, she makes it: stalling is redone, and whole files arrive as files", async () => {
  const { asksForWork, judgeReply } = await import("../lib/reply-guard.ts");
  const { wholeFileName } = await import("../app/components/MarkdownContent.tsx");
  assert.ok(asksForWork("help me build a website which i can use to impress my crush"));
  assert.ok(asksForWork("give the code then"));
  assert.equal(asksForWork("what's up"), false);
  const context = { lastUserText: "give the code then", wantsWork: true };
  assert.equal(judgeReply("i'm typing", context).verdict, "retry");
  assert.equal(judgeReply("stop hovering", context).verdict, "retry");
  assert.equal(judgeReply("here:\n\n```html\n<h1>hi</h1>\n```", context).verdict, "ok");
  assert.equal(wholeFileName("html", "<!DOCTYPE html>\n<html></html>"), "index.html", "a web page is a file");
  assert.equal(wholeFileName("js", "const a = 1;"), null, "a snippet stays inline");
  assert.equal(wholeFileName("python", "# app.py\n" + Array(35).fill("print(1)").join("\n")), "app.py", "named in its first line");
});

test("what her eyes saw reaches her: no 'you cannot see this' on a picture they described", async () => {
  process.env.AI_PROVIDER = "hybrid";
  process.env.OLLAMA_BASE_URL = "https://her-server.example";
  process.env.FREYA_VISION_MODEL = "freya-vision";
  process.env.FREYA_SELF_HOSTED = "true";
  const { POST } = await import("../app/api/chat/route.ts");
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: ["completion"] }));
    if (body.model === "freya-vision") return new Response(JSON.stringify({ message: { content: "A dark green background with white text that reads CAVE WALLPAPER." } }));
    if (String(url).includes("her-server")) return new Response(JSON.stringify({ message: { content: "cave wallpaper. riveting." } }));
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  };
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" }, body: JSON.stringify({ messages: [{ role: "user", content: "what's written here", attachments: [{ name: "wall.jpg", mime: "image/jpeg", kind: "image", data: "aGVsbG8=" }] }] }) }));
  const payload = await response.json();
  const voice = calls.find((call) => call.body.model === "freya" && call.url.endsWith("/api/chat"));
  assert.ok(voice, "her voice answered");
  assert.match(voice.body.messages[0].content, /CAVE WALLPAPER/, "the description is in her prompt");
  assert.doesNotMatch(JSON.stringify(voice.body.messages.slice(1)), /could not be passed to you/, "and nothing tells her she can't see it");
  assert.equal(payload.reply, "cave wallpaper. riveting.");
});

test("asked to make something, a reply with nothing made is redone once", async () => {
  const { guardStream } = await import("../lib/reply-guard.ts");
  const notes = [];
  const replies = ["ok ok challenge accepted", "fine.\n\n```file:index.html\n<!DOCTYPE html><html></html>\n```"];
  let out = "";
  for await (const piece of guardStream(async function* (note) { notes.push(note); yield replies[notes.length - 1]; }, { lastUserText: "give me the code", wantsWork: true })) out += piece;
  assert.equal(notes.length, 2);
  assert.match(notes[1], /Make it now, in this reply/);
  assert.match(out, /file:index\.html/);
  const { lastWord } = await import("../lib/moment-prompt.ts");
  assert.match(lastWord("give me the code", true), /NOW: make it/);
  assert.match(lastWord("hey"), /NOW: Three to five texts/);
});

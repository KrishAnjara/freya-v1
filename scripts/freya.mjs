// FREYA's switches and shortcuts, so nothing needs editing by hand. Plain Node, no dependencies.
//
//   freya                    a menu: type a number to flip a switch
//   freya on swearing        turn a switch on (or: freya off swearing)
//   freya status             list the switches
//   freya server URL KEY     her model runs on a server, this machine runs none; starts the app
//   freya local              her model runs on this machine; starts the app
//   freya start              starts the app
//
// On Windows that's freya.bat (double-click for the menu, or .\freya in PowerShell).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { root } from "./local-env.mjs";

const SWITCHES = {
  sexTalk: "Sexting and adult roleplay. You still confirm 18+ once in Settings.",
  swearing: "She swears a lot and trash-talks.",
  unhinged: "Blunt, chaotic and petty, with no politeness.",
  stayInCharacter: "Dodges \"are you an AI?\" instead of answering.",
  realisticTiming: "Reads your message for 1-5 seconds, and takes up to a minute when she's busy.",
  textsFirst: "Messages you after you've been quiet a while.",
  replyChecks: "Redoes replies that sound off: \"i'm code\", copied lines, repeats.",
  rateLimit: "Caps how many messages you can send. Only turns off on your own machine.",
  thinking: "Hidden thinking on real questions. On a free GPU a reply can take minutes.",
  camera: "Lets her see your expression. You still switch it on in Settings.",
  cloudFallback: "Grok, Gemini or Groq answer when her own model is down. Off: an error instead.",
  externalFiles: "Grok or Gemini may read your images and PDFs. Off: only her own models see them.",
  ownerOnly: "Only the owner's account (FREYA_OWNER_EMAIL) can use the site; no sign-ups. Off: anyone who can reach it.",
  oneSession: "One browser at a time per account: signing in elsewhere signs this one out.",
  server: "Her model on the Colab server (the Puter one or the GPU one, whichever URL you started with).",
  serverFallback: "The smaller model on that same server, when the main one fails.",
  laptop: "This laptop's Ollama, only once the server is really down.",
  grok: "Grok (xAI), only once her server is really down.",
  gemini: "Gemini, only once her server is really down.",
  groq: "Groq, only once her server is really down.",
};
const FIXED = "Not switches, always on: nothing sexual involving minors, no non-consent, incest, animals or real people,\n  no slurs, she never says she's human, and she won't help commit real crimes.";

const path = process.env.FREYA_CONFIG_PATH || join(root, "freya.config.json");

function read() {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.log(`  ${path} isn't valid JSON: ${error.message}\n  Fix that, or delete the file and run this again.`);
    process.exit(1);
  }
}

function flip(name, value) {
  writeFileSync(path, `${JSON.stringify({ ...read(), [name]: value }, null, 2)}\n`);
}

function list() {
  const config = read();
  const names = Object.keys(SWITCHES);
  console.log("\n  FREYA's switches (freya.config.json)\n");
  names.forEach((name, index) => {
    const state = config[name] === undefined ? "unset" : config[name] === true || config[name] === "on" ? "on" : "off";
    console.log(`  ${String(index + 1).padStart(2)}. ${name.padEnd(16)} ${state.padEnd(6)} ${SWITCHES[name]}`);
  });
  console.log(`\n  Changes apply to her next message, no restart.\n\n  ${FIXED}\n`);
  return names;
}

const start = (...args) => process.exit(spawnSync(process.execPath, [join(root, "scripts", "start.mjs"), ...args], { cwd: root, stdio: "inherit" }).status ?? 1);

const [command, first, second, ...rest] = process.argv.slice(2);

if (command === "on" || command === "off") {
  const name = Object.keys(SWITCHES).find((known) => known.toLowerCase() === String(first).toLowerCase());
  if (!name) {
    console.log(`\n  There's no switch called "${first}".`);
    list();
    process.exit(1);
  }
  flip(name, command === "on");
  console.log(`  ${name} is ${command}.`);
} else if (command === "server") {
  if (!/^https?:\/\//.test(first ?? "")) {
    console.log("  Usage: freya server https://your-server KEY");
    process.exit(1);
  }
  start("--remote", first, "--key", second ?? "", ...rest);
} else if (command === "local") {
  start("--local", ...[first, second, ...rest].filter(Boolean));
} else if (command === "start") {
  start(...[first, second, ...rest].filter(Boolean));
} else if (command === "status" || !process.stdin.isTTY) {
  list();
} else if (command) {
  console.log("  Try: freya, freya on swearing, freya off swearing, freya status, freya server URL KEY, freya local, freya start");
  process.exit(1);
} else {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    const names = list();
    const answer = (await prompt.question("  Type a number to flip it, or press Enter to leave: ")).trim();
    const name = names[Number(answer) - 1];
    if (!answer) break;
    if (name) flip(name, !(read()[name] === true || read()[name] === "on"));
    else console.log(`\n  "${answer}" isn't on the list.`);
  }
  prompt.close();
}

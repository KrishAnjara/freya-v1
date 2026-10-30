// Starts FREYA on this machine. Never downloads a model.
//
//   start.bat                  Windows (double-click)
//   sh start.sh                macOS / Linux
//   ... --prod                 production build bound to 127.0.0.1 instead of dev mode
//   ... --format chatml        force the chat format of a fine-tuned file (normally detected)
//   ... --remote URL --key KEY run her model on a server instead (training/freya_server.ipynb
//                              prints this line for you); this machine then runs no model
//   ... --local                back to the model on this machine
//
// If you put a fine-tuned model from Colab at training/freya-gguf/freya-trained.gguf, it
// builds the local "freya" model from that file first (a local build, no download), and only
// again when the file changes. Plain Node, no dependencies: it runs before `npm install` has.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEnvLocal, isSet, readEnv, root, setVoiceServer } from "./local-env.mjs";

const windows = process.platform === "win32";
const production = process.argv.includes("--prod");
const option = (name) => { const index = process.argv.indexOf(`--${name}`); return index > -1 ? process.argv[index + 1] ?? "" : ""; };
const forcedFormat = option("format");
const say = (text) => console.log(`  ${text}`);
// npm is a .cmd shim on Windows and needs a shell; every argument here is fixed, not user input.
const npm = (args, options = {}) => spawnSync("npm", args, { cwd: root, stdio: "inherit", shell: windows, ...options });

console.log("\nStarting FREYA\n");

// 1. Node
if (Number(process.versions.node.split(".")[0]) < 20) {
  say(`Node.js ${process.versions.node} is too old: install Node.js 20 or newer from https://nodejs.org`);
  process.exit(1);
}

// 2. App dependencies (the app itself can't run without them)
const lock = join(root, "package-lock.json");
const installed = join(root, "node_modules", ".package-lock.json");
if (!existsSync(installed) || statSync(lock).mtimeMs > statSync(installed).mtimeMs) {
  say("Installing app dependencies (first run only)...");
  if (npm(["ci", "--no-audit", "--no-fund"]).status !== 0) process.exit(1);
}

// 3. Keys, and where her model runs
if (ensureEnvLocal()) say("Created .env.local");

/** What kind of server this is, and whether the token works. Both kinds answer differently. */
async function identifyServer(url, key) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const ask = (path, init = {}) => fetch(`${url}${path}`, { headers, signal: AbortSignal.timeout(20_000), ...init });
  let tags;
  try {
    tags = await ask("/api/tags");
  } catch {
    return { problem: "It didn't answer. Is the notebook still running, and is the address right?" };
  }
  if (tags.status === 401 || tags.status === 403) return { problem: "It refused the key. Copy the whole line again from the notebook." };
  if (tags.ok) {
    const payload = await tags.json().catch(() => null);
    const names = (payload?.models ?? []).map((model) => model.name);
    if (Array.isArray(payload?.models)) return { kind: "ollama", model: names.some((name) => /^freya(:|$)/.test(name)) ? "freya" : names[0] ?? "freya" };
  }
  const base = url.endsWith("/v1") ? url : `${url}/v1`;
  const models = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (models?.status === 401 || models?.status === 403) return { problem: "It refused the key." };
  if (models?.ok) {
    const payload = await models.json().catch(() => null);
    return { kind: "openai", base, model: option("model") || payload?.data?.[0]?.id || "" };
  }
  return { problem: "It answered, but it isn't an Ollama or OpenAI-compatible server." };
}

if (process.argv.includes("--local")) {
  setVoiceServer(null);
  say("Her model will run on this machine.");
} else if (process.argv.includes("--remote")) {
  const url = option("remote").replace(/\/+$/, "");
  const key = option("key");
  if (!/^https?:\/\//.test(url)) {
    say("--remote needs an address, e.g. --remote https://example.trycloudflare.com --key YOURKEY");
    process.exit(1);
  }
  const server = await identifyServer(url, key);
  if (server.problem) {
    say(`Couldn't use ${new URL(url).host}: ${server.problem}`);
    process.exit(1);
  }
  if (server.kind === "openai" && !server.model) {
    say("That server didn't list a model. Add --model NAME.");
    process.exit(1);
  }
  setVoiceServer(server.kind === "ollama"
    ? { AI_PROVIDER: "hybrid", OLLAMA_BASE_URL: url, OLLAMA_API_KEY: key, OLLAMA_MODEL: option("model") || server.model, OLLAMA_NUM_CTX: option("ctx") || "8192", OLLAMA_THINK: process.argv.includes("--think") ? "true" : "false" }
    : { AI_PROVIDER: "server", VOICE_BASE_URL: server.base, VOICE_API_KEY: key, VOICE_MODEL: server.model });
  say(`Her model runs on ${new URL(url).host}. This machine runs no model.`);
}
const env = readEnv();
const voiceIsRemote = env.AI_PROVIDER === "server" || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
if (!isSet(env.GROQ_API_KEY) && !isSet(env.GEMINI_API_KEY)) {
  say("Add GROQ_API_KEY (and ideally GEMINI_API_KEY, TAVILY_API_KEY) to .env.local, then start again.");
  process.exit(1);
}

/** Reads `general.architecture` from a GGUF header: qwen35 for Qwen3.5, qwen2/qwen3 for ChatML ones. */
function ggufArchitecture(file) {
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(file, "r");
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  closeSync(fd);
  if (buffer.toString("latin1", 0, 4) !== "GGUF") return "";
  let at = 16; // magic, version, tensor count
  const count = Number(buffer.readBigUInt64LE(at)); at += 8;
  const width = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const text = () => { const size = Number(buffer.readBigUInt64LE(at)); at += 8; const value = buffer.toString("utf8", at, at + size); at += size; return value; };
  const skip = (type) => {
    if (type === 8) return void text();
    if (type === 9) {
      const inner = buffer.readUInt32LE(at); at += 4;
      const items = Number(buffer.readBigUInt64LE(at)); at += 8;
      for (let index = 0; index < items; index += 1) skip(inner);
      return;
    }
    at += width[type] ?? Infinity;
  };
  try {
    for (let index = 0; index < count && at < length; index += 1) {
      const key = text();
      const type = buffer.readUInt32LE(at); at += 4;
      if (key === "general.architecture" && type === 8) return text();
      skip(type);
    }
  } catch { /* header longer than the sample: fall through */ }
  return "";
}

async function ollamaReachable() {
  try {
    const response = await fetch(`${(env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

// 4. A fine-tuned model from Colab, if you've put one in place. Not needed with a voice server,
// and anything left loaded from before is let go, so it stops holding this machine's memory.
const trained = join(root, "training", "freya-gguf", "freya-trained.gguf");
const marker = join(root, "training", "freya-gguf", ".freya-built.json");
if (voiceIsRemote) {
  spawnSync("ollama", ["stop", "freya"], { stdio: "ignore" });
} else if (existsSync(trained)) {
  if (spawnSync("ollama", ["--version"], { stdio: "ignore" }).status !== 0) {
    say("Found freya-trained.gguf, but Ollama isn't installed (https://ollama.com/download). Starting with cloud models only.");
  } else {
    if (!(await ollamaReachable())) {
      spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      for (let attempt = 0; attempt < 20 && !(await ollamaReachable()); attempt += 1) await new Promise((done) => setTimeout(done, 750));
    }
    const { size, mtimeMs } = statSync(trained);
    // The Modelfile also carries the persona, so a change there rebuilds too.
    const persona = createHash("sha256");
    for (const source of ["lib/personality.ts", "lib/character-profile.ts", "scripts/build-modelfile.mjs"]) {
      persona.update(readFileSync(join(root, source), "utf8").replace(/\r\n/g, "\n"));
    }
    const fingerprint = persona.digest("hex").slice(0, 16);
    const built = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : {};
    const modelExists = spawnSync("ollama", ["show", "freya"], { stdio: "ignore" }).status === 0;
    if (!modelExists || built.size !== size || built.mtimeMs !== mtimeMs || built.persona !== fingerprint || (forcedFormat && built.format !== forcedFormat)) {
      const architecture = ggufArchitecture(trained);
      const format = forcedFormat || (architecture.startsWith("qwen35") ? "qwen3.5" : architecture.startsWith("qwen") ? "chatml" : "");
      if (!format) {
        say(`freya-trained.gguf is a "${architecture || "unknown"}" model; start with --format qwen3.5 or --format chatml.`);
        process.exit(1);
      }
      say(`Building FREYA from freya-trained.gguf (${architecture}, ${format} format; local, no download)...`);
      if (npm(["run", "ollama:create", "--", "--base", trained, "--format", format]).status !== 0) process.exit(1);
      writeFileSync(marker, JSON.stringify({ size, mtimeMs, format, persona: fingerprint }));
    } else {
      say("Local model: FREYA (fine-tuned) is up to date");
    }
  }
}

// 5. The app
const url = "http://localhost:3000";
if (production) {
  say("Building for production...");
  if (npm(["run", "build"]).status !== 0) process.exit(1);
  say(`Open ${url}   (Ctrl+C to stop)`);
  process.exit(npm(["run", "start:local"]).status ?? 0);
}
say(`Open ${url} once it says "Ready"   (Ctrl+C to stop)\n`);
process.exit(npm(["run", "dev"]).status ?? 0);

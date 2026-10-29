// One-command setup and health check, the same on Windows, macOS and Linux.
//
//   npm run setup            install, create .env.local, build the local model, then check
//   npm run setup -- --skip-model    the same without the ~3.4 GB local model
//   npm run doctor           check only; changes nothing
//
// Plain Node with no dependencies, so it runs before `npm install` has.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const checkOnly = process.argv.includes("--check");
const skipModel = process.argv.includes("--skip-model");
const windows = process.platform === "win32";
const ok = (text) => console.log(`  [ok] ${text}`);
const warn = (text) => console.log(`  [--] ${text}`);
const bad = (text) => console.log(`  [!!] ${text}`);
let problems = 0;

function run(command, args, options = {}) {
  // npm/npx are .cmd shims on Windows and need a shell; the arguments here are fixed, not user input.
  return spawnSync(command, args, { cwd: root, stdio: "inherit", shell: windows && /^(npm|npx)$/.test(command), ...options });
}

/** KEY=value pairs from .env then .env.local (local wins), as Next.js loads them. */
function readEnv() {
  const values = {};
  for (const file of [".env", ".env.local"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
  return values;
}
const isSet = (value) => Boolean(value) && !/^(replace_me|your_|YOUR_)/.test(value);

console.log(`\nFREYA ${checkOnly ? "doctor" : "setup"}\n`);

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) ok(`Node.js ${process.versions.node}`);
else { bad(`Node.js ${process.versions.node}: version 20 or newer is required (https://nodejs.org)`); process.exit(1); }

// 2. Dependencies
const lock = join(root, "package-lock.json");
const installed = join(root, "node_modules", ".package-lock.json");
const stale = !existsSync(installed) || statSync(lock).mtimeMs > statSync(installed).mtimeMs;
if (!stale) ok("Dependencies installed");
else if (checkOnly) { bad("Dependencies missing or out of date: run `npm run setup`"); problems += 1; }
else {
  console.log("  Installing dependencies...");
  if (run("npm", ["ci", "--no-audit", "--no-fund"]).status !== 0) { bad("npm install failed"); process.exit(1); }
  ok("Dependencies installed");
}

// 3. Environment file
const local = join(root, ".env.local");
if (!existsSync(local) && !checkOnly) {
  copyFileSync(join(root, ".env.example"), local);
  // On your own machine there is no hosting edge to identify visitors, so the single-owner
  // mode is what makes chat work out of the box. Never for a public deployment.
  appendFileSync(local, "\n# Added by setup: running on your own machine.\nFREYA_SELF_HOSTED=true\n");
  ok("Created .env.local from .env.example (it is git-ignored; put your keys there)");
}
const env = readEnv();
const chatKeys = ["GROQ_API_KEY", "GEMINI_API_KEY"].filter((name) => isSet(env[name]));
if (chatKeys.length) ok(`Chat provider key(s): ${chatKeys.join(", ")}`);
else { bad("No chat provider key: add GROQ_API_KEY (or GEMINI_API_KEY) to .env.local"); problems += 1; }
if (!isSet(env.GROQ_API_KEY) || !isSet(env.GEMINI_API_KEY)) warn("Reasoning panel works best with both GROQ_API_KEY and GEMINI_API_KEY");
if (!isSet(env.TAVILY_API_KEY)) warn("No TAVILY_API_KEY: web search falls back to Gemini grounding only");
if (!isSet(env.GEMINI_API_KEY)) warn("No GEMINI_API_KEY: images, PDFs and voice-note listening need it");

// 4. Local model
const ollama = spawnSync("ollama", ["--version"], { encoding: "utf8" });
if (ollama.status !== 0) {
  warn("Ollama not installed: optional, needed for the local model, Local-only mode and intimate chats (https://ollama.com/download)");
} else {
  ok(`Ollama ${ollama.stdout.trim().replace(/^ollama version is /, "")}`);
  const model = env.OLLAMA_MODEL || "freya";
  const hasModel = () => spawnSync("ollama", ["show", model], { stdio: "ignore" }).status === 0;
  if (hasModel()) ok(`Local model "${model}" is ready`);
  else if (checkOnly || skipModel) warn(`Local model "${model}" not built yet: run \`npm run ollama:create\` (~3.4 GB download the first time)`);
  else {
    console.log(`  Building local model "${model}" (downloads ~3.4 GB the first time)...`);
    if (run("npm", ["run", "ollama:create"]).status === 0 && hasModel()) ok(`Local model "${model}" is ready`);
    else { bad("Building the local model failed: see the output above, then `npm run ollama:create`"); problems += 1; }
  }
}

// 5. Optional pieces
if (isSet(env.NEXT_PUBLIC_SUPABASE_URL)) ok("Supabase cloud memory configured");
else warn("Supabase not configured: memories stay in this browser (optional)");
if (isSet(env.FREYA_SERVICE_URL)) warn("FREYA_SERVICE_URL is set: start the Python service too (see README)");

console.log(problems
  ? `\n${problems} thing(s) to fix above. Then: npm run dev\n`
  : `\nReady. Start FREYA with:  npm run dev   then open http://localhost:3000\n`);
process.exit(problems ? 1 : 0);

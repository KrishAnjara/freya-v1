// Builds FREYA's Modelfile and creates the Ollama model: the same command on every OS.
//
//   npm run ollama:create
//   npm run ollama:create -- --base training/freya-gguf/freya-trained.gguf --name freya-trained
//   npm run ollama:create -- --base qwen3.5:4b
//
// --base   an Ollama model name or a local .gguf file (default: Qwen3.5 4B abliterated)
// --name   the model to create (default: freya, the one the app uses)
// --adapter a LoRA adapter to layer on top (optional)
// --format  chat format for a local .gguf: qwen3.5 (default) or chatml (Qwen2.5, Qwen3 instruct)
// --no-examples  leave out the MESSAGE examples (for a model fine-tuned on them)
//
// Any --name other than "freya" is a candidate: its Modelfile goes to a temp file, so building
// one for comparison never rewrites ollama/Modelfile.
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BASE, MODELFILE_PATH, writeModelfile } from "./build-modelfile.mjs";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const name = option("name", "freya");
const base = option("base", process.env.FREYA_BASE_MODEL || DEFAULT_BASE);
const adapter = option("adapter", process.env.FREYA_ADAPTER || "");
const format = option("format", process.env.FREYA_CHAT_FORMAT || "qwen3.5");

const examples = !process.argv.includes("--no-examples");
const path = name === "freya" ? MODELFILE_PATH : join(tmpdir(), `${name.replace(/[^\w.-]/g, "_")}.Modelfile`);

const result = await writeModelfile({ base, adapter, format, examples, path });
console.log(`Modelfile: base ${result.base}, ${result.examples} example messages. Creating "${name}"...`);

// A library base must be present first; `ollama create` does not download it.
const isLocalFile = /\.gguf$/i.test(result.base) && /[\\/]/.test(result.base);
if (!isLocalFile) {
  const listed = spawnSync("ollama", ["show", result.base], { stdio: "ignore" });
  if (listed.status !== 0) {
    console.log(`Downloading ${result.base} (first time only)...`);
    const pull = spawnSync("ollama", ["pull", result.base], { stdio: "inherit" });
    if (pull.status !== 0) process.exit(pull.status ?? 1);
  }
}

const created = spawnSync("ollama", ["create", name, "-f", result.path], { stdio: "inherit" });
if (created.error) {
  console.error("Could not run `ollama`. Install it from https://ollama.com/download and try again.");
  process.exit(1);
}
process.exit(created.status ?? 1);

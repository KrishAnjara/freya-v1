// Builds training/freya_puter_server.ipynb: FREYA's Puter server (training/serve_puter.py, with
// serve_remote.py and puter_bridge.mjs it uses), whole inside the notebook, so it works without a
// git push: upload it to Colab and run it. The GPU server's notebook (freya_server.ipynb) is separate.
//
//   node scripts/build-puter-notebook.mjs
import { readFileSync, writeFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../training/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const files = ["serve_remote.py", "serve_puter.py", "puter_bridge.mjs"];
const lines = (text) => text.split("\n").map((line, index, all) => (index < all.length - 1 ? `${line}\n` : line)).filter((line) => line !== "");

// One switch per provider, and only the model settings that matter. Keys come from Colab Secrets
// (the key icon on the left), never from the notebook: PUTER_AUTH_TOKEN, and HF_TOKEN if needed.
const settings = `#@title Start FREYA's Puter server
#@markdown **Her voice through Puter** (Qwen3.8 27B Uncensored, then uncensored fallbacks). Needs the \`PUTER_AUTH_TOKEN\` secret.
PUTER_VOICE = True  #@param {type:"boolean"}
#@markdown Puter models for her voice, in order, comma-separated. Empty = the defaults.
PUTER_MODELS = ""  #@param {type:"string"}
#@markdown **Her eyes through Puter**: reads the pictures you send.
PUTER_VISION = True  #@param {type:"boolean"}
#@markdown **Local voice** on this machine's CPU, after every Puter model (slow; a last resort).
LOCAL_VOICE = False  #@param {type:"boolean"}
LOCAL_VOICE_MODEL = "huihui_ai/qwen3-abliterated:4b"  #@param {type:"string"}
#@markdown **Local eyes** on the CPU (Gemma 3 4B), after Puter's.
LOCAL_VISION = True  #@param {type:"boolean"}
#@markdown **Pictures**: Qwen-Image 2.1 uncensored draws; **face pass**: SDXL redraws her face from her real photo. ~30 GB, downloaded in the background. Needs a GPU (L4 or A100 best; a T4 is slow).
IMAGES = True  #@param {type:"boolean"}
FACE_FIX = True  #@param {type:"boolean"}
IMAGE_STEPS = 20  #@param {type:"slider", min:8, max:50, step:1}
#@markdown **Prompt maker** on the CPU (a small uncensored model). Off: simple rules write the prompt.
PROMPT_MAKER = True  #@param {type:"boolean"}
#@markdown **Memory by meaning** (a small embedding model on the CPU).
MEMORY = True  #@param {type:"boolean"}
#@markdown **Key**: empty = the key saved from the last run. **Keep on Google Drive**: the key, kept pictures and downloads survive a new runtime.
TOKEN = ""  #@param {type:"string"}
KEEP_ON_DRIVE = False  #@param {type:"boolean"}

import os, sys, pathlib
for secret in ("HF_TOKEN", "PUTER_AUTH_TOKEN"):
    try:
        from google.colab import userdata
        os.environ[secret] = userdata.get(secret) or ""
    except Exception:
        pass  # Not set: Puter asks for it below; HF_TOKEN isn't needed for the defaults.
sys.argv = ["serve_puter.py", "--puter-models", PUTER_MODELS if PUTER_VOICE else "none", "--vision-models", "" if PUTER_VISION else "none",
            "--local-voice", LOCAL_VOICE_MODEL if LOCAL_VOICE else "none", "--local-vision", "gemma3:4b" if LOCAL_VISION else "none",
            "--enhancer", "huihui_ai/qwen3-abliterated:1.7b" if PROMPT_MAKER else "none", "--embed-model", "nomic-embed-text" if MEMORY else "none"]
sys.argv += (["--images", "--image-steps", str(IMAGE_STEPS)] if IMAGES else []) + ([] if FACE_FIX else ["--no-face-fix"]) + (["--token", TOKEN] if TOKEN else [])
if KEEP_ON_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    sys.argv += ["--state-dir", "/content/drive/MyDrive/freya-puter", "--cache-on-drive"]
`;

const unpack = `FILES = {
${files.map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(read(name))},`).join("\n")}
}
folder = pathlib.Path("/content/freya")
folder.mkdir(exist_ok=True)
for name, text in FILES.items():
    (folder / name).write_text(text, encoding="utf-8")
sys.path.insert(0, str(folder))
import importlib
import serve_remote, serve_puter
importlib.reload(serve_remote)
importlib.reload(serve_puter)
serve_puter.main()
`;

export const notebook = {
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: lines(`# FREYA's Puter server on Colab

Her voice runs through **Puter.js** (Qwen3.8 27B Uncensored, then uncensored fallbacks), so it needs no GPU and she keeps talking while a picture draws. The GPU draws her pictures: **Qwen-Image 2.1 uncensored**, then **SDXL** redraws her face from her real photo. A small model on the CPU writes the picture prompts. Every provider has its own switch in the form below. The GPU-only server (\`freya_server.ipynb\`) is separate and unchanged.

1. **Puter key**: sign in at puter.com, copy your auth token (Account), and add it in Colab's **Secrets** (key icon on the left) as \`PUTER_AUTH_TOKEN\`, with notebook access on.
2. **Runtime > Change runtime type**: an L4 or A100 GPU for pictures. With pictures off, a CPU runtime is enough.
3. Choose the switches in the cell below and run it. The first picture setup downloads ~30 GB in the background; chat works before that.
4. Copy the line it prints and run it on your laptop, in the freya-v1 folder.
5. Keep this tab open. To stop, interrupt the cell.

Pictures and their prompts are kept on the server (\`freya-puter/pictures\` with Keep on Google Drive). Sexual content involving anyone under 18 is refused, whatever the settings.

[Colab's rules](https://research.google.com/colaboratory/faq.html) prohibit web services unrelated to interactive compute, so Google can end a session like this. Puter's terms apply to what goes through it. This runs through Google, Puter and Cloudflare, so it isn't private.
`),
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { cellView: "form" },
      outputs: [],
      source: lines(`${settings}\n${unpack}`),
    },
  ],
  metadata: {
    accelerator: "GPU",
    colab: { name: "freya_puter_server.ipynb", gpuType: "L4" },
    kernelspec: { display_name: "Python 3", name: "python3" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

if (process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`).href === import.meta.url) {
  writeFileSync(new URL("../training/freya_puter_server.ipynb", import.meta.url), `${JSON.stringify(notebook, null, 1)}\n`);
  console.log("training/freya_puter_server.ipynb written.");
}

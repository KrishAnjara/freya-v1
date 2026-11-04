// Builds training/freya_server.ipynb from training/serve_remote.py, so the notebook holds the whole
// script and works without a git push: upload it to Colab and run it.
//
//   node scripts/build-server-notebook.mjs
import { readFileSync, writeFileSync } from "node:fs";

const script = readFileSync(new URL("../training/serve_remote.py", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const lines = (text) => text.split("\n").map((line, index, all) => (index < all.length - 1 ? `${line}\n` : line)).filter((line) => line !== "");

// Colab form fields, turned into the script's arguments. The Hugging Face token comes from Colab
// Secrets (the key icon on the left), never from the notebook itself.
const settings = `#@title Start FREYA's server
#@markdown **Her voice.** Empty = SexyGPT v3 Thinking (Qwen3.8 27B roleplay fine-tune, 16.8 GB: whole on an L4/A100, partly on the CPU on a T4). Or e.g. \`hf.co/DavidAU/Dark-Forest-V1-Ultra-Quality-20b-GGUF:Q3_K_L\` (the old default, fits a T4), or your fine-tune: \`hf:YOU/REPO/file.gguf\`.
MODEL = ""  #@param {type:"string"}
#@markdown **Helper model**: her fallback voice, her eyes for images and the picture prompt maker ("none" to skip).
FALLBACK_MODEL = "huihui_ai/qwen3.5-abliterated:4B"  #@param {type:"string"}
#@markdown **Memory by meaning**: a small embedding model ("none" to skip).
EMBED_MODEL = "nomic-embed-text"  #@param {type:"string"}
#@markdown **Pictures**, sized to the GPU: A100 (40 GB+) uses Qwen-Image-Edit 2511 + NSFW LoRA; a T4 or L4 uses RealVisXL (SDXL) + IP-Adapter Face, loaded at the first picture (her voice is paused while it draws). Pictures of her keep her face; the helper writes the full prompt.
IMAGES = True  #@param {type:"boolean"}
IMAGE_STEPS = 28  #@param {type:"slider", min:8, max:50, step:1}
#@markdown Keep the same key between sessions (leave empty for a new one each time):
TOKEN = ""  #@param {type:"string"}

import os, sys
try:
    from google.colab import userdata
    os.environ["HF_TOKEN"] = userdata.get("HF_TOKEN") or ""
except Exception:
    pass  # No secret set: public models only, which is all the defaults need.
sys.argv = ["serve_remote.py", "--fallback-model", FALLBACK_MODEL or "none", "--embed-model", EMBED_MODEL or "none"]
sys.argv += (["--model", MODEL] if MODEL else []) + (["--images", "--image-steps", str(IMAGE_STEPS)] if IMAGES else []) + (["--token", TOKEN] if TOKEN else [])
`;

export const notebook = {
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: lines(`# FREYA's server on Colab

Runs her models on Colab's GPU, so your laptop runs no model at all: her voice (SexyGPT v3 Thinking, a Qwen3.8 27B roleplay model), a helper model (her fallback voice, her eyes for images, and the picture prompt maker), an embedding model for her memory, and optionally pictures (Qwen-Image-Edit 2511 with an NSFW LoRA, keeping her face). All behind one login and one address.

1. **Runtime > Change runtime type**: A100 GPU with High-RAM is best (her voice whole, pictures on). L4 runs her voice whole. A free T4 works for chat only, and slower.
2. Optional: **Secrets** (key icon on the left) → add \`HF_TOKEN\` if you use a private model of your own from Hugging Face.
3. Choose the settings in the cell below and run it. The first download takes several minutes.
4. Copy the line it prints and run it on your laptop, in the freya-v1 folder.
5. Keep this tab open. To stop, interrupt the cell. When the session ends she falls back (Grok, Gemini or Groq, if \`cloudFallback\` is on in freya.config.json) until you run this again; her memory is on your laptop, so nothing is lost.

**What each GPU can do:** her voice is 16.8 GB. A T4 (15 GB) holds most of it and runs the rest on the CPU: it works, slowly. An L4 (24 GB) holds her voice whole. On a T4 or L4 pictures use the smaller SDXL model (about a minute or two each); an A100 (40/80 GB, High-RAM) runs Qwen-Image-Edit; below 80 GB a picture briefly unloads her voice and the next message takes longer. Pictures run as background jobs and take one to several minutes. Embeddings run on the CPU. Sessions end after some hours, and a GPU isn't guaranteed.

**Licences:** check each model's card on Hugging Face (SexyGPT v3 is Apache-2.0; Qwen-Image-Edit 2511 is Apache-2.0; the LoRA has its own terms). Sexual content involving anyone under 18 is refused by the image server, whatever the settings.

**Please read this first.** [Colab's rules](https://research.google.com/colaboratory/faq.html) prohibit web services unrelated to interactive compute, so Google can end a session like this or act on your account. Free sessions last 12 hours at most, usually less, and free GPUs aren't guaranteed. This runs on Google's machine and through Cloudflare, so it isn't private. For anything you rely on, rent a GPU and run \`training/serve_remote.py\` there.

The model has no trained refusals. The app checks what it writes, and those checks only apply to replies that go through the app.
`),
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { cellView: "form" },
      outputs: [],
      source: lines(`${settings}\n${script}`),
    },
  ],
  metadata: {
    accelerator: "GPU",
    colab: { name: "freya_server.ipynb", gpuType: "T4" },
    kernelspec: { display_name: "Python 3", name: "python3" },
    language_info: { name: "python" },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

if (process.argv[1] && new URL(`file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`).href === import.meta.url) {
  writeFileSync(new URL("../training/freya_server.ipynb", import.meta.url), `${JSON.stringify(notebook, null, 1)}\n`);
  console.log("training/freya_server.ipynb written.");
}

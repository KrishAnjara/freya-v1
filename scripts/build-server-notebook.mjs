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
#@markdown **Her model.** Empty picks the largest uncensored Qwen 27B that fits this GPU. For your own fine-tune: \`hf:YOU/REPO/file.gguf\`.
MODEL = ""  #@param {type:"string"}
#@markdown **Fallback** if the big model fails inside the session ("none" to skip). Your fine-tune works here too.
FALLBACK_MODEL = "huihui_ai/qwen3.5-abliterated:4B"  #@param {type:"string"}
#@markdown **Memory by meaning**: a small embedding model ("none" to skip).
EMBED_MODEL = "nomic-embed-text"  #@param {type:"string"}
#@markdown **Pictures** (SDXL + Lightning). ~7 GB download in the background; on a T4 a picture briefly unloads her text model.
IMAGES = True  #@param {type:"boolean"}
#@markdown Keep the same key between sessions (leave empty for a new one each time):
TOKEN = ""  #@param {type:"string"}

import os, sys
try:
    from google.colab import userdata
    os.environ["HF_TOKEN"] = userdata.get("HF_TOKEN") or ""
except Exception:
    pass  # No secret set: public models only, which is all the defaults need.
sys.argv = ["serve_remote.py", "--fallback-model", FALLBACK_MODEL or "none", "--embed-model", EMBED_MODEL or "none"]
sys.argv += (["--model", MODEL] if MODEL else []) + (["--images"] if IMAGES else []) + (["--token", TOKEN] if TOKEN else [])
`;

export const notebook = {
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: lines(`# FREYA's server on Colab

Runs her models on Colab's GPU, so your laptop runs no model at all: her voice (an uncensored Qwen 27B that also sees images), a smaller fallback, an embedding model for her memory, and optionally pictures. All behind one login and one address.

1. **Runtime > Change runtime type > T4 GPU**
2. Optional: **Secrets** (key icon on the left) → add \`HF_TOKEN\` if you use a private model of your own from Hugging Face.
3. Choose the settings in the cell below and run it. The first download takes several minutes.
4. Copy the line it prints and run it on your laptop, in the freya-v1 folder.
5. Keep this tab open. To stop, interrupt the cell. When the session ends she falls back (Grok, Gemini or Groq, if \`cloudFallback\` is on in freya.config.json) until you run this again; her memory is on your laptop, so nothing is lost.

**What a free T4 can do:** about 15 GB of GPU memory. The 27B takes ~14 GB, so the fallback model and pictures can't sit beside it: a picture unloads her text model for a moment, and the first message after it takes 20-40 s longer. Embeddings run on the CPU. Sessions last 12 hours at most, often less, and a GPU isn't guaranteed.

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

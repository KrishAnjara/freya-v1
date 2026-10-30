// Builds training/freya_server.ipynb from training/serve_remote.py, so the notebook holds the whole
// script and works without a git push: upload it to Colab and run it.
//
//   node scripts/build-server-notebook.mjs
import { readFileSync, writeFileSync } from "node:fs";

const script = readFileSync(new URL("../training/serve_remote.py", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const lines = (text) => text.split("\n").map((line, index, all) => (index < all.length - 1 ? `${line}\n` : line)).filter((line) => line !== "");

export const notebook = {
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: lines(`# FREYA's voice on Colab

Runs her model on Colab's GPU, so your laptop runs no model at all.

1. **Runtime > Change runtime type > T4 GPU**
2. Run the cell below. The first download takes several minutes.
3. Copy the line it prints and run it on your laptop, in the freya-v1 folder.
4. Keep this tab open. When the session ends she falls back to Groq until you run this again, and you'll get a new line to run.

**Please read this first.** [Colab's rules](https://research.google.com/colaboratory/faq.html) prohibit web services unrelated to interactive compute, so Google can end a session like this or act on your account. Free sessions last 12 hours at most, usually less, and free GPUs aren't guaranteed. This runs on Google's machine and through Cloudflare, so it isn't private. For anything you rely on, rent a GPU and run \`training/serve_remote.py\` there.

The model has no trained refusals. The app checks what it writes, and those checks only apply to replies that go through the app.
`),
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: { cellView: "form" },
      outputs: [],
      source: lines(`#@title Start FREYA's voice\n${script}`),
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

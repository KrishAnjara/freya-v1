# Setting up FREYA

The short version: start the server notebook on Colab, run the line it prints on your laptop, open
http://localhost:3000. Everything else here is detail for when you want it.

## 1. On your laptop (once)

```bash
npm run setup          # installs, creates .env.local, checks keys
```

Put at least `GROQ_API_KEY` in `.env.local`; `GEMINI_API_KEY`, `XAI_API_KEY` and `TAVILY_API_KEY`
add more (see `.env.example`). Nothing is downloaded to the laptop for her models: they run on Colab.

## 2. Her models on Colab: `training/freya_server.ipynb`

| | |
|---|---|
| **What it does** | Runs her voice, a fallback model, an embedding model for memory and (optionally) pictures on Colab's GPU, behind one login and one Cloudflare address |
| **Configure** | The form at the top of the cell: `MODEL` (empty = automatic), `FALLBACK_MODEL`, `EMBED_MODEL`, `IMAGES`, `TOKEN`. Optional: Colab **Secrets** → `HF_TOKEN` for a private model of yours |
| **Downloads** | `huihui_ai/Qwen3.8-abliterated:27b` (q4_K_M on 20 GB+, q3_K on a T4; ~14 GB; text + vision), `huihui_ai/qwen3.5-abliterated:4B` (fallback, 3.3 GB), `nomic-embed-text` (0.3 GB), and with pictures `stabilityai/stable-diffusion-xl-base-1.0` + `ByteDance/SDXL-Lightning` 4-step LoRA (~7 GB, both openrail++) |
| **GPU** | A free T4 (15 GB) works. The 27B fills it, so a picture unloads her text model for a moment (the next reply takes 20-40 s longer); embeddings run on the CPU. A 24 GB GPU holds everything at once |
| **Start** | Runtime → Change runtime type → T4 GPU, then run the cell. First start: 5-15 min (downloads); later starts in the same session are quick |
| **Connect** | Copy the printed line and run it in the freya-v1 folder: `start.bat --remote https://….trycloudflare.com --key …`. It also picks up the fallback and embedding models. Add `--laptop` to let this laptop's own `freya` answer if the server goes away |
| **Stop** | Interrupt the cell. The laptop falls back (see the chain below) until you start it again; memory stays on the laptop |

Why one notebook and not three: a free account gets one GPU at a time, so text, vision, embeddings and
pictures share one server and one address. The app talks to it without knowing which model answers.

## 3. Her fallback voice, fine-tuned: `training/freya_colab.ipynb`

| | |
|---|---|
| **What it does** | QLoRA fine-tune (Unsloth, base loaded in 4-bit, LoRA on the language layers) of an uncensored Qwen3.5 4B or 9B on FREYA's replies; tests her with the persona evaluation; saves to Drive; optionally uploads to Hugging Face |
| **Configure** | `BASE_MODEL` (4B or 9B), `EPOCHS`, `LEARNING_RATE`, `RANK`, `MAX_SEQ`, `HF_REPO` + `HF_PRIVATE`, `MERGED`, `SMOKE_TEST`, `UPLOAD_OWN_DATA`. For uploads: Secrets → `HF_TOKEN` (a *write* token) |
| **Downloads** | `huihui-ai/Huihui-Qwen3.5-4B-abliterated` or `-9B-abliterated` from Hugging Face, plus Unsloth, TRL and datasets |
| **GPU** | A T4 trains the 4B and the 9B at 4-bit with `MAX_SEQ` 2048. A 27B needs 24 GB+ |
| **Start** | Run the cell; it mounts Drive. 15-40 minutes. Cut off? Run it again: checkpoints are on Drive and it resumes |
| **Your data** | `training/conversation-template.jsonl` shows the format: one conversation per line, ending with FREYA. Copy it into `training/data/` under a new name, or tick `UPLOAD_OWN_DATA`. Every file is validated against the hard limits; problems stop the run with line numbers |
| **Saves** | Drive: `MyDrive/freya/freya-trained.gguf` (merged, q4_k_m, for Ollama), `lora/` (the adapter), `checkpoints/`; with `MERGED`, a 16-bit merged model. With `HF_REPO`: the same, plus a model card, in your Hugging Face repo |
| **Use it** | In the server notebook: `FALLBACK_MODEL = hf.co/USER/NAME` (public repo), or `MODEL = hf:USER/NAME/freya-trained.gguf` (private works with `HF_TOKEN`), or a Drive path. Then `npm run bakeoff` compares it blind against the stock model |

What fine-tuning does and doesn't do: it changes how she sounds, not what she knows or who she is. Her
persona (`lib/personality.ts`), memory (`data/freya-memory.db`) and the conversation come from the app
on every message, whichever model answers. That's why it's her fallback voice and the 27B leads.

## 4. Who answers: the chain

```
1 Colab: her 27B           (own model: sees images; every kind of turn)
2 Colab: fallback model    (own model: when the 27B fails inside the session)
3 this laptop              (own model: only with start --remote --laptop)
4 Grok → Gemini → Groq     (cloud: AI_FALLBACK_PROVIDER order; only with cloudFallback on)
```

Intimate turns and Local-only mode never reach step 4. Settings → Models & status shows each step live.

## 5. Settings

Everything in Settings changes real behaviour. Browser settings can narrow what `freya.config.json`
allows but never widen it.

| Where | Setting | What it does |
|---|---|---|
| `freya.config.json` | `cloudFallback` | Cloud models may answer when hers are down |
| `freya.config.json` | `externalFiles` | Grok/Gemini may read your images and PDFs |
| `freya.config.json` | the others | See the README's switch table |
| Settings → Presence | Expressions | Off / subtle / natural / expressive: how much her portrait shows |
| Settings → Presence | Canvas quality | Auto (steps down on a slow machine) / low / high |
| Settings → Memory | Use memories, Remember automatically | Whether memory goes into replies, and is kept |
| Settings → Memory | What FREYA remembers | Search, edit, delete notes; past-conversation recaps; forget everything |
| Settings → Privacy | Let Grok or Gemini read attachments | This browser's own off switch for `externalFiles` |
| Settings → Privacy | Cloud fallback | This browser's own off switch for `cloudFallback` |
| Settings → Privacy | Local-only | Only this computer's model, nothing leaves it |
| Settings → Models & status | Who answers, and is it up? | The chain, live: reachable, skipped (and why), sees images |

## 6. Models used, and why

| Role | Model | Licence | Why this one |
|---|---|---|---|
| Voice (Colab) | `huihui_ai/Qwen3.8-abliterated:27b` (Ollama) | Apache-2.0 (checked on Hugging Face) | Strongest that fits a T4 at q3_K; refusal direction removed without a fine-tune, so reasoning is intact; vision, tools and thinking (per Ollama's model page) |
| Fallback / fine-tune base | `huihui-ai/Huihui-Qwen3.5-4B/9B-abliterated` | Apache-2.0 | Same family and chat format as the voice, so a fine-tune keeps her style; trains on a free T4 |
| Embeddings | `nomic-embed-text` (Ollama) | Apache-2.0 | Small (0.3 GB), runs on the CPU beside the 27B |
| Pictures | `stable-diffusion-xl-base-1.0` + `SDXL-Lightning` 4-step LoRA | openrail++ | Ungated, 4 steps (a few seconds a picture once loaded; an estimate, not measured here), image-to-image for edits and variations. FLUX.1-schnell (Apache-2.0) draws better but is gated and needs ~24 GB |
| Cloud | Grok (`XAI_MODEL`), Gemini (`GEMINI_MODEL`), Groq (`GROQ_MODEL`) | provider terms | Research, reasoning, describing attachments, fallback voice |

An "abliterated" model has had its refusal behaviour removed. The app enforces the hard limits
itself, on what you send and on what the model writes (`lib/reply-guard.ts`, `lib/intimacy.ts`,
`lib/crime-limit.ts`, `lib/honesty.ts`), so they hold whichever model answers.

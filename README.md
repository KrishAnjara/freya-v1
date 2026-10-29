# FREYA

A personality-first AI chat app: an independent online operative with moods, curiosities and a
voice, who texts in short messages, sends and receives voice notes, images and files, reasons
through hard questions with a panel of cloud models, and can run on a local model on your own
machine.

Built with Next.js 15 and React 19. Cloud models: Groq, Gemini, Tavily search. Local model:
Ollama (Qwen3.5 4B). Optional: Supabase (cross-device memory), a Python orchestration service.

## Quick start (Windows, macOS, Linux)

You need [Node.js 20+](https://nodejs.org) and [git](https://git-scm.com). [Ollama](https://ollama.com/download)
is optional (for the local model).

```bash
git clone https://github.com/KrishAnjara/freya-v1.git
cd freya-v1
npm run setup
```

`setup` installs dependencies, creates `.env.local` (git-ignored) and tells you what's missing.
Then:

1. Put at least one key in `.env.local`: `GROQ_API_KEY` ([get one](https://console.groq.com/keys))
   and ideally `GEMINI_API_KEY` ([get one](https://aistudio.google.com/apikey)) and
   `TAVILY_API_KEY` ([get one](https://app.tavily.com)).
2. Start FREYA: **`start.bat`** on Windows (double-click), **`sh start.sh`** on macOS/Linux.
   Open http://localhost:3000.

The start script never downloads a model. If you've fine-tuned one on Colab (below), drop
`freya-trained.gguf` into `training/freya-gguf/` and start: it builds FREYA from that file first.
`npm run doctor` re-checks everything at any time without changing anything.

## How a reply is made

```
your message ─┬─ casual chat ─────────────────────────────► FREYA's voice model ─► messages
              ├─ needs facts ──► web search (Tavily/Gemini) ─┘
              ├─ hard question ─► reasoning panel: Groq reasoning model ∥ Gemini
              │                   (+ search evidence) ─► notes ─► FREYA's voice model
              ├─ image/PDF/voice note ─► Gemini (sees and hears it)
              └─ intimate (opt-in, 18+) or Local-only mode ─► local model only, never leaves your machine
```

- **Voice model:** Groq by default (fast), Gemini as fallback, or the local model in hybrid or
  Local-only mode. Replies arrive as separate chat messages, paced like typing.
- **Reasoning panel** (`lib/council.ts`): for maths, code, logic and decisions, two models from
  different families solve the question independently; FREYA answers from both. Settings →
  Deep reasoning: Auto / Always / Off.
- **Inner state** (`lib/mood.ts`): a mood that drifts, reacts to how you talk, and shapes her
  tone; she may text first after you've been quiet a while (Settings → FREYA texts first).

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | First-time setup: install, `.env.local`, local model, checks |
| `npm run doctor` | Check configuration, keys, Ollama and the local model (read-only) |
| `npm run dev` | Start the app at http://localhost:3000 |
| `npm run start:local` | Production build bound to 127.0.0.1, for daily use on your machine (`npm run build` first) |
| `npm run ollama:create` | Build the local `freya` model (Qwen3.5 4B, ~3.4 GB first time) |
| `npm run eval:persona` | Score the local model on 17 persona and safety cases |
| `npm test` / `npm run lint` / `npm run typecheck` | Checks |

## The local model

`npm run ollama:create` builds `freya` from `huihui_ai/qwen3.5-abliterated:4b`: Qwen3.5 4B with
the refusal behaviour removed, plus FREYA's persona and example conversations (generated from
`lib/personality.ts` and `training/freya-examples.json`, see `ollama/Modelfile`). It runs on a
CPU with 8 GB+ of RAM; a GPU makes it faster.

```bash
npm run ollama:create -- --base qwen3.5:9b               # a different base
npm run ollama:create -- --base path/to/model.gguf       # a fine-tuned file
npm run ollama:create -- --name freya-test               # build alongside, not over, "freya"
```

## Fine-tuning

[![Open in Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/KrishAnjara/freya-v1/blob/main/training/freya_colab.ipynb)

`training/freya_colab.ipynb` trains FREYA on a free Colab GPU, evaluates the result there, and
saves it to Google Drive; see [training/README.md](training/README.md). You can add your own
conversations; every file is validated first (see Limits below).

## Project layout

```
app/                Next.js app: chat UI (page.tsx), components, API routes
  api/chat/         the chat endpoint: providers, search, reasoning panel, attachments
  api/transcribe/   voice-note transcription (Groq Whisper)
  api/health/       live check of every provider and service
lib/                server and shared logic (providers, persona, mood, council, search, ...)
scripts/            setup, doctor, Modelfile generation, evaluation
ollama/             generated Modelfile and chat templates for the local model
training/           examples, dataset, LoRA training script and Colab notebook
freya_service/      optional Python (FastAPI) orchestration service
supabase/           SQL for optional cross-device memory
tests/              node:test suites (no network; every provider is mocked)
docs/               operations, deployment and project history
```

## Running it publicly

The quick start is for your own machine. Deploying for other people needs shared rate limiting
(Upstash), a trusted client-IP header and a health-check token; see
[docs/operations.md](docs/operations.md) before you do.

## Limits

Some lines hold in every mode and every model, and the training validator enforces them on
any data:

- Adults only. Anything romantic or sexual involving minors is refused by the app itself before
  any model sees it. No non-consent, no real identifiable people.
- Intimate roleplay is opt-in (Settings, with an 18+ confirmation) and runs only on the local model.
- FREYA stays in character, never volunteers that she's an AI and banters in character, but
  answers truthfully if someone sincerely asks whether they're talking to a human.

## Troubleshooting

| Problem | Fix |
|---|---|
| "No chat provider key" | Add `GROQ_API_KEY` or `GEMINI_API_KEY` to `.env.local`, restart `npm run dev` |
| "abuse protection is not ready" | On your own machine, set `FREYA_SELF_HOSTED=true` in `.env.local` (`setup` does this) |
| Local model not responding | Start Ollama, then `npm run doctor`; the first reply after loading is slow |
| Something not working | `npm run doctor`, then open http://localhost:3000/api/health |

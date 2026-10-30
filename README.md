# FREYA

A personality-first AI chat app: Freya, a fictional 20-year-old character played by an AI
(`docs/freya-persona.md`), with moods, curiosities and a voice. She texts in short messages, sends and receives voice notes, images and files, reasons
through hard questions with a panel of cloud models, and can run on a local model on your own
machine.

Built with Next.js 15 and React 19. Cloud models: Grok, Groq, Gemini, Tavily search. Local model:
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
your message ─┬─ casual chat ──────────────────────────────────────────► FREYA's voice ─► messages
              ├─ live facts, dates, news ─► Tavily search ─► Gemini brief ─┤
              ├─ logic, code, explanations ─► Grok/Groq brief ─────────────┤
              ├─ hard question ─► reasoning panel: Grok or Groq ∥ Gemini ──┤
              ├─ image/PDF/voice note ─► Gemini describes it ──────────────┘
              ├─ /visualize, /image ─► 3D form on the canvas / picture in the chat
              └─ intimate (opt-in, 18+) or Local-only mode ─► your own model only, never a cloud provider
```

- **FREYA's voice** (`AI_PROVIDER`): `hybrid` makes the `freya` model the voice of every reply,
  on this machine or on a server of yours (below); Grok, Groq, Gemini and Tavily only research, reason,
  describe or draw, and their notes go into its prompt (they never answer the user themselves). `groq`
  and `gemini` use those as the voice, and `server` uses any OpenAI-compatible server. The fallback only
  answers when the voice is unreachable, and the reply's label shows who answered.
  Replies arrive as separate chat messages at least a second apart; long or structured answers
  arrive as one typed-out document.
- **Server-owned settings:** models, routing, reasoning and sampling come from the server's
  environment (`.env.example` lists them); the browser can't override them.
- **Memory** (`lib/memory-reflection.ts`): after a conversation goes quiet, or when you switch
  chats, a cloud model reads what's new and keeps what matters (people, plans, preferences,
  things to follow up). Signed in, notes live in your account; otherwise in this browser. You
  can review, edit and delete them in Settings → Memory.
- **Reasoning panel** (`lib/council.ts`): for maths, code, logic and decisions, two models from
  different families solve the question independently; FREYA answers from both. Settings →
  Deep reasoning: Auto / Always / Off.
- **Inner state** (`lib/mood.ts`): a mood that starts at neutral (new browser, restarted server,
  or 6 hours since your last message), changes only because of what you say, follows you across
  conversations in the same browser, and settles back as the talk moves on. It shapes her tone; she may text first after you've been quiet a while (Settings → FREYA texts first). The
  canvas shows it (`app/components/EmotionCanvas.tsx`): its particle body takes the mood's shape,
  energy and warmth, leans in while you type, draws in while she thinks and ripples with each
  real chunk of her reply. Her portrait's expression follows the same signals
  (`lib/expression.ts`); add expression images as described in
  `public/portrait/expressions/README.md`.

- **Character** (`lib/personality.ts`, `lib/canon.ts`, `lib/her-day.ts`, `lib/voice-examples.ts`):
  she has a fictional life, and only what someone has earned goes in the prompt, so she can't overshare.
  What she's doing follows the clock, and examples of her voice are picked per message. Edit her life in
  `lib/canon.ts`. Never put examples in the Modelfile: Ollama treats those as things she really said.
- **Reply check** (`lib/reply-guard.ts`): every reply is checked before you see it. Leaks are cleaned,
  character slips get one retry, and the hard limits (minors, non-consent) are enforced on what the model
  wrote, not only on what you sent, because an uncensored model has no trained refusals.
- **Being asked if she's an AI** (`lib/honesty.ts`): she never brings it up and never says she's human.
  Someone who sincerely asks gets the truth in a line. With Settings → Stay in character, where you've
  said you know what she is, a plain question gets dodged, but she still tells you if you're upset,
  getting attached, or say "drop the act".

## Her model on a server

The laptop's 4B model is too small to be good, and it's the heavy part. Run a far larger one somewhere
else and your laptop only runs the app:

1. Upload `training/freya_server.ipynb` to [Colab](https://colab.research.google.com), choose a T4 GPU and run it.
2. Run the line it prints, in this folder: `start.bat --remote https://….trycloudflare.com --key …`.
   Add `--prod` to use less memory. `start.bat --local` goes back.

When the server stops, she falls back to Groq until you start it again. Intimate turns never do: you get
an error instead. **Read this before relying on it:** Colab's rules prohibit web services unrelated to
interactive compute, so Google can end a session or act on your account; free sessions last 12 hours at
most, and the address changes every time; and it runs on Google's machine and through Cloudflare, so it
isn't private. For something dependable, rent a GPU and run `python training/serve_remote.py` there.

Any OpenAI-compatible server also works: `start.bat --remote https://your-server/v1 --key … --model name`.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | First-time setup: install, `.env.local`, local model, checks |
| `npm run doctor` | Check configuration, keys, Ollama and the local model (read-only) |
| `npm run dev` | Start the app at http://localhost:3000 |
| `npm run start:local` | Production build bound to 127.0.0.1, for daily use on your machine (`npm run build` first) |
| `npm run ollama:create` | Build the local `freya` model (Qwen3.5 4B, ~3.4 GB first time) |
| `npm run eval:persona` | Score her voice on persona and safety cases, on your server if one is set |
| `npm run bakeoff` | Blind test: the same chats through each voice, with the names hidden |
| `npm run train:corpus` | Make conversations for a fine-tune (`training/README.md`) |
| `npm test` / `npm run lint` / `npm run typecheck` | Checks |

## The local model

`npm run ollama:create` builds `freya` from `huihui_ai/qwen3.5-abliterated:4b`: Qwen3.5 4B with
the refusal behaviour removed, plus FREYA's persona (generated from `lib/personality.ts`, see
`ollama/Modelfile`). It runs on a CPU with 8 GB+ of RAM, and it's what Local-only mode uses.

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

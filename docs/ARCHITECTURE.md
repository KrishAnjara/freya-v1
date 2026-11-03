# FREYA architecture

How FREYA is put together, what the audit on 2026-11-03 found, and why each change was made.
For setup see [SETUP.md](SETUP.md); for problems see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 1. The pieces

```
Browser (app/page.tsx)                       Next.js server (app/api/*)                     Models
─────────────────────                        ─────────────────────────                     ──────
chat thread, composer, edits ──── /api/chat ── persona + mood + memory + guard ─┐
settings, memory panel                         │  research/brief: Grok, Groq, Gemini       │
portrait (expression director)                 │  vision: own model sees, or a describer   │
presence canvas (WebGL)                        └─ voice chain ─────────────────────────────┤
voice notes ──────────────────── /api/transcribe (Groq Whisper)                            │
/image, Imagine ──────────────── /api/image ── image chain ────────────────────────────────┤
/visualize ───────────────────── /api/visualize (structured JSON → point cloud)            │
memory panel ─────────────────── /api/memory  ── memory store (SQLite, data/)              │
                                 /api/memory/reflect (extraction)                          │
status panel ─────────────────── /api/status  (provider chain state, no secrets)           │
                                                                                            │
   voice chain, in order:  1 Colab server  (Ollama: Qwen3.8 27B abliterated, vision) ◄──────┘
                           2 Colab fallback (same server, a smaller model, e.g. your fine-tune)
                           3 laptop Ollama  (only if it is already running; nothing is downloaded)
                           4 Grok · Gemini · Groq (only if the turn may leave your machines)
```

Everything the model sees is assembled on the server: the browser can restrict what is sent
(Local-only, no external files) but can never widen it. API keys live in `.env` / `.env.local`
on the server and in Colab Secrets on the GPU side; nothing secret reaches the browser.

## 2. Audit findings (2026-11-03)

### Working well, kept as is
- **Chat route** (`app/api/chat/route.ts`): validation, rate limits, persona assembly, the cloud
  "brief" that lets a small model answer beyond what it knows, the reasoning panel
  (`lib/council.ts`), search, honesty and hard limits, the reply guard, streaming with
  continuation past the token ceiling. Solid; changes there are additive.
- **Persona and character** (`lib/personality.ts`, `lib/canon.ts`, `lib/her-day.ts`,
  `lib/voice-examples.ts`, `lib/reply-guard.ts`). Already bans assistant voice ("great question",
  "I hope this helps"), repeats and copied lines. Not rewritten.
- **Mood** (`lib/mood.ts`, `lib/mood-appraisal.ts`): a bounded state machine with reasons,
  decay and cooldowns. Kept; it is now one input to expressions instead of driving them directly.
- **Memory extraction** (`lib/memory-reflection.ts`): typed notes (preference, person, event,
  project, interest, decision, open, joke), corrections by id, a forget list, credential filters,
  per-conversation recaps. Kept; it now feeds a real store.
- **Colab voice server** (`training/serve_remote.py` / `freya_server.ipynb`): picks a model that
  fits the GPU, token login, Cloudflare tunnel, self-test. Kept and extended.
- **Fine-tuning** (`training/train_lora.py`, `colab_run.py`, `freya_colab.ipynb`): Unsloth LoRA,
  data validator with the hard limits, persona evaluation, GGUF export. Kept and extended.
- **Edit, reply, react, continue, export, resend** in the thread: all present and working.

### Broken, disconnected or redundant
| Finding | Effect | Fix |
|---|---|---|
| Only one fallback: `resolveProviders` returns primary + one fallback | Colab down → straight to Groq; no second own-model tier, no laptop tier | Ordered **voice chain** with health probes (`lib/voice-chain.ts`) |
| `AI_FALLBACK_PROVIDER=grok` silently ignored | Grok could never answer; Groq answered instead | Grok is a voice adapter; the fallback setting takes an ordered list |
| Python service (`freya_service/`) | Duplicated provider routing in Python; bypassed for every hybrid turn; not started by any script; nothing listening on its port | **Removed** (backup in `backups/`). Its Python role moved to the Colab gateway, where Python is actually needed (diffusers) |
| Images always described by Gemini, even when FREYA's own model can see | Private photos left the machine unnecessarily; extra hop | Own model sees directly when it has vision (detected from Ollama `/api/show`), describer chain otherwise, `externalFiles` switch |
| Image generation only via Gemini (free keys: no quota → SVG fallback) | "Imagine" mostly drew SVGs | Colab image server (SDXL + Lightning, txt2img/img2img/variations) first |
| Memory lived only in browser `localStorage` (or Supabase when signed in) | Clearing site data erased her memory; retrieval was keyword-only over 5 notes; episodes limited to the 3 most recent chats | **Server memory store** (SQLite in `data/`), layered retrieval with BM25 + recency + kind + optional embeddings |
| Expressions: random reading face, thinking face, mood face and image variant on every message, glances as full image swaps every 25-70 s, timed variant swaps | The "spam" | **Expression director** (`lib/expression-director.ts`): neutral default, cue-based reactions, intensity, hold, cooldown, no repeats |
| Canvas: CPU sine waves per particle, hard `Math.sign` jag, a ripple per 80 ms of streamed text | Mechanical looping; reacted to every token | GPU shader with layered noise flow, lighting and depth; speech as a smoothed envelope; quality scaling |
| Gemini default model `gemini-2.5-flash` retired; Gemini 3 thinking on by default | 404s and 30 s timeouts | Fixed earlier the same day (`lib/gemini-config.ts`) |

### Honest limits that remain (Colab Free)
- A free Colab session ends after at most 12 hours (often sooner), the GPU is not guaranteed, and
  the tunnel address changes every run. The "Colab fallback" tier only helps when the big model
  fails *inside* a live session (out of memory on a long prompt, a crash, a timeout); when the
  session itself dies both Colab tiers go with it, and the laptop or cloud tiers answer.
- A T4 has ~15 GB. The 27B text model takes ~14 GB and SDXL needs ~9 GB while drawing, so they
  cannot sit side by side: the gateway unloads the text model for a picture and the next reply
  reloads it (~20-40 s). Only a 4B voice leaves room for both; a 24 GB GPU holds the 27B and
  pictures together. One free GPU means one notebook: the server notebook is also the
  multimodal one (text, vision, embeddings, pictures behind one address), because a second
  notebook couldn't get a GPU of its own at the same time.
- Colab's terms prohibit web services unrelated to interactive compute; Google can end such a
  session. This is documented in the notebook itself. For dependable use, rent a GPU and run the
  same script.
- PDFs need Gemini to be read (no local PDF reader is bundled). With `externalFiles` off, she
  says she can't open the PDF instead of guessing.

## 3. Voice chain (`lib/voice-chain.ts`)

Tiers are built from the environment, in this order, skipping any that are not configured:

| Tier | Comes from | Own model? |
|---|---|---|
| `colab` | `OLLAMA_BASE_URL` (a remote address) or `VOICE_BASE_URL` | yes |
| `colab-fallback` | `FREYA_FALLBACK_MODEL` on the same server | yes |
| `laptop` | `LOCAL_OLLAMA_URL`, set by `start --remote --laptop`; only behind a remote primary, nothing is downloaded | yes |
| cloud | `AI_FALLBACK_PROVIDER`, an ordered list such as `grok,gemini,groq` | no |

Rules:
- A tier is tried only if its circuit breaker is closed (`lib/provider-health.ts`). Remote tiers
  are also probed (a 3 s `/api/tags` call, cached 20 s) so a dead Colab costs 3 s, not the 15 s
  stream timeout.
- Falling back happens only **before the first token**. Once text has reached you, switching
  would splice two answers, so a mid-reply failure ends the reply with an error.
- **Intimate turns** and **Local-only mode** only ever use own-model tiers (Local-only: the laptop
  only). They never fall to a cloud tier; you get an error instead.
- `cloudFallback: false` in `freya.config.json` removes the cloud tiers for everything.
- The whole conversation (history, memory, persona) is rebuilt for every tier, so switching never
  loses context; the reply label says who answered.

## 4. Multimodal

**Seeing images.** For each turn with images:
1. If the voice model that will answer has vision (Ollama reports `vision` in `/api/show`; the
   Colab 27B and the Qwen3.5 4B/9B do), the images go straight to it and FREYA answers herself.
2. A describer reads the images first, in `FREYA_VISION_ORDER` (default `grok,own,gemini`):
   Grok if a valid key is set, the own server's vision model (`FREYA_VISION_MODEL`), then Gemini.
   The notes go into the prompt as reference material; the voice still answers in character.
3. With `externalFiles: false`, only own-model describers are used. If none can see, FREYA says
   she can't see it rather than guessing.

Text files are read in the browser and sent as text (credentials redacted). PDFs go to Gemini
when external processing is allowed. Every attachment keeps its note ("[Attached image: …]") in
the history, so later turns can refer to it; the bytes ride only on the turn that sent them.

**Making images** (`lib/image-generation.ts`): Colab image server first (`FREYA_IMAGE_URL`, SDXL
base + SDXL-Lightning 4-step: text-to-image, image-to-image edits, variations, styles), then
Gemini image models, then a labelled SVG drawing. The card always says which one made it.

## 5. Memory (`lib/memory-store.ts`, `lib/memory-recall.ts`)

| Layer | What | Where |
|---|---|---|
| Working | the open conversation, newest turns that fit the budget | request |
| Episodic | one recap per conversation (what it was about, where it left off), with dates | store: `episodes` |
| Semantic | notes about the user: preferences, people, events, projects, interests, decisions, jokes | store: `memories` |
| Continuity | `open` notes: things to follow up, including what FREYA said she'd ask about, with dates | store: `memories` (kind `open`) |

- **Storage**: SQLite (`node:sqlite`, built into Node 22.5+) at `data/freya-memory.db`, falling
  back to a JSON file when SQLite is unavailable. Only used on a self-hosted install
  (`FREYA_SELF_HOSTED=true`) or in development; a signed-in account keeps using Supabase.
- **Extraction**: unchanged reflection (a cloud model proposes add/update/remove; every proposal
  is validated, deduplicated against existing and forgotten notes, credential-filtered).
- **Retrieval**: each note and episode is scored against the last few user messages with BM25,
  plus recency, kind (standing preferences always count), due-soon follow-ups, and, when an
  embedding model is reachable (`FREYA_EMBED_MODEL` on the Colab server), cosine similarity.
  The best fit within a fixed character budget goes into the prompt, so she never needs the
  whole history.
- **Inspection and control**: Settings → Memory lists notes and past-conversation recaps, with
  search, edit, delete and "forget everything". Deleting a conversation deletes its recap.
- **Never invented**: only what was said is stored; a recap only exists for a conversation that
  happened; retrieval returns nothing rather than something loosely related.

## 6. Expressions (`lib/expression-director.ts`)

The portrait's face is decided by a small state machine, not chosen at random:
- **Baseline is neutral.** A mood shows on the face only when it is strong and has lasted, and
  then at reduced intensity.
- **Reactions** come from what was actually said: a joke → a brief smile or laugh; worry or bad
  news → a restrained concerned face; a real question → curiosity; confusion → confused.
  Ordinary factual answers stay neutral.
- **Hold and cooldown**: a reaction holds 2.5-6 s, then eases back. At most one reaction every
  12 s, and the same expression not again for 90 s.
- **Reading** shows only for messages long enough to read; **thinking** only while she is
  actually working something out for a while.
- **Glances** move only her eyes, never swap the photo, and only when nothing else is happening.
- **Intensity** (Settings → Expressions): off, subtle, natural (default), expressive.

## 7. Presence canvas (`app/components/EmotionCanvas.tsx`)

Displacement runs in a vertex shader: layered 3D noise for an organic, never-repeating surface,
a soft key light and rim light for depth, an inner core and outer haze. Mood changes the
geometry, light and pace over 2-3 seconds; speech is a smoothed envelope (it brightens and
quickens slightly while she talks) rather than a pulse per token. Quality steps down
automatically when frames run slow, and can be fixed in Settings.

## 8. Settings that do something

Every control maps to real behaviour; see the table in [SETUP.md](SETUP.md#settings). Hard
limits (minors, non-consent, never claiming to be human, crime) are not settings.

## 9. What was verified, and how (2026-11-03/04)

| Area | Verified by | Not verified here |
|---|---|---|
| Voice chain, privacy rules, no mid-reply switching | `tests/voice-chain.test.mjs` (planner and runtime, mocked providers) | A real Colab session failing over |
| Vision routing (own model sees, describers, `externalFiles`) | `tests/presence.test.mjs` | Grok vision (the configured key was refused), a real VLM |
| Memory store, recall, API, chat recall | `tests/memory-store.test.mjs`; a production build on this laptop with real SQLite, the real local Ollama, and a real chat turn whose stored note was recalled into the prompt | Embeddings against a live embedding model |
| Expression director | `tests/expression-director.test.mjs` | How it feels over a long conversation: tune the cue lists in `lib/expression-director.ts` |
| Canvas shaders | Compiled and linked in headless Chrome (WebGL via SwiftShader) | Frame rate on your GPU |
| Colab gateway | `training/tests/test_gateway.py` (GPU turns, embeddings on CPU, picture validation, health); `tests/voice-server.test.mjs` (the real login, live) | Ollama, SDXL and the tunnel on a real Colab GPU |
| Fine-tune notebook | Argument checks, data validation, Python compiles | A training run and a Hugging Face upload |

Everything marked "not verified here" needs a GPU, a valid key or a Colab session that this machine
doesn't have. Each failure in those paths logs its reason, so the first run shows what to fix.

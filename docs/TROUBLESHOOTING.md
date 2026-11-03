# Troubleshooting

First: Settings → **Models & status** shows who would answer and why anything is skipped, and the
terminal running FREYA logs every failure with its reason (keys are never printed).

| What you see | What it means | What to do |
|---|---|---|
| `Grok unavailable (HTTP 400: … Incorrect API key …)` | xAI refused `XAI_API_KEY` | New key from console.x.ai into `.env`/`.env.local`, restart. Grok is skipped for 10 min after a refused key |
| `… unavailable (no answer in time …)` | The provider was slower than the limit (often Gemini under load) | Wait, or change `GEMINI_MODEL`; the next tier answers meanwhile |
| `… cooling down for 45s after: …` | A recent failure; it's skipped instead of waited on | Nothing; it's retried after the cooldown |
| Replies say **LAPTOP** or **GROQ/GEMINI/GROK** instead of **SERVER** | Her Colab model wasn't reachable | Is the notebook still running? Did the address change? Re-run the line it printed |
| "Couldn't use …trycloudflare.com: It didn't answer" when starting | The Colab session ended or the tunnel changed | Run the notebook cell again and use the new line |
| "It refused the key" | The `--key` doesn't match this session's token | Copy the whole line again; set `TOKEN` in the notebook to keep one key across sessions |
| `FREYA vision: grok couldn't describe the attachment (…)` | That describer failed; the next one is tried | Check the reason; with `externalFiles` off only her own models are used |
| She says she can't see an image | Nothing that was allowed could see it | Her model may be text-only (a fine-tune without vision): set `FREYA_VISION_MODEL` on the server, or turn `externalFiles` on |
| She can't open a PDF | PDFs are read by Gemini only | Turn `externalFiles` on (and set `GEMINI_API_KEY`), or paste the text |
| Pictures are SVG drawings | No image server and no Gemini image quota | Tick `IMAGES` in the server notebook; the card says which made it |
| Picture: "the image model is still downloading" | The first picture of a session waits for ~7 GB | Try again in a few minutes |
| The first message after a picture is slow | On a T4 the picture unloaded her 27B; it's reloading | Expected (20-40 s); a 24 GB GPU avoids it |
| Memory panel says "kept in this browser" | This isn't a self-hosted install, or `FREYA_MEMORY_STORE=off` | Set `FREYA_SELF_HOSTED=true` in `.env.local` (setup does this) |
| `FREYA memory: SQLite unavailable … using a JSON file` | Node older than 22.5 | Works as is; update Node to use SQLite |
| `embeddings unavailable …; using word matching only` | The embedding model isn't reachable | Memory still works by words; check `EMBED_MODEL` in the server notebook |
| Her face doesn't change at all | Expressions are off, or nothing said called for one | Settings → Presence → Expressions. She rests at neutral by design |
| The canvas looks sparse or choppy | Auto quality stepped down on a slow machine | Settings → Presence → Canvas quality → High, if the machine can take it |
| "abuse protection is not ready" | Production mode without Upstash or self-hosting | `FREYA_SELF_HOSTED=true` in `.env.local` on your own machine |
| Training: "Resuming from …/checkpoint-N" | A previous run was cut off | Expected; it continues from there |
| Training: `--hf-repo needs HF_TOKEN` | No token in Colab Secrets | Secrets (key icon) → `HF_TOKEN`, a write token |

Checks you can run any time on the laptop: `npm run doctor` (configuration), `npm test`, and
http://localhost:3000/api/status (the chain, as JSON).

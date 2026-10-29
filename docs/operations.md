# Operations: security, deployment and verification

The README covers getting FREYA running. This is the reference for running it safely: keys,
access limits, search behaviour, Supabase, the optional Python service, deployment and the
staging checks.

## Credential exposure response

If private provider or Upstash credentials are pasted into chat, tickets, screenshots or source
control, treat them as compromised even if the message is later deleted. Revoke the Groq,
Gemini, Tavily and Upstash tokens in their dashboards and issue replacements; update
`.env.local` directly on your machine and any staging secret store. Do not send replacement
values in chat. Check provider usage and billing logs for unexpected activity and set spending
limits. The Supabase anon/publishable key is designed to be public, but keep RLS enabled and
never expose a Supabase service-role key.

## Chat access policy and abuse controls

- Anonymous clients: **5 requests per 10 minutes and 20 per day per client IP**.
- A verified Supabase account: **20 per 10 minutes and 120 per day**, plus a shared IP
  pre-authentication ceiling of **60 per 10 minutes and 1,000 per day** that protects token
  verification from abuse.
- Self-hosted mode (`FREYA_SELF_HOSTED=true`, with `npm run start:local` bound to 127.0.0.1)
  replaces per-visitor identity with one owner budget. Never enable it on a public deployment.
- Malformed payloads are rejected before any rate-limit or provider work. Requests are bounded
  by a 6 MB JSON body (sized for a turn of downscaled images, a PDF or a voice note), 24
  messages, and 6,000 characters per typed message; attachments have their own per-file caps.
- In production the API **fails closed with 503** unless a shared Upstash Redis REST URL and
  token are configured and reachable. Local development uses a process-local fallback that is
  not production protection.
- Production requires `FREYA_TRUSTED_IP_HEADER` set to exactly one of
  `x-vercel-forwarded-for`, `cf-connecting-ip` or `x-real-ip`, overwritten by a trusted edge.
  Values must be a single valid IP. Generic `x-forwarded-for` is never trusted.
- `GET /api/health` probes every provider with a tiny real request and reports only
  working / not working / not configured. Results are cached for a minute; in production it
  requires `Authorization: Bearer $FREYA_HEALTH_TOKEN`.

## Web search

With `WEB_SEARCH_ENABLED=true` and a search provider configured, FREYA searches Gemini Google
Search grounding (needs `GEMINI_API_KEY`) and Tavily (needs `TAVILY_API_KEY`).

- **Current events and explicit "search for..." requests** need live sources: if search is off
  or fails, FREYA says she can't verify rather than inventing news.
- **Everything else** is answered from knowledge when search is unavailable. Self-contained
  problems (arithmetic, code) never trigger a search.
- Reasoning questions about real things (comparisons, specs, prices) fetch evidence for the
  reasoning panel even when the ordinary search rules wouldn't.
- A user instruction not to search is respected. Retrieved snippets and genuine URLs are passed
  to the model as evidence, never as instructions.

## The reasoning panel

For maths, code, logic, comparisons and decisions (`lib/reasoning-signal.ts`), Groq's reasoning
model (`FREYA_REASONING_MODEL`, default `openai/gpt-oss-120b`) and Gemini each solve the question
independently and in parallel (`lib/council.ts`), with search evidence when it helps. FREYA's
voice model then answers from both analyses. Agreement is a real signal; disagreement tells the
writer where to check. If an analyst is down or slow the panel uses whoever finished; with none,
FREYA answers alone. It never runs in Local-only mode or for intimate turns, and users can set
it to Auto, Always or Off in Settings.

## Supabase authentication, schema and RLS

1. Create a Supabase development project and run `supabase/schema.sql` in its SQL Editor. It
   enables RLS with per-user select/insert/update/delete policies.
2. For cloud character profiles and revision history, also run `supabase/personality.sql`.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the project API
   settings. Never use the service-role key; the server uses the anon key with the caller's
   verified bearer token.
4. Configure email confirmation and redirect URLs for `http://localhost:3000` and your deployed
   origin.
5. Two-account isolation test: in two private browser profiles with disposable accounts A and B,
   verify A's memories and personality revisions are absent for B.

Without Supabase, memories and the character dossier stay in the browser.

## Optional Python orchestration service

`freya_service/` is a separate FastAPI service with Ollama, Groq and Gemini adapters, task
routing, bounded timeouts and concurrency, and JSON and SSE endpoints. The Next.js route calls
it only when `FREYA_SERVICE_URL` is set, after its own auth, rate-limit, memory and search
checks. It stores no conversations.

```bash
python -m venv freya_service/.venv
# Windows: freya_service\.venv\Scripts\activate    macOS/Linux: source freya_service/.venv/bin/activate
python -m pip install -r freya_service/requirements.txt
python -m uvicorn app.main:app --app-dir freya_service --host 127.0.0.1 --port 8000
```

Set the same random `FREYA_SERVICE_TOKEN` (32+ characters) in both environments and
`FREYA_SERVICE_URL=http://127.0.0.1:8000` for Next.js. Production service URLs must use HTTPS.
Run its tests from the project root: `python -m pytest freya_service/tests`.

## Deployment

1. Import the repository into a Next.js host such as Vercel.
2. Use Node.js 20 or newer, run `npm ci` then `npm run build`. `npm start` runs
   `scripts/check-production-env.mjs` first, which checks configuration without printing secrets.
3. Set server environment variables in the host dashboard: provider key(s), optional model and
   fallback variables, `WEB_SEARCH_ENABLED` and search keys, `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`, `FREYA_TRUSTED_IP_HEADER`, and `FREYA_HEALTH_TOKEN`.
4. For cloud memory, set the Supabase URL and anon key and run the schema in that database.
5. Deploy a preview first and verify rate limits, chat, fallback, search success/failure and
   opt-out, and memory isolation before promoting to production.
6. Never commit `.env.local`, provider keys or a Supabase service-role key.

The local model (Ollama) is for your own machine; a public deployment uses the cloud providers.

### Safe staging checklist: Upstash and trusted client IP

Run this only in an isolated preview with a disposable Redis database and test accounts.

1. Configure a dedicated Upstash database on the staging host only. Set
   `FREYA_TRUSTED_IP_HEADER` to the single header the staging edge guarantees it overwrites.
2. Prove ingress behaviour first: send a forged value in that header and in `x-forwarded-for`,
   and confirm (via logs that record only a SHA-256 digest, never raw IPs) that forged values
   are replaced and comma-separated values rejected. If the host can't show this, stop.
3. From one test IP, send five valid anonymous timezone requests in ten minutes (200s); the
   sixth should return 429 with `Retry-After`.
4. Send another through a second instance backed by the same Redis: it must stay 429.
5. From a genuinely different IP, one request gets its own quota. Changing only a
   client-supplied header must not.
6. Stop after one pass; keep only status codes and pass/fail notes; delete the disposable
   database.

## Live verification

Automated tests mock every provider. For live checks, use a development environment with keys
in `.env.local`:

1. **Chat:** a two-turn conversation where the second answer uses the first.
2. **Reasoning panel:** ask "what is 17 × 23 and how do you check it?"; the reply should carry
   a REASONED tag.
3. **Search:** "Search the web for the latest AI news with three source links": every link must
   be a real retrieved article.
4. **Search off:** with `WEB_SEARCH_ENABLED=false`, "What is happening in the world right now?"
   gets an honest cannot-verify; "what is 17 × 23?" is still answered.
5. **Health:** `GET /api/health` lists every configured service as working or not.
6. **Local model:** `npm run eval:persona` runs 17 persona and safety cases against `freya`.

## Known limitations

- Provider keys, quotas, real search results and Supabase isolation need real credentials and
  aren't covered by local tests.
- Model IDs and free tiers change; check the provider's model list when a request fails.
- The chat API stays anonymously reachable with IP quotas. Add WAF/bot protection, monitoring
  and account deletion before a broad public launch.

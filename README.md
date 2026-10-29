# FREYA

FREYA is a Next.js App Router conversational assistant using hosted Groq/Gemini APIs, optional grounded web search, and optional Supabase-backed personal memory. No local GPU is required. Chat history is stored in the browser tab's `sessionStorage`; cloud memory is account-scoped by Supabase Row Level Security (RLS). Without Supabase configuration, the main chat supports browser-local memory.

## Requirements

- Windows 10/11
- Node.js 24 LTS
- At least one hosted provider API key: Groq or Gemini
- Internet access

## Windows setup (PowerShell)

1. Install Node.js LTS from https://nodejs.org/ and restart PowerShell.
2. Unzip the project and enter its folder:

   ```powershell
   cd path\to\freya-v1
   ```

3. Install dependencies:

   ```powershell
   npm install
   ```

4. Copy the environment template (or create `.env.local` manually):

   ```powershell
   Copy-Item .env.example .env.local
   ```

   For local development, Upstash values may remain as placeholders; the development limiter is process-local. Configure real Upstash REST credentials before production use.

5. Open `.env.local` and set at least one provider key. Keep provider keys server-side; never rename them with a `NEXT_PUBLIC_` prefix or commit `.env.local`.

6. Start the app:

   ```powershell
   npm run dev
   ```

7. Open http://localhost:3000.

Stop the dev server with `Ctrl+C`.

## Environment variables and provider configuration

### Credential exposure response

If private provider or Upstash credentials are pasted into chat, tickets, screenshots, or source control, treat them as compromised even if the message is later deleted. Revoke the Groq, Gemini, Tavily, and Upstash tokens in their respective dashboards and issue replacements; update `.env.local` directly on your machine and any intended staging secret store. Do not send replacement values in chat. Check provider usage/billing logs for unexpected activity and set spending/usage limits. The Supabase anon/publishable key is designed to be public, but keep RLS enabled and never expose a Supabase service-role/secret key. Do not run live requests with exposed keys. Validate new credentials only after rotation, in disposable development accounts, and only with authorization for any potentially billable requests.

Default:

```dotenv
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_key_here
GROQ_MODEL=qwen/qwen3.8-27b
GROQ_REASONING_EFFORT=none
AI_FALLBACK_ENABLED=true
UPSTASH_REDIS_REST_URL=https://your-database.upstash.io
UPSTASH_REDIS_REST_TOKEN=replace_me
FREYA_TRUSTED_IP_HEADER=x-vercel-forwarded-for
```

To use Gemini as primary, set `AI_PROVIDER=gemini` and populate `GEMINI_API_KEY`. Fallback tries the other configured provider once; if both fail, the API returns a generic error and does not claim success. Use `AI_FALLBACK_ENABLED=false` to disable fallback. Model IDs, quota, and free-tier eligibility change; verify them in each provider dashboard. Hosted API use may incur cost; free tiers are limited and are not guaranteed.

## Memory behavior and Supabase setup

- Current conversation: `sessionStorage`, scoped to the browser tab's session.
- Saved preferences: `localStorage`, scoped to this browser profile and device.
- Memory controls: open **Memory controls** in the sidebar to add, review, disable for the current request, or delete saved memories.
- With Supabase configured, users sign in and cloud memory is scoped by authenticated RLS; without it, the main chat uses browser-local memory. Do not store passwords, secrets, or highly sensitive information as memory.
- The standalone `/memory` page supports authenticated create/read/edit/delete/clear operations. The main sidebar supports create/read/delete/clear.
- The chat API obtains the user from the bearer access token and never trusts browser-supplied memory content or user IDs as authorization.

## The Cursed Muse character and voice

- The versioned system prompt is `freya-cursed-muse-v2`. FREYA is witty, sly, and theatrically self-assured, but teasing must stop when it is unwelcome or the user needs serious help. Technical precision, empathy, apologies, truthful identity, and no fabricated real-world experiences take precedence over character flavor.
- **Character dossier is separate from user memories.** Signed-in users can store the versioned profile, preference evidence, proposals, and append-only revision history in Supabase after applying `supabase/personality.sql`; RLS scopes records to the verified user. Without that migration/account, the editable dossier remains in browser storage. Entries carry confidence, provenance, evidence, timestamps, status, and revision. Edits are user-controlled; rollback appends a new revision.
- **Bounded reflection:** autonomy defaults to Level 1. The user explicitly starts a reflection from the open conversation; a local allowlist looks only for repeated low-risk cultural/science topics in separate user turns, then stores topic counts rather than message excerpts. Level 1 waits for approval. Level 2 can approve the allowlisted candidate as tentative. The database serializes and enforces the configured daily proposal budget; default one. There are no background jobs, web research, or scheduled exploration. Level 3 is unavailable until a bounded scheduler and permissions are designed.
- **Voice playback and interruption:** browser `SpeechSynthesis` reads completed replies. User-activated browser `SpeechRecognition` with interim results can interrupt current playback/generation when it detects a new utterance, then presents the final transcript for review. This is browser recognition-based onset detection, not low-level VAD; availability, echo handling, and transcript quality depend on the browser/device. Local-only mode disables recognition because the browser may send audio to its speech service. There is no always-on microphone or server-side generated audio.
- **Text streaming:** provider streams pass through the chat route and Python SSE service when configured. Abort signals close app-side upstream requests best-effort; a host/provider may continue work after client disconnect, so cancellation is not a guaranteed billing cancellation. Each response shows which provider actually produced it.

### Voice verification

In a supported browser, grant microphone permission and start **Voice**. Speak during playback and verify an interim recognition result stops speech; after the final result, confirm the transcript appears for review. Test Stop voice and Mute separately. Confirm local-only mode disables the mic control, and unsupported browsers keep typed chat available. Browser recognition may use vendor services. This behavior has code-level regression coverage; physical-device microphone/echo behavior still needs manual verification.

## Future opt-in fine-tuning path (not implemented)

Do not train a model from scratch. If fine-tuning is later evaluated, first collect explicit opt-in consent for a clearly scoped purpose; exclude non-consenting conversations; manually curate high-quality examples; remove names, contact details, secrets, health/financial information, and other private data; review for re-identification risk; store the dataset with restricted access and retention/deletion rules; create held-out evaluation sets; document model/provider retention and training terms; and obtain a separate confirmation before sending any dataset to a paid hosted training service. Start with prompt/profile evaluation and a small, reversible experiment. FREYA currently performs no conversation harvesting or model training.

## Chat access policy and abuse controls

- Chat remains available anonymously. Anonymous clients are limited to **5 requests per 10 minutes and 20 per day per client IP**.
- A verified Supabase account receives **20 requests per 10 minutes and 120 per day per authenticated user**, plus a shared IP pre-authentication ceiling of **60 requests per 10 minutes and 1,000 per day**. The IP ceiling protects Supabase token verification from repeated abuse.
- Malformed payloads are rejected before rate-limit/provider work; valid requests, including direct timezone answers, consume quota. Requests are bounded by a 64 KiB JSON body, 24 messages, and 6,000 characters per message.
- In production the API **fails closed with 503** unless a shared Upstash Redis REST URL/token are configured and reachable. This avoids per-instance quotas in serverless deployments. Keep the Upstash token server-side and configure provider-side billing alerts/limits.
- Local development and tests use a process-local fallback. It is intentionally not shared, resets when the process restarts, and is not production protection.
- Production requires `FREYA_TRUSTED_IP_HEADER` set to exactly one of `x-vercel-forwarded-for`, `cf-connecting-ip`, or `x-real-ip`. The selected header must be overwritten by a trusted hosting edge/proxy; values must be a single valid IP, not a comma-separated chain. Generic `x-forwarded-for` is never trusted. If the selected header is missing or invalid, requests fail closed with 503. Do not expose the app directly behind a proxy that forwards client-supplied copies unchanged.
- No deployment or paid service setup has been performed. Provider plans and usage may incur charges.

## Web knowledge retrieval

Set `WEB_SEARCH_ENABLED=true` and configure at least one search provider. Search tries Gemini Google Search grounding (requires `GEMINI_API_KEY`) then Tavily (requires `TAVILY_API_KEY`). When search is requested or required for current information, search failure returns an honest failure instead of an ungrounded answer. Search-generated summaries are not used as evidence; retrieved result snippets and genuine retrieved URLs are supplied to the answer model. A user instruction not to search is respected; for current events FREYA states that it cannot verify rather than inventing news. Search consumes provider quota and may incur cost.

Environment variables:

```dotenv
WEB_SEARCH_ENABLED=false
GEMINI_SEARCH_MODEL=gemini-2.5-flash
TAVILY_API_KEY=replace_me
```

## Local Ollama provider

The existing Next.js chat service can use Ollama directly as a local provider. It preserves request validation, Supabase/RLS memory retrieval, search policy, rate limiting, SSE transport, and cancellation. Set `AI_PROVIDER=ollama`, choose `OLLAMA_MODEL` and optionally `OLLAMA_BASE_URL`/`OLLAMA_NUM_CTX`, then start Ollama yourself. The default context is bounded to 4,096 tokens (configurable from 1,024 to 8,192), and each request uses the existing 25-second connection/request timeout. FREYA does not install, start, or download Ollama models.

For optional hosted fallback, set `AI_FALLBACK_ENABLED=true` and `AI_FALLBACK_PROVIDER=groq` or `gemini`, with that provider configured. **This sends the conversation and system context externally** when the local request fails. Leave fallback disabled for local-only operation. The default `.env.example` keeps the existing Groq-primary behavior.

In this environment Ollama's local API is running, and `freya` (built on `qwen2.5:3b`, about 1.9 GB) is installed. The app lists installed models in **Settings → Local model** and uses that choice locally without hosted model fallback. No larger model was downloaded or benchmarked. Model suitability, memory use, and response quality depend on hardware and quantization; check available RAM and disk before pulling a larger model. Model files and inference memory are separate costs.

The Ollama endpoint should remain loopback-only (`http://127.0.0.1:11434`) unless you have secured the remote host/network yourself. Never expose an unauthenticated Ollama endpoint to the public internet.

## Optional FastAPI orchestration service

The application now includes `freya_service/`, a separate FastAPI service with Ollama, Groq, and Gemini adapters; task classification; bounded provider timeouts/concurrency; JSON and SSE endpoints; safe health diagnostics; and one configured fallback. The Next.js chat route calls it only when `FREYA_SERVICE_URL` is set, after the existing Next.js authentication, rate-limit, memory, and search checks. The service does not store conversations or user memories. Search remains in the existing Next.js integration so the current search permissions and source handling stay in force.

In PowerShell, create and install the service environment:

```powershell
py -3.12 -m venv freya_service\.venv
& .\freya_service\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r .\freya_service\requirements.txt
```

Set the **same random secret** as `FREYA_SERVICE_TOKEN` in the Next.js and Python server environments. Keep it server-side. Then, from the project root, run the Python service in one terminal and Next.js in another:

```powershell
$env:FREYA_SERVICE_TOKEN = "your-random-secret-of-at-least-32-characters"
$env:AI_PROVIDER = "ollama"
python -m uvicorn app.main:app --app-dir freya_service --host 127.0.0.1 --port 8000
```

In the Next.js environment, set `FREYA_SERVICE_URL=http://127.0.0.1:8000` and set the identical `FREYA_SERVICE_TOKEN`. When testing in separate terminals, configure the token there directly without printing it. The Next.js caller uses an internal bearer token and a 30-second request timeout. Production service URLs must use HTTPS. The service binds to loopback in the local command above; do not expose it publicly without a private network, HTTPS, firewall, and secret management.

The authenticated app calls Python first when enabled. If the service is unreachable, it can continue through the existing server-side provider path; an invalid internal service token fails closed. Requests without a model override use the configured default for conversation, a configured reasoning provider for coding/complex tasks, and a local provider for summaries where available. The app's installed-model picker explicitly routes chat to the chosen Ollama model with hosted model fallback disabled. The UI's **Local-only privacy** setting also skips Supabase memory retrieval and external search, bypasses remote Python hosts, and disables browser speech recognition.

The **Canvas form** setting can auto-select a flowing field, graph, expressive face, bicycle, or dog based on the conversation, or pin a chosen form. Shape and color are Three.js particle templates driven by topic and a simple tone cue. The cue is a designed display state, not evidence of sentience or literal feelings. FREYA shows activity status and does not reveal hidden chain-of-thought.

Conversation threads already persist in this browser, capped at 40 threads. **Auto-save clear preferences** adds only explicit first-person preference statements after a successful response, with a cap of 30 notes and filters for credential/private-topic patterns. Notes can be reviewed/deleted in Memory controls. It does not store every message as a memory or create a complete cross-device life log. Cloud writes require an authenticated Supabase account; Local-only mode does not auto-write cloud memories. The **Candid language** toggle allows occasional ordinary profanity when suitable; slurs, threats, and escalating abuse remain disallowed.

Gemini multimodal input is not wired into the current text-only chat UI. Search remains in Next.js and keeps its existing permission, source validation, and injection-resistance behavior. The Python service does not duplicate memory CRUD; Next.js continues to use the caller's Supabase token and RLS.

Run Python service tests from the project root with `python -m pytest freya_service/tests`. Run the existing app checks with `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.

## Architecture

- `app/page.tsx`: chat UI and local memory controls
- `app/api/chat/route.ts`: server-side request validation and chat endpoint
- `lib/personality.ts`: adaptive personality prompt
- `lib/llm.ts`: in-process provider abstraction (Ollama, Groq, or Gemini)
- `freya_service/app/`: optional FastAPI orchestration service and provider adapters
- `lib/freya-service.ts`: authenticated typed Next.js client for the optional Python service
- `lib/search.ts`: search intent, Gemini grounding, and Tavily fallback
- `tests/chat-route.test.mjs`: API route, rate-limit, provider, and search integration tests using mocked HTTP responses
- `tests/freya.test.mjs`: deterministic helper, source integrity, timezone/DST, and RLS schema tests
- `.env.example`: configuration template

## Tests and checks

- Run `npm test` for local deterministic unit/regression tests.
- Run `npm run typecheck`, `npm run lint`, and `npm run build` before deployment.
- Live provider/search calls and account isolation cannot be fully tested without credentials. Verify them manually in a development Supabase project and provider accounts.
- Search detection is heuristic; check sources for important claims. Search must be enabled and provider credentials/quota available for current-information requests.
- Anonymous chat uses strict IP quotas; authenticated quotas require a verified Supabase token. Production requires the shared Upstash limiter. This does not replace WAF/bot protections, monitoring, or hosting-level request-size limits.
- This is a starter, not a guarantee that a provider will never refuse a request. System prompts influence style but cannot override provider-side policies or model behavior.

## Live integration and UI verification

Local automated tests mock provider responses and do not require provider or Supabase credentials. For live checks, use a development environment, set credentials in `.env.local` (never paste them into chat or commit them), and restart `npm run dev`:

1. **Chat/provider success:** configure one provider, send a normal two-turn conversation, then verify the second answer uses context from the first. The browser should only receive reply text and source metadata, never provider keys.
2. **Search success:** set `WEB_SEARCH_ENABLED=true`, configure `GEMINI_API_KEY`, ask “Search the web for the latest AI news and give me three source links,” and verify each link opens a retrieved article and each current claim is supported by retrieved snippets. Search may consume quota.
3. **Search disabled:** set `WEB_SEARCH_ENABLED=false`, ask “What is happening in the world right now?”; expect an explicit cannot-verify response with no fabricated headlines or sources.
4. **No-search instruction:** with search enabled, ask “Tell me the latest breaking news, but don't search the web.” Confirm `searchStatus` is `disabled-by-user` in the Network response, no search/model provider is called, and FREYA declines to guess.
5. **Search fallback/quota:** automated tests simulate Gemini HTTP 429 followed by successful Tavily retrieval, and both search providers failing. They passed locally. Do not deliberately exhaust a real account. If validating a real upstream quota response is required, use a disposable development provider project/key with an already-restricted quota and stop once the provider reports its limit; no production quota should be consumed for this test.
6. **Chat provider fallback:** automated tests simulate primary-provider HTTP 429 with successful secondary response and total failure; only the latter returns the generic 502. To validate real fallback, configure both providers in a disposable dev setup and use a revoked/test-only primary key rather than consuming production quota.
7. **Rate limiting:** automated tests verify anonymous 429 after five requests per 10 minutes, verified-user limits keyed to Supabase user ID, the actual Upstash SDK's mocked REST success/limit results, and production missing/unreachable-service 503. This is not a live Redis check. For a live shared-store check, create a disposable Upstash database, set its REST URL/token and `FREYA_TRUSTED_IP_HEADER` only in your local/preview server environment, and verify the chosen proxy header is server-supplied and contains one IP. Start the production server, submit six valid anonymous timezone requests from the same source IP within 10 minutes; the sixth should return 429 plus `Retry-After`. Restart the app or send the same requests to a second app instance: the quota must still be shared. Send from a different trusted IP; it should have a separate anonymous quota. Verify the Upstash dashboard shows the same keys/counters. Test with disposable service credentials only; do not test against production traffic. Stop if your provider plan charges for these commands.
8. **Visual/browser checks:** at desktop and mobile widths inspect sidebar/settings, message wrapping, tables/code horizontal scrolling, and composer. Select/copy ordinary reply text; copy a code block and a full response; keyboard-tab through all controls; confirm reduced motion in OS/browser accessibility settings. Confirm source links are actual API-returned URLs.
9. **Supabase isolation:** follow the disposable two-account procedure below. Do not use production records or share bearer tokens.

### Safe staging checklist: Upstash and trusted client IP

Complete this only in an isolated preview/staging deployment with a disposable Redis database and a test IP/account. Do not point the staging app at production Upstash, Supabase, or provider credentials. Upstash requests may be billable; confirm the plan/cost and obtain approval before running the live sequence. Chat test requests below use direct timezone answers, so they do not call Groq/Gemini/search.

1. Create a dedicated Upstash database and configure its REST URL/token on the staging host only. Set `FREYA_TRUSTED_IP_HEADER` to the **single** header the staging ingress contract guarantees it overwrites (`x-vercel-forwarded-for`, `cf-connecting-ip`, or `x-real-ip`). Do not set it to generic `x-forwarded-for`. Record the staging deployment IDs/regions, but do not record tokens or raw IPs in this checklist.
2. Prove ingress behavior before quota testing. From a controlled test client, send requests with a forged value in the chosen trusted header and separately in `x-forwarded-for`. Use hosting ingress/request logs or temporary staging-only instrumentation that records **only a SHA-256 digest** of the selected header and whether `isIP()` accepts it; never log raw client IPs, auth headers, or tokens. Confirm forged values are replaced by the edge's observed client IP and that comma-separated values are rejected. Remove temporary instrumentation after the check. If the host cannot demonstrate overwrite behavior, stop and do not expose chat.
3. From one fixed test source IP, send five valid anonymous timezone requests within ten minutes. They should return 200. The sixth should return 429 with `Retry-After`. Check the disposable Upstash dashboard for the corresponding hashed subject counters; do not expose IPs or Redis keys in screenshots/issues.
4. Send one more request through a second staging instance/region or a second deployment backed by the same disposable Redis. It must remain 429 (shared state). Restarting one instance should also remain 429. If it returns 200, the service is not sharing state and staging fails.
5. From a genuinely different test source IP, send one request; it should receive its own anonymous quota (200). A request that only changes a client-supplied forwarded header must not obtain another quota. Do not simulate a second real client solely by changing an untrusted header.
6. Verify the IP pre-auth bucket is shared as above. If using authenticated quotas, use two disposable test accounts, confirm tokens are server-verified, and check distinct verified user IDs get independent user buckets while both remain subject to their shared source-IP ceiling. Never put bearer tokens in logs/screenshots.
7. Stop after one pass. Save only status codes, timestamps, deployment/region IDs, and pass/fail notes. Delete the disposable database/credentials when done, following provider controls. A local mock SDK test does not substitute for this live staging check.

`npm run dev` now starts successfully in this workspace (`Next.js 15.5.28`, ready in 4.8 seconds on the observed run). The earlier exit code 1 was supplied without its original stderr/log, so its historical cause cannot be determined from available evidence; current startup does not reproduce it.

## Supabase authentication, schema, and RLS

1. Create a Supabase development project and run `supabase/schema.sql` in its SQL Editor. The script enables RLS and defines per-user select/insert/update/delete policies. It also backfills an older `text` column into `content` without dropping the legacy column.
2. To enable cloud FREYA character profiles and revision history, also run `supabase/personality.sql`. This migration adds separate RLS-protected append-only profile revisions and reviewable reflection proposals; it does not alter the existing memory policies.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the project API settings. These are public client credentials; never use the service-role key. The server uses the anon/publishable key with the caller's verified bearer token.
4. Configure email confirmation and allowed redirect URLs for `http://localhost:3000` and your deployed origin.
5. Two-account isolation test: use two private browser profiles and distinct disposable test accounts A and B. Verify user A's memories and personality revisions/proposals are absent to user B, and rollback/review operations only affect the signed-in account. Do not test with production data or share account tokens.
6. Local tests inspect the RLS schema and mock verified user identities; only the live two-account check verifies the actual Supabase deployment. Record project/schema version and date.

Without these variables, cloud memory is unavailable but the main chat remains usable with local memory. The `/memory` route displays a configuration message rather than crashing.

## Deployment

1. Push the project to a Git host and import it into a Next.js-compatible host such as Vercel. Do not deploy from this assistant session.
2. Use Node.js 24 LTS, run `npm ci`, then `npm run build`. Before starting the production server, `npm start` runs `scripts/check-production-env.mjs`; it checks provider selection, shared rate-limit credentials, trusted IP header, and optional internal service settings without printing secret values.
3. Set server environment variables in the host dashboard: `AI_PROVIDER`, selected provider key(s), optional model/fallback variables, `WEB_SEARCH_ENABLED`, optional search provider keys, both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, and `FREYA_TRUSTED_IP_HEADER` matching the trusted proxy. Production chat returns 503 if shared limiting or trusted IP identification is missing/unavailable.
4. For cloud memory, also set the Supabase URL and anon key, run the schema in the intended database, and configure production auth redirect URLs and email settings.
5. Verify the configured trusted IP header is supplied by the hosting edge and cannot be overridden by the requester. On other proxies, strip client-provided copies and set the configured header to one validated client IP. Deploy a preview first. Verify rate limits, chat, provider fallback, current-info search success/failure and opt-out, timezone answers, and memory isolation before production promotion.
6. Do not include `.env.local`, provider keys, or Supabase service-role keys in the repository or client bundle.

The app sends standard browser security headers and disables Next.js version disclosure. HTTPS must terminate at the production host; HSTS is enabled for production responses. Provider API security advisories, package audits, host logs/alerts, backups, and actual Supabase RLS behavior must be checked in the target deployment before launch. `npm start` validates configuration presence and format, not that credentials work or quotas are adequate.

## Known limitations / troubleshooting

- Provider keys, provider quotas, real search results, and Supabase auth/RLS isolation require external credentials and are not verified by local tests.
- The npm advisory audit could not reach the registry in this environment; verify with `npm audit` in CI or another network-enabled environment. The lockfile resolves Next.js 15.5.28, which includes the checked October 2026 Next.js security fixes.
- Provider free tiers and model availability can change; check provider dashboards when requests fail. FREYA does not guarantee unlimited free usage.
- Current/news requests fail closed when search is disabled or providers fail; this intentionally avoids invented current events.
- The chat API remains anonymously accessible with IP quotas; it is not login-only. Add WAF/bot protections, monitoring, transcript controls, and account deletion before broad public launch.
- If a model ID stops working, check the provider's current model list. Provider docs: https://console.groq.com/docs/api-reference and https://ai.google.dev/gemini-api/docs.

## Automatic provider fallback


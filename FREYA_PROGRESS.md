# FREYA implementation progress

Status key: **IMPLEMENTED** = code exists; **TESTED** = verified by a recorded local check; **BLOCKED** = requires credentials/external access; **UNVERIFIED** = not yet validated. A phase is complete only when acceptance checks pass or every blocked item is explicitly listed.

## Initial repository audit

- Architecture: Next.js 15 App Router, React 19, TypeScript; chat at `app/page.tsx` and `app/api/chat/route.ts`; provider adapters in `lib/llm.ts`; search in `lib/search.ts`; timezone helpers in `lib/time.ts`; personality in `lib/personality.ts`; optional Supabase memory via browser auth and RLS.
- Existing implementation: session-scoped chat, browser/Supabase memory CRUD, Groq/Gemini fallback, Gemini grounding/Tavily fallback, timezone aliases and IANA validation, user-owned memory policies.
- Initial risks: request body/message validation is incomplete; raw provider exception details can be returned to clients; browser memory toggle is not enforced by the API; malformed JSON receives a generic upstream status; `lib/supabase.ts` throws when optional Supabase configuration is absent; search failure behavior and setup documentation are inconsistent; no automated tests or typecheck script exist.
- Repository contains `.env.example` and `.env.local`. `.env.local` was deliberately not opened or read. No environment values or credentials are recorded here.
- Available package scripts at audit: `npm run dev`, `npm run build`, `npm run start`, `npm run lint`.

## Phase 1 — Working chat

- [x] Validate malformed JSON, streaming request byte size, message roles/content/count/length, and final user turn.
- [x] Bound provider requests with timeouts and normalize safe client errors.
- [x] Improve UI retry/error/loading behavior without losing the user's failed message.
- [ ] Acceptance A: normal and multi-turn chat, malformed/empty requests, and provider failures behave sensibly.
- Status: **IMPLEMENTED; PARTIALLY TESTED**. Payload validation and provider fallback/errors are unit-tested; live chat requires provider credentials and remains unverified.

## Phase 2 — Personality and provider fallback

- [x] Preserve adaptive personality and add a user-selectable style control.
- [x] Ensure provider configuration, timeout/fallback behavior, and failure reporting are reliable.
- [ ] Acceptance B: natural casual responses, precise technical responses, concise simple answers, consistent style.
- Status: **IMPLEMENTED; UNVERIFIED** for subjective live model quality; external provider calls require configured credentials/quota.

## Phase 3 — Knowledge and persistent memory

- [x] Enforce memory toggle, ownership, and safe behavior with missing Supabase configuration.
- [x] Align schema content column, legacy migration, RLS policies, and create/read/update/delete/clear code paths.
- [x] Select relevant memories only; current explicit user instructions take precedence.
- [ ] Acceptance E: account isolation and persistence require two authenticated Supabase users; missing-credential behavior must be safe.
- Status: **IMPLEMENTED; PARTIALLY TESTED**. Schema policy/content checks pass locally. Live Supabase migration, CRUD persistence, and two-account isolation remain blocked on project credentials.

## Phase 4 — Advanced customization

- [x] Verify IANA timezone and DST behavior with deterministic tests.
- [x] Ensure current-news no-search/search-disabled/search-provider-failure paths fail closed; tests cover detection, source URL integrity, provider fallback/failure.
- [x] Improve keyboard-focus styling and add a user style selector.
- [ ] Acceptance C/D: deterministic local checks plus live search-provider verification when credentials/quota are available.
- Status: **IMPLEMENTED; LOCALLY TESTED**. Live provider grounding and real-world claim quality remain unverified without configured credentials/quota.

## Phase 5 — Reliability and launch

- [x] Add automated tests for critical helpers and schema authorization policy definitions.
- [x] Run lint, TypeScript, tests, production build; review security, docs, environment setup, and deployment steps.
- [ ] Acceptance F: build/tests pass, setup docs complete, and all external blockers are disclosed.
- Status: **LOCALLY VERIFIED; EXTERNAL CHECKS BLOCKED**. Public-launch rate limiting/authentication, provider credentials, and live Supabase isolation remain blockers.

## Verification log

- Baseline `npm run build`: passed before changes. Baseline `npm run lint`: failed because ESLint 9 flat config was missing.
- `npm test`: passed, 9 tests, 0 failures (Node 24; emits a module-type performance warning).
- `npm run typecheck`: passed.
- `npm run lint`: passed after adding flat config and excluding generated/dependency files.
- `npm run build`: passed; Next.js reports successful compile, lint/type checks, and static generation.
- `npm run start`: production server started successfully. HTTP smoke checks returned 400 for malformed JSON, 400 for an empty messages array, and 200 with an Intl-derived Tokyo time/date/offset.
- `npm run dev` was already recorded as exit code 1 in the supplied VS Code context; its original output was not available. Production server startup and API smoke tests passed, but a separate dev-server startup remains unverified.
- External checks: Supabase isolation and hosted-provider/search behavior require user credentials and remain unverified until tested.

## Go/no-go

- **NO-GO for public launch** until the shared limiter is configured on the intended host and live provider/Supabase flows are verified. Local build and test gates pass.

## Security and launch verification update — 2026-10-25

- **Implemented:** API now enforces request byte cap (64 KiB), at most 24 messages, and 6,000 characters/message before provider work.
- **Implemented:** Explicit policy preserves anonymous chat but caps anonymous identities at 5/10 minutes and 20/day; authenticated identities at 20/10 minutes and 120/day; plus shared per-IP pre-authentication caps 60/10 minutes and 1,000/day. Valid timezone/search answers also consume quota. Rejections return 429 with `Retry-After` and rate-limit headers.
- **Implemented:** Production uses Upstash Redis sliding-window counters and fails closed (503) if config is missing or unavailable. Local/dev/test uses explicitly process-local counters only. Trusted host IP header is required in production; reverse proxy must strip spoofed IP headers. No service was provisioned and no deployment/production settings changed.
- **Implemented:** Bearer tokens are verified against Supabase before granting authenticated quotas; browser-submitted identity is not trusted. IP pre-auth limit occurs before token verification to constrain auth traffic.
- **Security caveat:** IP quotas are fair-abuse throttles, not a hard global spend ceiling. A user can distribute requests over IPs/identities; use provider budget caps, WAF/bot controls, monitoring, and consider login-required policy if public abuse occurs.
- **Implemented:** Removed raw upstream provider/search/database errors from client responses and raw search-provider diagnostics from logs. Chat provider errors return generic 502; rate service configuration/outages return generic 503.
- `npm test`: **passed**, 23 tests, 0 failures after adding real API route tests for anonymous allow/limit, per-verified-user quotas, missing/unavailable production limiter, malformed/empty/oversized payloads, provider fallback/total failure, search success/disabled/no-search/quota fallback/total failure, and source grounding.
- `npm run typecheck`: **passed** after the security changes.
- `npm run lint`: **passed** after the security changes.
- `npm audit`: **passed**, zero vulnerabilities. Compatible PostCSS override resolved earlier dependency advisory without upgrading Next.js major version.
- `npm run build`: **passed** after the security changes.
- Production smoke: default port 3000 was already occupied by the running dev server (observed `EADDRINUSE`, not an application bug); production server started on port 3101. Malformed JSON returned 400, empty messages returned 400, and production with missing Upstash credentials returned generic 503 as intended.
- `npm audit`: **passed**, zero vulnerabilities after a compatible PostCSS 8.5.31+ override; `npm audit --omit=dev` also passed. Avoided the suggested breaking Next.js 16 upgrade.
- `npm run dev`: current startup reproduced successfully; Next.js 15.5.28 reported ready in 4.8 seconds. The earlier supplied exit code 1 had no captured stderr, so its historical cause is **UNVERIFIED**; current failure does not reproduce.
- Browser check: actual chat rendered Markdown/GFM table and syntax-highlighted code; unsafe `javascript:` link was sanitized; message text computed `user-select: text`; clipboard controls changed to “COPIED”/“Copied”; touch-visible action buttons; reduced-motion computed animation duration `0.00001s`. Mobile viewport inspection was attempted, but integrated browser viewport reported a mismatched `innerWidth` and horizontal overflow (document width > viewport); likely browser emulation/Next dev tooling or an actual responsive issue remains to isolate. Mark mobile responsiveness **UNVERIFIED** pending real device/browser inspection.
- Clipboard click UI feedback is verified in the integrated browser, but reading clipboard payload was blocked by browser permissions; exact clipboard contents remain **UNVERIFIED**.
- **BLOCKED:** Live Upstash behavior needs user-created Redis REST endpoint/token and a development deployment/project. Do not enter credentials in chat; add to local environment directly.
- **BLOCKED:** Live Groq/Gemini quota/fallback and Gemini/Tavily search behavior require user provider credentials and may incur quota/cost. Mocked HTTP behavior is tested; no upstream claims are made.
- **BLOCKED:** Supabase live persistence and two-account RLS isolation require a development Supabase project and two disposable accounts. Exact safe procedure is in README.
- **Not implemented:** streaming responses; API contract remains non-streaming.
- **Current recommendation:** **NO-GO for public launch** until shared Upstash is configured/tested, trusted proxy IP behavior is confirmed on target host, live provider/search flows and Supabase account isolation are verified, and mobile overflow/clipboard payload are checked in a standard browser. All current local automated quality/security gates pass.

## Remaining-launch-blocker work — 2026-10-25

- **Trusted IP — IMPLEMENTED + TESTED (mocked request boundary):** Production now requires `FREYA_TRUSTED_IP_HEADER` explicitly set to `x-vercel-forwarded-for`, `cf-connecting-ip`, or `x-real-ip`. Only that one header is read; it must contain exactly one valid IP. Generic `x-forwarded-for`, comma-separated values, invalid/missing IPs are rejected with fail-closed 503 before Redis. Proxy/header integrity on the eventual hosting platform is still **BLOCKED** until the user configures and verifies its edge behavior.
- **Upstash — IMPLEMENTED + SDK-tested; live backend BLOCKED:** Tested the installed Upstash SDK and actual route against mocked Redis REST pipeline responses for shared limiter allow and quota rejection. API tests cover four Redis calls (edge and anonymous short/daily buckets), `Retry-After` mapping, missing config, and backend outage. This does not contact or verify a real Upstash database. Live cross-instance persistence needs a user-created development Upstash database and credentials.
- **Quota policy — TESTED locally:** Anonymous 5/10m + 20/day; signed-in user 20/10m + 120/day, each also subject to IP ceiling 60/10m + 1,000/day. Identity subject is SHA-256 hashed before Redis keys. These are not a hard cost/spend cap.
- **Provider/search — TESTED with mocked HTTP, live verification BLOCKED:** Route integration tests cover primary quota failure/fallback success, total model failure, Gemini grounding/search success with retrieved URL, disabled search, explicit no-search, Gemini quota→Tavily fallback, and total search failure/no citations. Provider setup steps and low-risk live workflow are documented in README. No real provider call was made in this session; credentials/quota may incur cost.
- **Supabase — schema/local behavior TESTED, live CRUD/isolation BLOCKED:** Existing route tests emulate token verification to ensure different verified user IDs receive separate quota buckets; schema test verifies RLS policy text. No Supabase credentials were used and no live memory was read/written. README gives a disposable two-account create/read/edit/delete/clear and persistence/isolation procedure. Do not share bearer tokens; never use a service-role key.
- **Mobile overflow — FIXED + browser-tested:** Constrained flex and Markdown content to container width; retained intentional horizontal scroll only inside code and table regions; tightened sub-360px header/composer spacing. Integrated browser emulation reported viewport/document/body width all 320px at its narrowest supported rendering, `overflow=false`; long unbroken Markdown/source text stayed in bounds, while a long code block was scrollable within its block. Browser emulator's requested viewport dimensions differ from CSS `innerWidth`; test was with its actual reported 320px layout viewport, not a physical handset.
- **Clipboard — FIXED + browser-tested:** Added modern Clipboard API plus `execCommand` compatibility fallback and exact-payload unit test. In browser, pasted code block and full Markdown response into composer: code text including trailing newline matched source; response paste retained Markdown heading/table/fenced code. Selection computed as `user-select:text`. Clipboard payload was directly observed through paste, not clipboard-read permission.
- `npm test`: **passed 29 tests, 0 failures**.
- `npm run typecheck`: **passed**.
- `npm run lint`: **passed**.
- `npm audit`: **passed, 0 vulnerabilities**.
- `npm run build`: **passed** (Next.js 15.5.28 production build).
- Production smoke (`npm run start -- --port 3102`): started ready in 862 ms. Malformed JSON → 400; empty `messages` → 400; production without Upstash → generic 503 as designed. Server stopped after smoke test. Earlier attempted default port was already occupied; using 3102 succeeded.
- `.env.local` was not opened; no secrets were read, printed, or changed. No external services were provisioned, no paid calls made, and nothing deployed.
- **Remaining blockers:** Real Upstash provisioning/operation and cross-instance consistency; production ingress trusted-IP guarantee; real Groq/Gemini + Gemini/Tavily checks; live Supabase migration and two-account CRUD/isolation; actual physical-device mobile/accessibility confirmation. Exact steps are in README.
- **Recommendation remains NO-GO for public launch** until those live-service and host-edge checks pass. Local rate-limit and quality gates are tested; the live shared backend is not claimed as verified.

## Final launch-readiness pass — 2026-10-25

- **Safe credential-presence check:** queried only process-environment variable presence (values never accessed/displayed); `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FREYA_TRUSTED_IP_HEADER`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` were all absent from the current terminal process. `.env.local` was not read. Therefore no live provider, Upstash, or Supabase checks were run. This is a process-environment check only and does not assert anything about the uninspected `.env.local` file.
- **Provider/search status: BLOCKED (live); TESTED (mocked).** No upstream requests or potentially paid calls were made. README retains staged workflows for successful model call, fallback success, total failure, grounding, disabled search, explicit no-search, and quota fallback; do not deliberately exhaust a real account.
- **Supabase status: BLOCKED (live).** No project credentials/two test accounts available through the process environment; no database queried or changed. README documents disposable two-account CRUD/persistence/RLS validation.
- **Upstash/host ingress status: BLOCKED (live).** No Upstash URL/token or selected trusted header present in the process environment; no live Redis calls or hosting ingress available. Added detailed safe staging checklist to README: disposable database/preview, trusted header overwrite proof, spoof/header-chain rejection, six-request quota, second instance/restart persistence, and separate real source IP. No production configuration changed.
- **Physical-device UI: PENDING.** No physical phone/tablet was available. Prior integrated-browser emulation verified narrow-layout document width, bounded long Markdown/source strings, internal code scrolling, text selection, and copied payloads; it is not a physical-device accessibility/layout certification.
- **Final `npm test`: PASSED, 29 tests, 0 failures.**
- **Final `npm run typecheck`: PASSED.**
- **Final `npm run lint`: PASSED.**
- **Final `npm run build`: PASSED** (Next.js 15.5.28; production build and static generation completed).
- **Final `npm audit`: PASSED, 0 vulnerabilities.**
- **Final production smoke:** `npm run start -- --port 3103` became ready in 984 ms. Malformed JSON returned 400; empty messages returned 400; production without shared Upstash configuration returned the expected generic 503. No provider, search, or database request was made. Server was stopped after checks.
- No deployment, external account/service configuration, environment-file read, secret exposure, or paid provider request occurred.
- **Final status: LOCAL QUALITY GATES COMPLETE; EXTERNAL STAGING/PROVIDER/SUPABASE CHECKS BLOCKED; PHYSICAL DEVICE CHECK PENDING. NO-GO for public launch until the README staging/live procedures pass on the intended host with approved disposable resources.**

## Credential exposure incident — 2026-10-25

- The latest user attachment included private Groq, Gemini, Tavily, and Upstash credentials. Their contents are intentionally not repeated or recorded here. Treat them as compromised because they were included in the conversation.
- **Immediate user action required:** revoke/rotate those provider and Upstash credentials in their dashboards, update `.env.local` directly on the user's machine and any intended staging secret store, and check provider usage/billing logs. Do not paste replacement credentials into chat. No outbound requests were made with the exposed credentials; `.env.local` was not opened or modified.
- The Supabase anon/publishable key is public by design, unlike service-role/secret keys; RLS must remain enabled. Do not share or use a service-role key.
- The attachment shows the expected categories of settings (Groq/Gemini provider, search, Supabase anon client, Upstash, and trusted-IP selector), but key validity, model availability, account status, quotas, Redis reachability, deployed proxy behavior, and database state were not tested. No credential value was programmatically inspected.
- **Production readiness is NO-GO** until private keys are rotated, new keys are configured only through local/host secret stores, and staging checks pass with explicit authorization for potentially billable requests. Re-run live checks only with rotated disposable development credentials. Local quality gate results remain those in the previous verification section; no new code checks were needed for this documentation-only update.

## Cursed Muse / voice companion update — 2026-10-25

- **Personality — IMPLEMENTED + TESTED:** Added versioned prompt `freya-cursed-muse-v1`, witty/bratty-but-kind character guidance, restraint for emotional/technical contexts, sincere apology example, honest AI identity, and explicit no-fabricated-experience rules. Added voice calibration dialogues and deterministic prompt tests. Subjective live provider tone quality remains **UNVERIFIED** (no live provider calls).
- **Character dossier — IMPLEMENTED + LOCALLY TESTED:** Added version 1 editable profile, separate from user memories; fictional initial music/art/aesthetic/humor/intellectual tastes; tentative vs established entries, confidence and origin; validation, size/cap limits, add/edit/remove UI; saves in browser localStorage and is included in each prompt as untrusted persona data. User edits are the only persistent updates; FREYA may suggest tentative interests but cannot write changes itself. It is device-local, not Supabase-synced; migration/persistence across devices is **NOT IMPLEMENTED**.
- **Voice — IMPLEMENTED (browser-native), runtime support UNVERIFIED:** Added per-reply speech playback with `SpeechSynthesis`, user-triggered browser speech recognition when available, microphone permission/status controls, mute/stop actions, and transcript review in the composer. Browser/API availability and recognition service privacy vary. No server-side audio generation, VAD, or audio streaming is implemented.
- **Interrupt/cancel — IMPLEMENTED + UNIT-TESTED best-effort:** Mic activation immediately cancels browser speech and aborts the active fetch; request abort signals propagate to model and search provider fetches; aborted primary requests do not fall through to secondary providers. HTTP providers/hosting may continue upstream work after client disconnect, so cancellation is not a guaranteed provider-side stop or billing cancellation. There is no streaming response to interrupt token-by-token.
- **Training — DOCUMENTED, NOT IMPLEMENTED:** README documents a consented, curated, redacted, opt-in fine-tuning evaluation path. No training, transcript harvesting, or data export to training services occurs.
- `npm test`: **PASSED, 34 tests, 0 failures**, including new profile defaults/normalization/prompt examples and aborted model/search fallback tests.
- `npm run typecheck`: **PASSED**.
- `npm run lint`: **PASSED**.
- `npm run build`: **PASSED**, Next.js production compilation/static generation completed.
- `npm audit`: **PASSED, 0 vulnerabilities**.
- Existing provider fallback, search fail-closed behavior, memory ownership/RLS code, quotas, timezone helper, chat text, and existing tests were retained. No Supabase schema change needed because character dossier currently stays separate and local.
- **Voice verification status: PARTIALLY IMPLEMENTED, BROWSER UNVERIFIED.** No microphone/browser speech-recognition permission or physical-device check was run here. Follow “Voice verification” in README on each target browser; unsupported recognition must leave text chat usable.
- **NO-GO for production unchanged:** prior credential exposure remains a hard blocker; rotate private provider/Upstash keys before any live use. Live Supabase RLS, provider quality, shared Upstash/host ingress, and physical-device voice/UI remain independently blocked or pending.

## Screenshot-inspired workspace / visual canvas update — 2026-10-25

- **Layout — IMPLEMENTED + BUILD-TESTED:** Refactored the chat page into a menu bar, conversation/settings rail, center status/conversation/composer, and distinct FREYA profile panel. The prior auth, chat, Markdown/source, voice, memories, and character dossier controls are retained inside the responsive workspace. Mobile collapses to a settings drawer/backdrop and places the canvas above the conversation. Settings remain scrollable.
- **Three.js canvas — IMPLEMENTED + STATIC/TYPE-TESTED:** Added a client-only lazy-loaded abstract GPU particle field with procedural filaments and wireframe forms. It responds only to explicit UI state (idle/composing/generating/responding/interrupted); it does not claim to read emotions or thoughts. Pixel ratio is capped at 1.5, renderer falls back to CSS when WebGL fails or reduced motion is enabled, animation pauses when page visibility is lost, and geometries/materials/renderer are disposed.
- **Portrait — INTENTIONALLY ABSTRACT:** Right panel uses a stylized non-photorealistic CSS silhouette placeholder, not a generated face. Three.js is not treated as a photorealistic face generator. A future user-requested portrait needs a separately selected image-generation pipeline and explicit source/consent rules; not implemented here.
- **Dependency:** Added `three` and `@types/three`; no React Three Fiber added. The scene is one lazy client component to bound added complexity.
- First gate run found two syntax issues in the new JSX/effect; corrected them. The subsequent full gate run passed.
- `npm test`: **PASSED, 35 tests, 0 failures**, including explicit-signal/lazy-load/reduced-motion/resource-disposal assertions.
- `npm run typecheck`: **PASSED**.
- `npm run lint`: **PASSED**.
- `npm run build`: **PASSED**, Next.js 15.5.28 production compilation/static generation complete.
- `npm audit`: **PASSED, 0 vulnerabilities**.
- Main route first-load JS is now 271 kB including shared chunks; Three.js remains dynamically loaded, but the initial route bundle grew ~1 kB vs the prior 270 kB. This bundle includes Markdown/highlight cost from the previous feature; no WebGL is forced on reduced-motion/unsupported setups.
- **Not browser/device-verified in this pass:** live WebGL rendering on GPU/weak devices, responsive visual comparison at physical desktop/mobile dimensions, drawer interaction/focus trapping, and actual reduced-motion fallback. Build/tests cannot establish those behaviors. No reference face image was fabricated.
- All server-side security controls and backend flows were left in place. No deployment, external API calls, secrets, or production setting changes.
- Prior leaked provider/Upstash credentials remain a **NO-GO** until rotated. Live provider/search, Supabase isolation, shared Upstash/ingress, and physical-device checks remain blocked/pending as previously recorded.

## Local run update — 2026-10-25

- User requested “make it go now”; ran `npm run dev` without deploying. Port 3000 was occupied by process 9244, so Next.js selected port 3001. Server reported ready in 3.4 seconds at `http://localhost:3001`.
- Browser opened the local route and confirmed the three-column workspace rendered, including the lazy canvas, conversation rail, center chat/status, voice controls, and FREYA profile. WebGL/canvas component loaded after initial render.
- Browser console reported `THREE.Clock` deprecation warning. Replaced it with the animation-frame timestamp. `npm run typecheck` and `npm run lint` passed after this fix. No external AI/search request was made during the view.
- The development server remains running for local use. `npm run dev` exit status is ongoing by design; visit `http://localhost:3001` in the browser. No production service or deployment was touched.

## User-provided portrait particle rendering — 2026-10-25

- **Implemented:** Removed `.profile-image-placeholder` and its synthetic radial CSS face. The supplied `Gemini_Generated_Image_ev5pl8ev5pl8ev5p.png` is now sampled on a small offscreen canvas; pixel luminance/color become a capped 7,200-point `THREE.Points` cloud with subtle Z depth, pointer tilt, and gentle particle drift. This is an image-derived 2.5D particle study, not a true 3D scan/model or generated face.
- **Performance/accessibility:** Portrait renderer is dynamically imported on the client; renderer pixel ratio is capped at 1.35; limited 190×190 pixel sampling; reduced-motion and WebGL-failure paths use Next Image static fallback; animation pauses for hidden tabs; image listener, ResizeObserver, event listeners, geometry, material, and renderer are cleaned up.
- **Privacy/scope:** Uses only the user-provided local project image; no upload, external image service, biometric analysis, face recognition, or server request was added.
- First validation attempt found a TypeScript name collision between React's `Image` and browser `new Image()`; changed loader to `document.createElement("img")`.
- Final `npm run typecheck`: **PASSED**.
- Final `npm test`: **PASSED, 36 tests, 0 failures**.
- Final `npm run lint`: **PASSED**.
- Final `npm run build`: **PASSED**, Next.js 15.5.28 production build/static generation complete.
- Final `npm audit`: **PASSED, 0 vulnerabilities**.
- **Runtime visual check pending:** No browser refresh/screenshot of particle portrait, weak-GPU fallback, or reduced-motion portrait fallback was performed in this edit cycle. Automated tests confirm wiring/caps/fallback/disposal structure but cannot establish the visual result or actual WebGL device behavior.

## Visual redesign update — 2026-10-25

- **Implemented:** Replaced the active chat stylesheet with a unified obsidian/graphite/violet system and restrained crimson undertones, subtle grid/noise/ambient depth, responsive layouts, mobile settings navigation, stronger focus states, and reduced-motion support. Applied shared styling and back-to-chat navigation to the standalone memory route.
- **Implemented:** Added React Markdown + GFM and Highlight.js syntax highlighting; raw HTML is not enabled. Assistant Markdown supports headings, lists, tables, blockquotes, links, inline/fenced code. Wide tables and code scroll horizontally. Code links open with `noopener noreferrer`; retrieved-source links continue to come only from API results and are URL-protocol checked in the client.
- **Implemented:** Added per-response plain-text copy and per-code-block copy with visible and screen-reader feedback; preserved normal selection and context menus. Added gentle message entry and ambient halo effects with `prefers-reduced-motion` handling. Conversation auto-follow now avoids pulling users down when they scroll up to read.
- **Architecture constraint:** The existing chat API returns a complete reply and does not stream tokens. This redesign keeps its API contract and does not fake streaming. The loading state truthfully indicates generation; smooth token/block streaming remains unimplemented and would require a deliberate server/client protocol change.
- **Dependencies:** Added `react-markdown`, `remark-gfm`, `rehype-highlight`, and `highlight.js` for robust Markdown, GFM, and syntax rendering. Installation reported 2 dependency audit findings (1 moderate, 1 high); these were not force-fixed because that may introduce breaking upgrades. Review with `npm audit` before launch.
- `npm test`: passed, 9 tests, 0 failures.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed; production build generated successfully. Main route JS increased from 4.76 kB to 98.6 kB due largely to client-side Markdown/highlight support; consider a later bundle-size optimization if needed.
- Not browser-automated: clipboard permission/copy interactions, touch selection, mobile visual appearance, keyboard traversal, and reduced-motion rendering. These require manual browser/device verification.
- Acceptance 1, 2, 4, 6: implementation present; visual/accessibility behavior not fully browser-tested. Acceptance 3: no streaming in existing architecture. Acceptance 5, 7, 8: code paths implemented and build passes, but clipboard/mobile/user-interaction tests and live existing service integrations remain unverified.
- **Redesign status: IMPLEMENTED; NOT FULLY ACCEPTANCE-VERIFIED.**

## Current incremental build update - 2026-10-26

### Stage A audit

- Confirmed existing Next.js 15 App Router/React app, Groq/Gemini provider adapters, Gemini grounding/Tavily search, Supabase caller-token/RLS memory access, shared rate limiting and trusted-ingress checks, versioned character dossier, SSE chat streaming with request abort propagation, and browser speech synthesis/recognition controls.
- Existing voice does not implement audio streaming, VAD, or guaranteed upstream billing cancellation. Character profile is browser-local and user-edited; there is no autonomous reflection loop or revision rollback.
- No Python service/package exists. Python 3.12.10 is installed, but FastAPI/httpx and an Ollama executable were not found. `.env.local` was not opened. No credential values were accessed.
- No schema, authentication, or security policy was changed.

### Stage B local model adapter

- Implemented Ollama chat support for non-streaming and streamed requests through the existing chat route. Model, endpoint, and context are configurable; context is clamped to 1,024-8,192 tokens. Existing request timeout and abort handling are reused.
- Added explicit fallback selection through `AI_FALLBACK_PROVIDER`; Ollama can run with fallback disabled for local-only handling. Existing Groq-primary default remains unchanged.
- Documented setup and network safety in README and `.env.example`. No model download attempted.
- Added mocked Ollama success and Ollama outage with configured Groq fallback cases. Actual model latency, RAM use, quality, and live runtime cancellation remain unverified because Ollama was unavailable.

### Remaining master-request work

- Python FastAPI orchestration service and authenticated Next.js service integration are not implemented.
- Persistent, user-isolated character preferences/evidence/revision history, reflection budgets, rollback UI/API, and search-aware reflection are not implemented; the existing character dossier remains explicitly user-edited only.
- Existing browser voice controls cancel local chat work and speech on mic activation, but VAD/barge-in and server-side audio are not implemented.
- Verification results for the current incremental update follow.
- `npm test`: **PASSED, 54 tests, 0 failures** (includes mocked Ollama local success and explicit Groq fallback).
- `npm run typecheck`: **PASSED**.
- `npm run lint`: **PASSED**.
- `npm run build`: **PASSED**, Next.js production build/static generation completed.
- Live Ollama, hosted providers, search, Supabase, Upstash, and deployed ingress were not contacted. `.env.local` was not read. No model was downloaded and no deployment occurred.
## Master build implementation update — 2026-10-26 (supersedes earlier remaining-work checkpoint)

### Implemented in this workspace

- Added an optional authenticated FastAPI service with Ollama, Groq-compatible, and Gemini text adapters, task routing, bounded requests, timeouts, concurrency limits, health/diagnostics, chat, and SSE streaming. Next.js delegates to it when configured and keeps its existing provider path as a controlled fallback.
- Added a local-only privacy mode, provider identity reporting, bounded older-turn summaries, model-context credential filtering, and browser speech interruption on interim recognition. Local-only mode avoids remote service hosts, hosted model fallback, memory retrieval, web search, and browser speech recognition.
- Added autonomy levels, account-scoped character revisions and proposals, RLS-backed Supabase persistence, transactional rollback/approval and daily reflection budgets, capped history storage, low-risk allowlisted reflection, and local profile fallback when the migration is unavailable. The app proposes only from repeated allowlisted topics; higher autonomy does not grant tools or privileges.
- Added the additive Supabase migration and Python requirements/setup documentation. Python remains optional. Gemini image/audio input, scheduled background research, server-side voice/VAD, and true low-level voice activity detection are not implemented.

### Verification on 2026-10-26

- `python -m pytest freya_service/tests -q`: **11 passed**.
- `npm test`: **68 passed, 0 failed**.
- `npm run typecheck`, `npm run lint`, `npm run build`: **passed**.
- `python -m compileall -q freya_service`, `python -m pip check`: **passed**.
- A local Uvicorn smoke check returned healthy status and confirmed service authentication; it was stopped afterward. The optional service reports Ollama unavailable in this environment.

### Still requires a configured machine or external account

- Apply `supabase/personality.sql` in a disposable Supabase project and validate two real users' isolation, approvals, rollback, and reflection budget. Automated tests cover route/schema behavior, not live Supabase RLS/RPC execution.
- Install/run Ollama and supply machine specs before choosing a model or making hardware/latency claims. No Ollama model benchmark or download was performed. The user will provide specs later.
- Verify live hosted provider/search behavior, browser/mobile visuals, microphone permission/echo/interruption behavior, and ingress/network configuration in a development environment. No live provider or deployed service was contacted.
- The production build reported that `.env.local` is present; its contents were not displayed or inspected. No deployment was performed.

## Ollama, memory, and canvas personalization update — 2026-10-26

- Ollama's loopback API is now reachable. It lists one installed model: `llama3.2:1b`, Q8_0, about 1.3 GB on disk. The `ollama` command-line executable is not on this shell's PATH; the model API works. No additional model was downloaded because the user's hardware capacity is not yet known.
- Added `/api/models` to list installed Ollama models for the Settings picker. An explicit model choice is validated against Ollama's installed model list and routed to that model locally, with hosted-model fallback disabled through both Next.js and FastAPI. The response remains subject to configured external search unless Local-only privacy is enabled.
- Replaced the generic canvas field with Three.js particle outlines for a flow, graph, expressive face, bicycle, and dog. Auto mode derives a visualization topic and simple tone cue from recent user/assistant text; Settings can pin a form. UI text identifies these as simulated cues and shows activity/status only, not claims of consciousness or private chain-of-thought.
- Added a candid-language toggle that allows occasional ordinary profanity when context fits; the prompt excludes slurs, threats, and escalation in vulnerable situations.
- Added bounded automatic preference capture after a successful answer. It stores only explicit first-person preference statements, filters credential/private-topic patterns, and caps at 30. Existing conversation threads persist in browser storage, capped at 40 conversations; this is not unlimited or cross-device memory. The automatic save toggle is visible and memories remain reviewable/deletable. Local-only mode does not auto-write to cloud.
- `npm run typecheck`, `npm run lint`, `python -m compileall -q freya_service`, and a production build passed after implementation. The dev server uses `.next-freya-dev`; the isolated production build used `.next-freya-build` to avoid disturbing a pre-existing listener. Generated directories are ignored.
- Local smoke checks: `/api/models` listed `llama3.2:1b`; the authenticated Next-to-FastAPI path completed a privacy-mode chat with provider `ollama` and response `READY`. Python `/health` returned healthy. No hosted provider, external search, or cloud memory was contacted by that smoke request.
- The app and service are running on loopback at Next.js port 3200 and Python port 8000 with a fresh random internal token. Port 3000 and 3001 had pre-existing listeners; the 3001 owner could not be identified and was left untouched. A browser UI was not available for visual screenshot checks.
- No automated test suites were run for this customization pass. No model benchmark is claimed. Choosing a larger model still waits for RAM/free-disk specs.


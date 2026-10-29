# FREYA delivery status

## Implemented

- Next.js App Router chat with Groq, Gemini, or local Ollama providers; optional bounded FastAPI orchestration.
- Browser session conversation history, explicit browser-local preferences, optional authenticated Supabase memory with row-level security, and user controls to review and delete stored memory.
- Optional grounded web search, rate limiting, bounded request payloads, provider timeouts, and optional streaming.
- Three.js canvas visuals, configurable persona, user-invoked bounded reflection, and optional browser speech features.
- Production startup configuration check, browser security headers, disabled framework version header, and mobile zoom accessibility.

## Release gates

1. Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `python -m pytest freya_service/tests` in CI.
2. Run `npm audit` and an up-to-date Python dependency audit in a network-enabled release environment; review and resolve findings.
3. Configure production provider and Upstash credentials in the host secret store. Verify trusted proxy IP header behavior and failure handling in a preview deployment.
4. If cloud memory is enabled, apply the SQL migrations and verify authentication, RLS isolation, deletion, and redirect/email settings using disposable accounts.
5. Verify provider quotas, fallback privacy behavior, search behavior, log redaction, backup/restore, alerts, and hosting region/retention settings.
6. Promote only after the release checks pass. No hosting deployment or external account configuration has been performed from this workspace.

## Limitations

- The app is not self-conscious. Canvas expressions are designed interface states, not reports of real subjective feelings.
- Reflection runs only when the user starts it and is bounded to low-risk topic counts. Background autonomous activity and model training are not implemented.
- Local Ollama performance and voice behavior depend on the user's machine and browser. Verify these on the target hardware.
- Browser session history is not a complete durable life log. User memories are intentionally bounded and reviewable.

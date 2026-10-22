# Known limitations and unwired code register

A maintained register of code that exists in this repository but is not live, behavior
that is deliberately incomplete, and hardcoded values awaiting configuration. Without
this list, a contributor can easily mistake a stub for a bug, "fix" a deliberate limit
that's actually intentional, or build new work on top of code that looks wired in but
isn't.

**The rule: an entry is removed in the same PR that resolves it.** If you fix one of
these, delete its row here as part of that PR rather than leaving a stale entry (or a
separate follow-up PR) to clean up later.

Each entry below was verified directly against the current source at the time this
document was written, not copied from the issue that requested it.

## Register

| # | Description | Location | Impact | Tracked by |
|---|---|---|---|---|
| 1 | `auditLogsRouter` is fully implemented (`GET /audit-logs`, admin-gated) but never imported or mounted in `app.ts`. The route is completely unreachable — every request to it 404s, regardless of auth or role. | `apps/backend/src/routes/auditLogs.ts` (defined), `apps/backend/src/app.ts` (not mounted) | Audit logs recorded via `recordAuditEvent` (device linking, revocation, and elsewhere) accumulate in the database with no way to read them back through the API. | #648, #650 |
| 2 | The AI agent URL in `ask_assistant` is a literal string, `http://localhost:8000/chat`, not read from `process.env` or `config/*` the way every other external dependency (database, Redis, S3) is. | `apps/backend/src/socket/messaging.ts` | In any deployment where the backend and the AI agent (`apps/ai_agent`) are not on the same host with the agent on port 8000 (e.g. separate `docker-compose` services), every `@assistant` call fails with a connection error. See [`concepts-ai-assistant-bridge.md`](../apps/backend/docs/concepts-ai-assistant-bridge.md#the-hardcoded-agent-url) for the full trace. | #651 |
| 3 | `lib/crypto/ratchetSession.ts` is a complete, IndexedDB-backed Double Ratchet session layer with zero importers anywhere in `apps/web/src`. The live session path is `Phase1SessionCrypto` (entry 4 below), a separate and simpler implementation. `ratchetSession.ts`'s own comment states it deliberately rejects out-of-order messages, unlike `lib/crypto/doubleRatchet.ts` (which supports out-of-order delivery via bounded skipped-key tracking) — the two are explicitly noted as "not yet wired together" in `doubleRatchet.ts`'s own docstring. | `apps/web/src/lib/crypto/ratchetSession.ts` | A fully-built session layer sits unused; a contributor extending E2EE session handling could reasonably assume this is the live code path and build on it, when it is not reachable from any real message flow. | #681 |
| 4 | `Phase1SessionCrypto` (`lib/session.ts`) is the live `defaultSession` export, not `LibsignalSessionCrypto` — both classes exist in the same file, and the file's own comment names this as "Phase-1" with "Phase-2 (Signal Protocol)" as a documented future swap, not yet made. | `apps/web/src/lib/session.ts` | The deployed session-establishment behavior is the simpler Phase-1 implementation, not the full Signal-protocol-equivalent path the X3DH/Double Ratchet modules (`lib/x3dh.ts`, `lib/crypto/doubleRatchet.ts`) implement in isolation. See [`concepts-x3dh-double-ratchet.md`](../apps/web/docs/concepts-x3dh-double-ratchet.md) for what those modules do on their own, independent of whether `session.ts` currently calls into them. | none yet — open one if picking this up |
| 5 | Inconsistent `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_BACKEND_URL` defaults across the web app: `lib/api.ts` falls back to `http://localhost:4000` if `NEXT_PUBLIC_API_URL` is unset, while `components/chat/NewConversationModal.tsx` falls back to `http://localhost:3001` for the *same* env var, and `lib/socket.ts` reads an entirely different env var (`NEXT_PUBLIC_BACKEND_URL`/`NEXT_PUBLIC_SOCKET_URL`) defaulting to `3001`. The backend's actual default port (`apps/backend/src/index.ts`) is `3001` — so `lib/api.ts`'s `4000` default is simply wrong for an unconfigured local setup, not just inconsistent in spelling. | `apps/web/src/lib/api.ts`, `apps/web/src/components/chat/NewConversationModal.tsx`, `apps/web/src/lib/socket.ts` | Running the web app with `NEXT_PUBLIC_API_URL` unset (e.g. a fresh local checkout before writing a `.env`) sends REST calls to the wrong port while sockets connect correctly, a confusing partial-failure rather than a clean "nothing works" signal. | #629 (documents this; does not fix it) |
| 6 | Four files exist that are not part of either real app and are imported by nothing: `apps/web/src/service/cacheService.js` (Redis cache helpers, Express-shaped, inside a Next.js client app with no server-side Redis access of its own), `apps/web/src/app/routes/conversations.js` (an Express `Router`-based route file sitting inside the Next.js App Router directory, which does not use Express routing at all), `src/components/ui/WalletAddress.tsx` at the **repository root** (every other web component lives under `apps/web/src/`), and `apps/tests/routes/conversations.test.js` (an integration test for the orphaned route file above, requiring paths — `../../src/app`, `../../src/config/redis` — that do not resolve to anything that exists). `express` is not a declared dependency of `apps/web`. | `apps/web/src/service/cacheService.js`, `apps/web/src/app/routes/conversations.js`, `src/components/ui/WalletAddress.tsx`, `apps/tests/routes/conversations.test.js` | Misleads a contributor into thinking there's a second, Express-based server implementation somewhere, or that `WalletAddress.tsx` is a real, usable component at the repo root rather than orphaned. None of these four files are reachable from any build, lint, or test command that actually runs in CI. | #679 |

## Keeping this register honest

- **Verify before listing.** An entry in this table is a claim that a specific file,
  at a specific path, currently behaves the way the entry describes. Before adding a
  new row, confirm it directly (grep for importers, read the actual default value,
  run the actual command) — don't transcribe a bug report's wording without checking
  it still matches the code.
- **Link or open an issue.** Every entry needs a tracking issue. If none exists for a
  limitation you're documenting, open one (see entry 3's #681 for the pattern) rather
  than leaving the "Tracked by" column empty.
- **Remove the row when it's fixed**, in the same PR, not a follow-up. A stale "known
  limitation" that's actually been resolved is worse than no register at all — it
  actively misleads the next person who reads it.
- **This is not a general TODO list.** Things that are simply unfinished features with
  their own tracking issue and no risk of being mistaken for live/wired code don't
  belong here. This register is specifically for the "looks real, isn't" and "looks
  like a bug, is deliberate" cases.

## Implementation references

- `apps/backend/src/routes/auditLogs.ts`, `apps/backend/src/app.ts` (entry 1)
- `apps/backend/src/socket/messaging.ts` (entry 2) — see also [`concepts-ai-assistant-bridge.md`](../apps/backend/docs/concepts-ai-assistant-bridge.md)
- `apps/web/src/lib/crypto/ratchetSession.ts`, `apps/web/src/lib/crypto/doubleRatchet.ts` (entry 3) — see also [`concepts-x3dh-double-ratchet.md`](../apps/web/docs/concepts-x3dh-double-ratchet.md)
- `apps/web/src/lib/session.ts` (entry 4)
- `apps/web/src/lib/api.ts`, `apps/web/src/components/chat/NewConversationModal.tsx`, `apps/web/src/lib/socket.ts`, `apps/backend/src/index.ts` (entry 5)
- `apps/web/src/service/cacheService.js`, `apps/web/src/app/routes/conversations.js`, `src/components/ui/WalletAddress.tsx`, `apps/tests/routes/conversations.test.js` (entry 6)

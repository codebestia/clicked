# Implementation docs

Local index of the documents that track what this codebase actually implements.
Several docs under `docs/` and `apps/*/docs/` state "cross-referenced from
`IMPLEMENTATION_DOCS.md`" — this is the file they mean.

Note: this file is listed in `.gitignore`, so it normally lives only in the
maintainer's working tree. It is committed here so the ADR index has a stable
cross-link from a repo-root document; if it should stay local, paste the
"Decisions" block below into your own copy and drop the file.

## Decisions

- [docs/adr/README.md](./docs/adr/README.md) — Architecture Decision Records:
  the index, the template, and the backfilled decisions (one `devices` table,
  `(createdAt, id)` ordering, ciphertext-only storage, per-device envelopes, the
  sealed-box → Signal migration path, MLS for groups), plus the two decisions
  that were shipped and superseded.

## Architecture and operations

- [docs/threat-model.md](./docs/threat-model.md) — what the gateway and its
  stores can see, and the trust boundary.
- [docs/runbook.md](./docs/runbook.md) — scaling, failure modes, incident
  response for the backend gateway.
- [docs/observability.md](./docs/observability.md) — metrics, logs and tracing.
- [docs/group-epoch-sync.md](./docs/group-epoch-sync.md) — the group-control
  sequence log and how a client catches up.
- [docs/signal-integration.md](./docs/signal-integration.md) — Signal library
  evaluation and the client-side crypto split.
- [docs/security/](./docs/security/) — rate limits, TLS/pinning, audit logging.

## Backend

- [apps/backend/docs/](./apps/backend/docs/) — REST/socket API references,
  contract schemas, E2EE onboarding, device and prekey APIs, delivery fan-out,
  push/storage jobs, security hardening.
- E2EE specifics: `e2ee-onboarding.md`, `message-encryption-migration.md`
  (ciphertext-only cutover), `signal-migration.md` (Phase-1 → Signal),
  `mls-group-membership.md`, `mls-group-files.md`, `mls-key-packages.md`.

## Web

- [apps/web/docs/](./apps/web/docs/) — client concepts (E2EE stack, message
  pipeline, file encryption, auth/device lifecycle, local search) and contract
  references (response types, IndexedDB schemas, REST/WebSocket clients).

## AI agent and contracts

- [apps/ai_agent/docs/](./apps/ai_agent/docs/) — chat, index search, transfer
  analysis, RAG architecture, Weaviate schema.
- [contracts/docs/](./contracts/docs/) — Soroban contract APIs.
- [contracts/README.md](./contracts/README.md) — contract workspace overview.

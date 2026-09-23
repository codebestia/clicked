# ADR-0003: Messages are stored ciphertext-only; legacy plaintext is archived, not tombstoned

- **Status:** accepted
- **Date:** backfilled 2026-09-23 (decision predates this record)

## Context

`messages` originally carried a plaintext `content` column with a GIN index,
which is what made server-side search (`GET /conversations/:id/search`)
possible. The move to E2EE added `messages.ciphertext` and per-recipient
`message_envelopes` rows, so for a while both models existed: some rows had
plaintext, some had ciphertext, and the read paths had to handle either.

Two problems came out of that:

1. A server that can read messages is not an E2EE server. Any code path that
   can serve `content` is a path that can leak plaintext to a client that
   expected ciphertext.
2. Search over a column the server must not be able to read is not a feature
   that can be kept.

The cutover had to decide what to do with rows whose `content` was already
non-null, because dropping the column is destructive.

## Decision

`messages` is ciphertext-shaped, permanently, and the old plaintext is moved
out of the way rather than kept in place.

- The one-time migration (`apps/backend/drizzle/0003_ciphertext_only_messages.sql`)
  copies every non-null `content` into `message_content_archive`, then drops
  the column and its GIN index. It is guarded and idempotent: the column check
  goes through `information_schema.columns`, and the drops use
  `IF EXISTS`, so it is a no-op on a database that already ran `0000`.
- `message_content_archive` has **no route and no query path** through the API
  — it exists for legal/compliance access on its own retention schedule. Its
  `original_message_id` is deliberately not a foreign key, so hard-deleting a
  message never cascades into the archive.
- The read path never fabricates an E2EE claim over old plaintext.
  `serializeMessage()`'s fallback chain (envelope → base `ciphertext` →
  `unavailable: true`) means a pre-cutover row resolves to
  `{ ciphertext: null, unavailable: true }`.
- `messages_system_payload_check` keeps the other half of the invariant: a
  `system` row carries structured metadata and **no** ciphertext, every other
  row carries ciphertext (or an envelope) and no system payload.
- Server-side search is gone: `GET /conversations/:id/search` returns `410 Gone`
  pointing at the migration doc (`apps/backend/src/routes/conversations.ts:661-666`).
  Search is client-side over decrypted messages.

## Consequences

- Every read path has one branch to reason about. There is no lingering
  plaintext branch that a later change could accidentally serve as if it were
  ciphertext, and `validateMessagePayload` rejects any client payload with a
  plaintext body.
- Old plaintext is not re-encrypted and not presented as encrypted. Users see
  those messages as "unavailable", which is the honest outcome.
- The archive is a real plaintext liability sitting in the same database; it is
  not covered by the background GC jobs in `services/envelopeGc.ts` /
  `services/fileCleanup.ts`. Retention is an open policy decision
  (`docs/message-encryption-migration.md`, "Retention of the archive").
- Rollback is manual and partial — `drizzle/rollback/0003_ciphertext_only_messages.down.sql`
  restores only what the archive holds. Messages sent after the cutover were
  never plaintext anywhere, so there is nothing to restore for them.
- `messages.systemPayload` and `messages.ciphertext` are now mutually exclusive
  by constraint, so a future field that is neither must be a new column, not a
  reuse of either.

## Alternatives rejected

- **Tombstone in place** — keep a `content`-shaped or `legacyPlaintext` column
  on `messages` forever, nulled or flagged so the "this row used to be
  plaintext" fact stays attached to the row. Rejected because it permanently
  taxes every future `messages` migration and query with a legacy-shaped column
  (and its GIN index) for data that existed only before the cutover and will
  never grow. Stated in `apps/backend/docs/message-encryption-migration.md`
  ("Decision: archive-then-purge (not a tombstone)") and in the PR #482
  summary.
- **Re-encrypting the old plaintext into envelopes at migration time.** Not
  done: the server cannot produce envelopes for a device set it does not
  control, and re-encrypting would backdate an "encrypted" claim onto data that
  was sent in the clear. The doc says this explicitly ("No silent E2EE claim
  over old plaintext"). Marked here as the reasoning the repo records, but no
  review thread debating it as a serious candidate was found.
- **Keeping server-side search over ciphertext** (e.g. searchable encryption).
  Not addressed anywhere in the repo; the endpoint was removed rather than
  redesigned. Treat as unverified / not considered.

## Sources

- schema: `apps/backend/src/db/schema.ts` (`messages`,
  `messages_system_payload_check`) — `messages` has a nullable `ciphertext`
  column and no plaintext `content` column
- migration: named as `apps/backend/drizzle/0003_ciphertext_only_messages.sql`
  with a rollback at `apps/backend/drizzle/rollback/0003_ciphertext_only_messages.down.sql`
  in the doc, but **neither file is present in this tree**: the migration
  history was squashed to a single `apps/backend/drizzle/0000_lean_scrambler.sql`
  and `message_content_archive` is not defined in `db/schema.ts` either. What is
  verifiable here is the end state (no plaintext column, `410` on search) and
  the policy document, not the archive table itself
- enforcement: `apps/backend/src/lib/validateMessagePayload.ts`,
  `apps/backend/src/lib/messages.ts` (`serializeMessage`),
  `apps/backend/src/routes/conversations.ts:661-666` (`410` on search)
- docs: `apps/backend/docs/message-encryption-migration.md` (canonical),
  `docs/threat-model.md` ("What the server cannot see")
- tests: `apps/backend/src/__tests__/security.regression.test.ts`
- discussion: PR #482 (archive-then-purge "chosen over an in-place tombstone"),
  PR #420 (ciphertext-only invariant enforced in code + CI), PR #410
  ("Server cannot decrypt" assertion test)

Link caveat: the `410` response points readers at
`https://github.com/DripWave/clicked/blob/main/docs/message-encryption-migration.md`,
which is the wrong owner and the wrong path for this repo — the document that
exists is `apps/backend/docs/message-encryption-migration.md` under
`codebestia/clicked`. The response body is code, so it was not corrected here;
it is recorded so the next reader of the ADR is not sent to a 404.

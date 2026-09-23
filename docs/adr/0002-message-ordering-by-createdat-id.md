# ADR-0002: Order messages by `(createdAt, id)`, not a per-conversation sequence counter

- **Status:** accepted (supersedes [ADR-0007](./0007-per-conversation-sequence-numbers.md))
- **Date:** backfilled 2026-09-23 (decision predates this record)
- **Supersedes:** ADR-0007 (per-conversation monotonic `sequence_number`)

## Context

Chat messages need a total order for rendering, and offline catch-up needs a
resumable cursor over what a device missed.

Issue #178 asked for a per-conversation monotonic `sequence_number`, assigned
atomically inside the write transaction (`UPDATE conversations ... RETURNING` on
a `last_sequence_number` column) so concurrent senders could not duplicate or
skip values. PR #324 implemented exactly that: a `lastSequenceNumber` on
`conversations`, `messages.sequenceNumber` as `bigint`, assignment wired into
every insert path — REST, Socket.IO, AI assistant replies, system events — and
history pagination switched to `sequenceNumber` cursors.

It was then dropped again. The reason is in the schema comment and the sync
route: a counter that is monotonic *within one conversation* cannot also be a
coherent cursor *across conversations*. Offline catch-up (`GET /sync`) returns
the envelopes a single device missed, and those span every conversation that
device participates in. A per-conversation counter gives those rows no shared
order and no comparable cursor; the client would have to keep one cursor per
conversation and poll each of them.

The alternative — two counters, one per-conversation for display and one global
for sync — was judged not worth the complexity of keeping both correct under
concurrent writes.

## Decision

Chat messages are ordered by `(created_at, id)` and nothing else.

- `messages` has `index('messages_conversation_created_idx').on(conversationId, createdAt)`.
- Cursors are the pair itself: `GET /conversations/:id/messages?before=<id>`
  resolves the message's `(createdAt, id)`
  (`apps/backend/src/routes/conversations.ts:596-629`) and pages with
  `createdAt < c.createdAt OR (createdAt = c.createdAt AND id < c.id)`.
- `GET /sync` uses the *envelope's* `(createdAt, id)` encoded as the opaque
  cursor `"<epochMillis>:<uuid>"` (`apps/backend/src/routes/sync.ts:21-22,
  119-142`).
- `id` is only a tiebreaker for same-millisecond inserts. It is a random UUID
  and carries no chronological meaning.
- Where ordering must not be skippable — group control events — a separate,
  strictly monotonic log is used instead of the message table; see
  `docs/group-epoch-sync.md`.

## Consequences

- One ordering for the timeline and for sync. A cursor is comparable across
  conversations, so offline catch-up is a single request per device.
- No counter to maintain, no row lock on `conversations` for every message
  insert, and no second counter to keep consistent.
- Clock skew and same-millisecond writes are handled by the timestamp tiebreak
  rather than being impossible; that is cheaper, but the order is only as good
  as the server clock. Both timestamps are server-generated (`defaultNow()`),
  which keeps a client from choosing its own position in the timeline.
- Pages can interleave when two messages share a millisecond; the `id` tiebreak
  keeps pagination from skipping or duplicating rows, it does not make the
  order meaningful.
- Live correctness gap, still open: seven frontend types still declare
  `sequenceNumber`, and the client sorts on `msg.sequenceNumber ?? 0`, so live
  ordering collapses to `0` for every synced message
  (`apps/web/docs/contracts-response-types.md`, DRIFT-1). This ADR is about the
  server model; the stale client types are a follow-up.

## Alternatives rejected

- **Per-conversation monotonic `sequence_number`** (#178, implemented in
  PR #324, then reverted). Rejected because a per-conversation counter is not a
  usable cross-conversation sync cursor. This is stated directly in the code:
  `apps/backend/src/db/schema.ts:117-121` and
  `apps/backend/src/routes/sync.ts:21-22`.
- **Two counters** — per-conversation for display, global for sync. Rejected as
  not worth the complexity (schema comment, `schema.ts:117-121`).
- **Client-side ordering by local receive time.** Not recorded anywhere in the
  repo; the server timestamps are used instead, but no review discussion
  rejecting this was found, so treat the rejection as unverified.
- **Ordering by `id` alone.** Rejected implicitly: `id` is a random UUID
  (`defaultRandom()`), so it cannot order anything; it is a tiebreak only.

## Sources

- schema: `apps/backend/src/db/schema.ts:117-121` (ordering comment),
  `messages` table and `messages_conversation_created_idx`
- pagination: `apps/backend/src/routes/conversations.ts:596-629`
- sync cursor: `apps/backend/src/routes/sync.ts:21-22,119-142`
- the monotonic log that *does* exist, for group control:
  `apps/backend/drizzle` `group_control_events`, `docs/group-epoch-sync.md:12-25`
- docs: `apps/backend/docs/api-conversations.md:123-124`,
  `apps/backend/docs/api-messages-sync.md:236-241`,
  `apps/web/docs/contracts-response-types.md` (DRIFT-1, DRIFT-4)
- discussion: issue #178, PR #324 (both about the counter that was dropped)

Citation caveat: the comment at `schema.ts:117-121` cites "(#137)" for the
offline-sync cursor argument, and `sync.ts:21` cites "(#128)". Neither number
resolves to that topic in this repo — #137 is a `cargo clippy` job and #128 is
the `treasury_proposals` table — so the numbers were reused or renumbered at
some point. The *reasoning* is in the code; the issue numbers are not reliable.

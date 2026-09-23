# ADR-0007: Per-conversation monotonic `sequence_number` for chat messages

- **Status:** superseded by [ADR-0002](./0002-message-ordering-by-createdat-id.md)
- **Date:** backfilled 2026-09-23 (decision and its reversal both predate this record)

## Context

This record exists because the decision was made, shipped, and then reversed.
An index that only lists the surviving decisions hides the reversal, and the
next person to ask "why don't these rows have sequence numbers?" deserves the
history rather than a re-derivation.

Issue #178 asked for gapless, strictly increasing per-conversation message
numbers, assigned atomically inside the write transaction so concurrent senders
could not duplicate a value. PR #324 implemented it: `lastSequenceNumber` on
`conversations`, `messages.sequenceNumber` as `bigint`, assignment wired into
REST, Socket.IO, AI assistant replies and system-event paths, and history
pagination switched from `(createdAt, id)` to `sequenceNumber` cursors.

## Decision

`messages.sequenceNumber` and `conversations.lastSequenceNumber` existed and
were assigned with `UPDATE conversations ... RETURNING` inside the message
persistence transaction.

## Consequences

- Within a conversation the order was gapless and strictly increasing, and
  "did I miss anything?" was an integer comparison.
- Every message insert took a row lock on its conversation row. That is a real
  serialization point on the hottest write path in the system, and it made
  horizontal scaling of the send path a per-conversation bottleneck.
- Most importantly, the counter could not serve as a cursor for `GET /sync`,
  which returns a device's missed envelopes across *all* its conversations. See
  the reversal in ADR-0002.

## Alternatives rejected

None recorded at the time: the issue asked for the counter and the PR
implemented it. The rejected alternative — ordering by `(createdAt, id)` — is
what the codebase returned to, and is recorded in ADR-0002 rather than here.

## Sources

- discussion: issue #178 (closed; the request), PR #324 (merged; the
  implementation)
- reversal: `apps/backend/src/db/schema.ts:117-121` (the ordering comment),
  `apps/backend/src/routes/sync.ts:21-22`,
  `apps/web/docs/contracts-response-types.md` (DRIFT-1 and DRIFT-4 — the
  frontend types that were never cleaned up)
- surviving remnants of the model: the database column is gone from
  `apps/backend/src/db/schema.ts`, but 79 references to `sequenceNumber` remain
  across the repo (43 in `apps/web/src` — `hooks/useInboundPipeline.ts`,
  `lib/crypto/types.ts`, the response-type declarations;
  8 in `apps/backend/src` — the optional `sequenceNumber` passthrough on the
  `message_delivered` receipt path in `socket/messaging.ts:838-915` and a test
  asserting envelopes do *not* carry it; 27 in docs, including
  `apps/backend/docs/api-websocket-events.md:444` which still describes it as
  "Per-conversation monotonic sequence number for ordering").

# ADR-0005: Phase-1 sealed box to Phase-2 Signal, migrated per device pair

- **Status:** accepted (migration path defined and enforced; Phase-2 encryption
  itself is not activated — the client adapter still throws)
- **Date:** backfilled 2026-09-23 (decision predates this record)

## Context

The shipped encryption is the Phase-1 sealed box: ECDH ephemeral key + HKDF +
AES-256-GCM, one independent box per recipient device per message. It has no
forward secrecy and no ratchet — a device's long-term key compromised later
decrypts recorded history (`docs/threat-model.md`, residual risk 7).

Phase 2 is the Signal Double Ratchet, which fixes that. But clients update on
their own schedule, and a device cannot decrypt what it has no code for. So at
any moment a conversation contains devices on both sides of the line, and the
question is not "when do we switch" but "how do we switch without losing
history or sending anyone an unreadable message".

## Decision

The cutover is negotiated per device pair, recorded per envelope, and never
rewrites the past. Three rules, from `apps/backend/docs/signal-migration.md`:

1. **History is never re-encrypted.** `message_envelopes.protocol`
   (`e2ee_protocol`: `sealed_box | signal | mls`, default `sealed_box`) records
   the construction that produced each envelope. Pre-cutover envelopes keep
   decrypting on the Phase-1 path indefinitely.
2. **A device pair uses the strongest protocol both sides advertise**, taken
   from `devices.capabilities.protocols`, not the weakest protocol in the
   conversation.
3. **A weaker protocol than both sides support is refused.** `400
   unsupported_by_recipient` when the envelope names a protocol the recipient
   does not advertise (it would be undecryptable on arrival, indistinguishable
   from tampering), `409 downgrade` when both devices could do better. Both
   responses list every offending envelope.

The transition needs no new endpoint: a client that ships Signal support
re-verifies with a widened capability list, and `POST /auth/verify` treats a
newer `capabilities` document as the upgrade path. Rollout order is mandated:
ship a client that can *decrypt* both paths but still encrypts sealed box
first, then the client that can encrypt Signal. Reversing that order produces
envelopes the peer cannot open.

## Consequences

- Forward secrecy arrives for a pair as soon as both sides are capable. In a
  large group, pairs flip independently, so the security improvement is not
  held hostage to the slowest device in the conversation.
- The server keeps enforcing something it cannot verify cryptographically: it
  checks the *declared* protocol against the advertised capabilities, not the
  bytes. A compromised client can lie about what it sent, and the downgrade
  refusal only catches the case where it lies *downward* while both sides
  support better.
- Two decryption paths stay in the client forever. That is the price of not
  rewriting history, and it is deliberate.
- Capability and protocol are now two different columns for two different
  questions ("what can this device do now" vs "what encrypted this envelope
  then"). Conflating them was the tempting simplification; it would make old
  envelopes uninterpretable after a capability change.
- Phase-2 remains unfinished work: `apps/web/src/lib/signalClient.ts` is a stub
  that throws, `session.ts` still defaults to `Phase1SessionCrypto`, and there
  is no IndexedDB-backed Signal session store yet
  (`docs/signal-integration.md`, activation checklist). The *migration path* is
  accepted and enforced; the *migration* is not done.

## Alternatives rejected

- **A conversation-wide "everyone must be ready" gate** — hold the whole
  conversation on sealed box until every device advertises Signal. Described in
  the migration doc as "simpler to describe but strictly worse": it would delay
  forward secrecy for every pair in a group until the last straggler updates,
  which in a large group may be never.
- **Re-encrypting history to Signal** when a pair cuts over. Rejected:
  re-wrapping old messages would need the old plaintext or session state, and it
  would break on any device that has not upgraded. "The cutover changes what is
  written next, never what was written before."
- **A per-conversation or per-device `protocol` field** instead of per
  envelope. Rejected because a conversation legitimately contains both during
  the transition, and `devices.capabilities` describes current ability, not what
  encrypted a message last month (`signal-migration.md`, "Data model").
- **`libsignal-protocol-javascript` or
  `@privacyresearch/libsignal-protocol-typescript`** as the Phase-2 library.
  Rejected in favour of `@signalapp/libsignal-client`: the former is archived and
  unmaintained, the latter has no independent audit, and neither ships a full
  Double Ratchet (evaluation table in `docs/signal-integration.md`).

## Sources

- schema: `apps/backend/src/db/schema.ts:172-215` (`e2eeProtocolEnum`,
  `messageEnvelopes.protocol`, `devices.capabilities`)
- negotiation and enforcement: `apps/backend/src/lib/capabilities.ts`
  (`KNOWN_PROTOCOLS`, `selectProtocol`),
  `apps/backend/src/services/e2eeProtocol.ts`
- migration spec: `apps/backend/docs/signal-migration.md` (canonical),
  `apps/backend/docs/message-encryption-migration.md` and
  `apps/backend/docs/api-websocket-events.md` for capability fields
- library decision: `docs/signal-integration.md`
- client state: `apps/web/src/lib/signalClient.ts` (stub, throws),
  `apps/web/src/lib/session.ts`, `apps/web/src/lib/signalSession.ts`
- tests: `apps/backend/src/__tests__/e2eeProtocol.test.ts`,
  `signalMigration.routes.test.ts`, `signalInvariants.*.test.ts`
- discussion: PR #533 (Phase-1 → Signal migration path, which the `#364`
  schema comment also refers to), issue #306 (Double Ratchet for DMs),
  issue #362 (multi-device Signal sessions)

Caveat: the migration doc names `drizzle/0004_envelope_protocol.sql` as the
migration that adds `message_envelopes.protocol`. That file is not present in
this tree — the migration history is squashed into
`apps/backend/drizzle/0000_lean_scrambler.sql`, where the column and the
`e2ee_protocol` enum do exist, with `DEFAULT 'sealed_box'`.

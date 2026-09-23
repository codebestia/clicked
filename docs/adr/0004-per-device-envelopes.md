# ADR-0004: Per-device envelopes, not one shared ciphertext

- **Status:** accepted
- **Date:** backfilled 2026-09-23 (decision predates this record)

## Context

A direct message has one sender device and, usually, several recipient
devices — the recipient may have a phone and a laptop, and the sender usually
has more than one device too. Something has to decide how many ciphertexts a
single message produces and who each one is decryptable by.

The cheap option is one ciphertext encrypted for the whole conversation: encrypt
once with a key every member device can derive, store one blob, deliver it to
everyone. It makes the storage and fan-out trivial and the message body
identical for every reader.

It also means every device in the conversation shares one key, so compromising
any one device's key compromises every message ever sent with that key, and
there is no per-device revocation: the only way to stop a device reading is to
rotate the key for everyone.

## Decision

A DM is stored as one `messages` row plus one `message_envelopes` row per
recipient device — including the sender's own other devices.

- The wire payload is `envelopes: [{ recipientDeviceId, ciphertext }]`
  (`apps/backend/src/lib/validateMessagePayload.ts`: for `text` the envelope
  array must be non-empty, for file-bearing content types the envelope
  ciphertext is what carries the encrypted file key).
- Each envelope carries its own `ciphertext`, one row per device, keyed by
  `recipient_device_id`; the pair is `me_recipient_device_created_idx`.
- The server enforces **sibling-device coverage**: every non-revoked device the
  sender owns must have an envelope, or the send is rejected with
  `device_set_mismatch` and the missing ids
  (`apps/backend/src/lib/messageFanout.ts:42`, `fetchSiblingDeviceIds`;
  `socket/messaging.ts`, `routes/messages.ts`).
- Persistence is transactional: the `messages` row and all `message_envelopes`
  rows commit together, or neither does.
- Delivery is per device: each socket joins its own `device:<id>` room, and
  `deliverMessage` emits `message_envelope` only to devices that have an
  envelope row (`apps/backend/src/services/deliveryPipeline.ts`). `new_message`
  goes to the conversation room without any ciphertext.
- Every envelope records which construction produced it
  (`message_envelopes.protocol`), so an envelope stays interpretable after the
  device's advertised capabilities change; see ADR-0005.
- Group messages are the deliberate exception and use one group ciphertext
  (ADR-0006) — but mixing the two models on a single message is rejected.

## Consequences

- Key compromise is scoped to a device, not to a conversation. Revoking a
  device (`devices.revoked_at`) stops future fan-out to it without touching
  anyone else's key.
- One message costs N envelope rows, N ciphertexts, and a client-side encryption
  pass per target device. A three-device recipient set plus two sender devices
  is five ciphertexts for one line of text, and that grows with group size —
  which is why groups do not use this model (ADR-0006).
- The client must know the exact device set before sending, and the set can
  change between the client's fetch and the write. Hence `device_set_mismatch`
  with the missing ids and a re-encrypt-and-retry loop rather than a silent
  partial fan-out.
- A sender who omits their own sibling device creates messages the sender
  cannot read back on their other laptop; the server-side check makes that a
  server-rejected error instead of a silent data loss.
- Per-device storage growth is real, and is why `services/envelopeGc.ts` exists.

## Alternatives rejected

- **One ciphertext for the whole conversation, shared by every member device.**
  Rejected: a single shared key means a single point of compromise and no
  per-device revocation. This is the model used for *groups* via MLS, where a
  ratchet tree gives per-epoch membership changes and removal actually removes
  the ability to read (ADR-0006) — a shared static conversation key has neither
  property. Note that the repo does not contain a review thread stating this
  rejection in these terms: the code records the chosen model and the ban on
  mixing models, not the debate. Treat this rejection rationale as inferred
  except for the mixing ban, which is explicit.
- **Sending `envelopes` alongside `mlsEpoch`** (a hybrid: per-device envelopes
  plus a group ciphertext on one message). Explicitly rejected: "the two
  key-distribution models must not be mixed on one message, or recipients have
  no unambiguous rule for which ciphertext to decrypt"
  (`apps/backend/src/lib/validateMessagePayload.ts:15-19`,
  `apps/backend/docs/mls-group-membership.md:278-283`). `envelopes` together
  with `mlsEpoch` is a `400`.
- **Encrypting nothing and letting the recipient devices fail to decrypt.**
  Rejected in the read paths: a device with no envelope gets an explicit
  `unavailable` marker rather than the ciphertext, because failed decryption is
  indistinguishable from tampering on the client
  (`apps/web/docs/concepts-message-pipeline.md` §3).

## Sources

- schema: `apps/backend/src/db/schema.ts` (`messageEnvelopes`,
  `messageEnvelopes.recipientDeviceId`, `me_recipient_device_created_idx`)
- migration: `apps/backend/drizzle/0000_lean_scrambler.sql`
  (`CREATE TABLE "message_envelopes"`, FK to `public.devices(id)`)
- send path: `apps/backend/src/lib/validateMessagePayload.ts`,
  `apps/backend/src/socket/messaging.ts`, `apps/backend/src/routes/messages.ts`
- fan-out: `apps/backend/src/lib/messageFanout.ts:1-140`,
  `apps/backend/src/services/deliveryPipeline.ts`
- client: `apps/web/src/lib/crypto.ts` (`buildEnvelopes`),
  `apps/web/docs/concepts-message-pipeline.md` §1.2-1.5
- docs: `apps/backend/docs/api-websocket-events.md:252-262`,
  `docs/threat-model.md` ("ciphertext travels inside per-device envelopes")
- discussion: issue #184 (`send_message` accepts per-device envelopes),
  issue #180 (migrate insert paths to ciphertext + envelopes), issue #188
  (multi-device self-sync — the sender's own other devices),
  issue #337 (migrate `send_file_message`/`ask_assistant` to envelopes),
  PR #269, PR #310

Citation caveat: `apps/web/src/lib/crypto.ts:256` credits the one-ciphertext-
per-target-device rule to "(#138)" and the `device_set_mismatch` retry to
"(#133)". Neither number is about that work in this repo (#138 pins the
Soroban toolchain, #133 is a withdrawal action); the sibling-device issue is
#188. The behaviour is verified in code; the comment's issue numbers are not
reliable.

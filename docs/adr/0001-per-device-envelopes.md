# ADR 0001: Per-device envelopes instead of shared ciphertext

- Status: accepted
- Date: 2026-09-29

## Context

In Clicked, each user may own multiple active client devices (e.g., mobile phones, desktop browsers, tablets), and each device maintains its own distinct cryptographic identity keys. When delivering messages, the architecture must support end-to-end encryption without granting the server access to plaintext or decryptable key material.

If the backend were to store a single shared ciphertext blob per message encrypted to a conversation-wide secret or shared key:
- Any device (or a compromise of that conversation secret) would be able to read historical and current traffic.
- It would fail to support the pairwise public-key cryptography fundamental to the Phase-1 sealed-box model (where each message is sealed to a specific recipient device's public key) as well as Phase-2 Signal Double Ratchet sessions.
- In multi-device user setups, a sender's other devices ("sibling devices") would not be able to decrypt the message locally for synchronization unless an envelope is specifically encrypted to their respective identity keys ([#188](https://github.com/codebestia/clicked/issues/188)).
- Historical paths that attempted to bypass per-device envelopes—such as early implementations of file messages and assistant replies storing a bare `messages.ciphertext` without corresponding `message_envelopes` rows—resulted in architectural drift and fragmented delivery pipelines ([#337](https://github.com/codebestia/clicked/issues/337)).

To ensure end-to-end cryptographic hygiene, multi-device synchronization, and unified delivery semantics across all message types, an architecture decision was required regarding the unit of ciphertext storage and fan-out.

## Decision

Store one `message_envelopes` row per recipient device rather than a single shared ciphertext per message.

1. **Per-device envelopes:** Message delivery payloads carry an array of per-device envelopes (`recipientDeviceId` + `ciphertext` + optional `protocol`).
2. **Atomic persistence:** Envelope insertion is tied to message insertion inside the same database transaction via `insertMessageEnvelopes` in [`apps/backend/src/lib/messageFanout.ts`](../../apps/backend/src/lib/messageFanout.ts). A message row cannot be committed without its corresponding envelopes.
3. **Sibling-device enforcement:** On both send and edit operations (`send_message`, `edit_message`, and `send_file_message`), the server queries all active, non-revoked sibling devices belonging to the sender via `fetchSiblingDeviceIds` / `findMissingSiblingDeviceIds` in [`apps/backend/src/lib/messageFanout.ts`](../../apps/backend/src/lib/messageFanout.ts) ([#188](https://github.com/codebestia/clicked/issues/188), [#337](https://github.com/codebestia/clicked/issues/337)). If any active sibling device is omitted from the envelopes payload, the server rejects the request with `device_set_mismatch` before persisting data.
4. **Targeted delivery:** Realtime delivery fans out decryptable ciphertext directly to each specific device room (`device:${deviceId}` via `deliverMessage`), while conversation rooms receive a metadata/ciphertext-free notification for UI updates.
5. **Server-authored messages:** Server-authored messages (such as `ask_assistant` responses, [#337](https://github.com/codebestia/clicked/issues/337)) construct broadcast envelopes across all active devices of conversation members via `buildBroadcastEnvelopes` in [`apps/backend/src/lib/messageFanout.ts`](../../apps/backend/src/lib/messageFanout.ts), ensuring consistent envelope fan-out shapes across all message types.

*Exception for MLS Groups:*
MLS (Messaging Layer Security, RFC 9420) group conversations are the explicit exception to per-device envelope fan-out. In MLS groups, a single group ciphertext encrypted under the epoch secret is stored on `messages.ciphertext` tagged with `messages.mls_epoch`, and no `message_envelopes` rows are generated. Mixing `envelopes` with `mlsEpoch` on a message is strictly rejected during payload validation. See [ADR 0006: MLS for groups](./0006-mls-for-groups.md) (or [ADR 0002: Signal for direct messages, MLS for groups](./0002-signal-dms-mls-groups.md)).

## Alternatives considered

- **One shared ciphertext per message (static conversation key):**
  A single ciphertext stored on `messages.ciphertext` using a static shared symmetric key. Rejected because:
  - Every device across all participants would share the same decryption key, collapsing security if a single key or device is compromised.
  - Adding or revoking a device would require rotating the shared key across all participants and either re-encrypting message history or leaving revoked devices capable of reading future messages.
  - As noted in historical discussions ([#188](https://github.com/codebestia/clicked/issues/188), [#337](https://github.com/codebestia/clicked/issues/337)), Clicked's E2EE threat model requires device-level key isolation rather than server-mediated shared secrets.

- **Encrypting only to the recipient user (user-level envelopes) rather than each device:**
  Generating one envelope per recipient user instead of per device. Rejected because cryptographic keys belong to physical devices, not user identities. A newly linked laptop or secondary device cannot decrypt a message encrypted to a user's phone key. Sibling-device envelopes are necessary so that all active devices owned by the sender and recipients can decrypt messages independently locally ([#188](https://github.com/codebestia/clicked/issues/188)).

- **Dual-pipeline routing (shared ciphertext for file/bot messages, envelopes for text):**
  Initially, file messages (`send_file_message`) and assistant responses (`ask_assistant`) bypassed the envelope model and stored shared ciphertexts with zero `message_envelopes` rows ([#337](https://github.com/codebestia/clicked/issues/337)). Rejected because having divergent pipelines created delivery race conditions, broke multi-device sync, and caused double push notifications. Unifying all paths through `messageFanout.ts` eliminated drift.

## Consequences

- **Storage growth:** The `message_envelopes` table grows linearly with the product of messages and recipient devices ($O(\text{messages} \times \text{devices})$). Because envelopes act primarily as transient delivery units and audit records, an automated background garbage collection worker is required to prevent unbounded database growth.
- **Envelope GC job:** To manage envelope storage costs, [`apps/backend/src/services/envelopeGc.ts`](../../apps/backend/src/services/envelopeGc.ts) runs a scheduled, idempotent background pass (`runEnvelopeGcPass`). It prunes envelopes that have been marked delivered past `ENVELOPE_DELIVERED_RETENTION_DAYS` (default 7 days) and envelopes exceeding `ENVELOPE_MAX_AGE_DAYS` (default 30 days) regardless of delivery state, preventing inactive or offline devices from pinning storage indefinitely.
- **Sibling-device enforcement overhead:** Senders must fetch active sibling devices before sending and encrypt distinct payloads for each sibling. Senders failing to cover sibling devices are rejected with `device_set_mismatch` on send and edit in [`apps/backend/src/lib/messageFanout.ts`](../../apps/backend/src/lib/messageFanout.ts), preventing self-sync failures at the cost of strict client-side device tracking.
- **Send payload size:** Message transmission bandwidth grows linearly with recipient device count for DMs. This cost is accepted for 1:1 and small multi-device conversations; large group scalability is addressed separately via MLS ([ADR 0006](./0006-mls-for-groups.md)).

## Status

`accepted`

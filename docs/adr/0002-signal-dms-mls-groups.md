# ADR 0002: Signal for direct messages, MLS for groups

- Status: accepted
- Date: 2026-10-25

## Context

Clicked provides end-to-end encrypted messaging across both 1:1 direct messages (DMs) and multi-user group chats. Initially, the platform shipped on a Phase-1 sealed-box encryption mechanism (ECDH ephemeral-static key agreement + HKDF + AES-256-GCM), generating an independent sealed box per recipient device for each message. While simple to implement, the Phase-1 sealed box lacked critical security properties—notably forward secrecy and break-in recovery (post-compromise security)—and scaled poorly for group conversations.

When designing long-term end-to-end encryption, two distinct communication topologies had to be addressed:
1. **Direct Messages (1:1 conversations):** Two users with typically 1–5 devices each exchanging high-frequency, bidirectional messages.
2. **Group Chats:** Many users with multiple devices per user (potentially dozens or hundreds of member devices total), where group membership changes dynamically (members join, leave, or are removed) and media files are shared across all participants.

Selecting an E2EE protocol architecture required balancing:
- Computational and network fan-out costs on sending devices and relays.
- Message history visibility semantics for newly added members and devices.
- Ecosystem maturity, implementation availability, and cryptographic audit assurance across platforms (Web, Node, and future mobile clients).

Prior analysis and architectural specifications are established in:
- [docs/signal-integration.md](../signal-integration.md) (Signal library evaluation, audit track record, and Phase-1 to Phase-2 migration architecture)
- [apps/backend/docs/signal-migration.md](../../apps/backend/docs/signal-migration.md) (per-device capability negotiation, send-path enforcement, and envelope protocol labelling)
- [apps/backend/docs/mls-group-membership.md](../../apps/backend/docs/mls-group-membership.md) & [docs/group-epoch-sync.md](../group-epoch-sync.md) (MLS group epoch transitions and state sync)
- [apps/backend/docs/mls-group-files.md](../../apps/backend/docs/mls-group-files.md) (single-ciphertext group media distribution)

## Decision

Adopt a split cryptographic architecture: **Signal Protocol (X3DH + Double Ratchet) for direct messages** and **Messaging Layer Security (MLS, RFC 9420) for groups**.

1. **Direct Messages (Signal):**
   - Direct messages use X3DH (Extended Triple Diffie-Hellman) for asynchronous session initiation and the Signal Double Ratchet for per-message forward secrecy and break-in recovery.
   - Senders generate per-device envelopes (`message_envelopes`) for the recipient's devices and the sender's own sibling devices.

2. **Group Conversations (MLS):**
   - Group conversations use MLS (RFC 9420) via TreeKEM and epoch-based group key management.
   - Group messages encrypt application payloads under the current group epoch secret, storing a single ciphertext (`messages.ciphertext`) tagged with `messages.mls_epoch`, eliminating per-device fan-out on send.
   - Group file attachments share a single encrypted object in storage whose content key is distributed within the epoch's MLS message payload.

3. **Transition from Phase-1 Sealed Box:**
   - **No history re-encryption:** Historical messages remain encrypted under their original scheme. `message_envelopes.protocol` (`sealed_box` | `signal` | `mls`, default `sealed_box`) records the exact construction used for each envelope so clients select the appropriate decryption routine without guessing.
   - **Per-device-pair negotiation:** Devices advertise capabilities in `devices.capabilities`. Senders negotiate the strongest mutually supported protocol via `selectProtocol()` on a per-device-pair basis rather than gating on full conversation upgrade.
   - **Strict send-path enforcement:** Backend endpoints refuse envelopes claiming unsupported protocols (400) or protocols weaker than both peers advertise (409).

## Alternatives rejected

- **Pairwise Signal / Double Ratchet for large groups (Sender Keys or per-device fan-out):**
  Rejected due to per-device fan-out overhead. Encrypting every group message and file key individually to $N$ devices requires $O(N)$ encryption operations and bandwidth per send. In a 30-member group with 3 devices per member, each message requires 90 independent ciphertexts. Signal Sender Keys mitigate transmission size but require complex pairwise distribution channels, key synchronization, and lack clean epoch-based forward secrecy when members are evicted.

- **MLS for 1:1 Direct Messages:**
  Rejected due to protocol overhead, state management complexity, and history expectations. MLS operates on epoch transitions (commits, welcomes, and proposals). In 1:1 DMs, establishing and advancing an MLS group tree for two participants introduces unnecessary epoch management and commit round-trips. Furthermore, MLS provides strict post-compromise security where new group epochs intentionally cannot decrypt prior epochs; 1:1 DM user expectations and device synchronization align naturally with pairwise Double Ratchet sessions.

- **Conversation-wide readiness gate for Signal migration:**
  Rejected because waiting for all devices in a conversation to support Signal before upgrading holds back upgraded pairs indefinitely if a single participant device lags. Negotiating per device pair allows immediate forward secrecy for capable pairs.

## Consequences

- **Computational & Network Efficiency:** Groups achieve $O(1)$ ciphertext broadcast and storage per message rather than $O(N)$ fan-out. File encryption scales with group size without duplicating ciphertext in object storage.
- **History Visibility Trade-off:** In MLS groups, newly joined members or newly registered devices cannot decrypt messages sent prior to their join epoch. These messages render as unavailable rather than erroring. In DMs, pairwise ratchets govern ongoing sessions while historical envelopes remain decryptable via their recorded protocol.
- **Client Complexity:** Client implementations maintain two protocol pipelines (Signal session store and ratchet engine for DMs; MLS state, TreeKEM ratcheting, and epoch commit handling for groups), in addition to retaining legacy Phase-1 sealed-box decryption for historical messages.

## Status

**Accepted**

Implementation reality across the stack:
- **Live in production / active runtime:**
  - Database schema and migration baseline: `devices.capabilities` JSONB column, `mls_key_packages`, `mls_groups`, `mls_group_members`, `mls_commits`, and `message_envelopes.protocol` enum (`sealed_box` | `signal` | `mls`).
  - Send-path protocol negotiation (`selectProtocol`) and downgrade rejection (HTTP 400/409) in backend message submission routes.
  - Legacy Phase-1 sealed-box encryption and decryption active across backend and web client.
- **Implemented but not fully wired:**
  - Signal adapter on web (`apps/web/src/lib/signalClient.ts` and `signalSession.ts` implementing X3DH session establishment and symmetric ratcheting behind `SessionCrypto` interface; currently `defaultSession` defaults to `Phase1SessionCrypto`).
  - Prekey replenishment and GC jobs (`deviceGc.ts`, `envelopeGc.ts`).
  - MLS backend state management endpoints (`apps/backend/src/routes/mls.ts`, epoch sync tracking, welcome package transport).
- **Planned / in progress:**
  - Full native `@signalapp/libsignal-client` WASM runtime swap in place of the lightweight symmetric ratchet stub.
  - Complete `@openmls/wasm` integration in the web messaging client for automated MLS commit/welcome processing on group member addition/removal.
  - UI handling for joining devices displaying unavailable message placeholders for pre-join epochs.

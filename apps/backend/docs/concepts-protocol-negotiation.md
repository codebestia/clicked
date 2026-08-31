# Device capability and E2EE protocol negotiation

Clicked encrypts every message once per recipient device, and not every device speaks the
same encryption protocol. A device that shipped before the Signal work landed understands
only the Phase-1 sealed box; a current one also understands the Double Ratchet; an MLS
group member understands a third construction. Negotiation is how the system picks, for
each pair of devices, the strongest construction both of them can actually use — without a
flag day, and without a newer client silently breaking an older one.

This document covers the negotiation layer itself:
[`src/lib/capabilities.ts`](../src/lib/capabilities.ts) (what a device advertises and how a
protocol is chosen) and [`src/services/e2eeProtocol.ts`](../src/services/e2eeProtocol.ts)
(what the server does when a sender claims a protocol on an envelope).

The migration this machinery exists to serve — the rollout order, the per-pair cutover
timeline, and the client-side ratchet work — is documented separately in
[`signal-migration.md`](./signal-migration.md). Read this document for the mechanism, that
one for the plan.

## Contents

- [The capability payload](#the-capability-payload)
- [Advertising capabilities at registration](#advertising-capabilities-at-registration)
- [`normalizeCapabilities` and the baseline default](#normalizecapabilities-and-the-baseline-default)
- [Picking a mutually supported protocol](#picking-a-mutually-supported-protocol)
- [The per-envelope `protocol` column](#the-per-envelope-protocol-column)
- [`checkEnvelopeProtocols` — enforcement on the way in](#checkenvelopeprotocols--enforcement-on-the-way-in)
- [The `protocol_mismatch` rejection, and what a client does with it](#the-protocol_mismatch-rejection-and-what-a-client-does-with-it)
- [Why this enables a staged rollout](#why-this-enables-a-staged-rollout)
- [Implementation references](#implementation-references)

## The capability payload

`devices.capabilities` is a `jsonb` column holding a small document the device publishes
about itself. It is validated by `DeviceCapabilitiesSchema`, and every field is optional:

```jsonc
{
  "protocols": ["sealed_box", "signal"],
  "ciphersuites": ["MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"],
  "fileTransfer": ["file-v1"],
}
```

| Field          | Type       | Meaning                                                                                                                                                                                         |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocols`    | `string[]` | Messaging encryption protocols this device can **decrypt**. Known values are `sealed_box`, `signal`, `mls` (`KNOWN_PROTOCOLS`). `sealed_box` is the Phase-1 ECDH + HKDF + AES-256-GCM envelope. |
| `ciphersuites` | `string[]` | MLS/Signal ciphersuite identifiers. Only consulted when `mls` is present in `protocols`.                                                                                                        |
| `fileTransfer` | `string[]` | File-encryption scheme versions, e.g. `file-v1`. Independent of the messaging protocol; queried through `supportsFileTransfer(capabilities, version)`.                                          |

Two properties of the shape are deliberate and should be preserved:

- **Everything is optional, and the whole document is optional.** A missing field is not an
  error; it means "assume the default for this field".
- **Unrecognised values are preserved, not rejected.** A device may advertise a protocol
  name this server has never heard of. `selectProtocol` ignores it — it only ever matches
  against names in `PROTOCOL_PRIORITY` — but the value survives in the column. This is what
  makes negotiation compatible in both directions: a newer client against an older server
  degrades to a protocol they share instead of failing to register.

`capabilities` is `NOT NULL` with the sealed-box baseline as its schema-level default
(`src/db/schema.ts`), so a device row can never exist without one.

## Advertising capabilities at registration

A device advertises its capabilities on the two paths that create or refresh a device row.
Both accept `capabilities` as an optional member of the device object (`DeviceSchema` in
`src/schemas/auth.schemas.ts`):

| Path                        | Behaviour                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /auth/verify`         | New device → the value is normalised and inserted. Existing device (matched on identity key) → the value is normalised and **updated in place**. |
| `POST /devices/link/verify` | The device-linking registration path. Same treatment.                                                                                            |

The update-in-place case is the **upgrade path**. A client that gains Signal support does
not re-register a new identity: it re-verifies with a larger `protocols` array, and the next
negotiation for that device picks the stronger protocol. Omitting `capabilities` entirely on
a re-verify leaves the stored document untouched — the update only sets the field when the
client actually sent one, so an older build of the same client cannot accidentally downgrade
a device's advertised capabilities to its own.

Capabilities are read back by senders from three places, all of which run the stored value
through `normalizeCapabilities` first:

| Endpoint                           | What it returns                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /devices`                     | The caller's own devices, each with its normalised `capabilities`.                    |
| `GET /user-devices/:id/public-key` | A single peer device's identity key plus its normalised capabilities.                 |
| `GET /conversations/:id/devices`   | Every active member device, with `capabilities` **and** a `negotiatedProtocol` field. |

`negotiatedProtocol` is `selectProtocol(callerDevice, thatDevice).protocol` computed
server-side. It exists so a client does not have to re-implement the preference order to
agree with the server about the answer — a client that computes its own and disagrees is
exactly the client whose sends get rejected.

## `normalizeCapabilities` and the baseline default

```ts
export const BASELINE_PROTOCOL: KnownProtocol = 'sealed_box';
```

`normalizeCapabilities(raw)` turns anything — `null`, `undefined`, a partial object, a
malformed one — into a concrete `DeviceCapabilities`:

1. The value is parsed with `DeviceCapabilitiesSchema.safeParse(raw ?? {})`. **A parse
   failure is not an error**: it returns a copy of `DEFAULT_CAPABILITIES`.
2. An empty or missing `protocols` array becomes `[BASELINE_PROTOCOL]`.
3. `ciphersuites` and `fileTransfer` default to empty arrays.

The result is that **every device supports `sealed_box`, whether it said so or not**. This is
the single assumption the whole design rests on, and it is what makes clients predating the
`capabilities` field work unchanged:

- Rows written before the column existed carry the schema default, which is the baseline.
- A client that never sends `capabilities` gets the baseline.
- A client that sends a document this server cannot parse gets the baseline rather than a
  `500` at registration.

Because the baseline is universal, `selectProtocol` never has to return `null` and no send
path needs a "these two devices cannot talk to each other" branch.

## Picking a mutually supported protocol

`selectProtocol(a, b)` normalises both capability documents, then walks a fixed preference
order and returns the first protocol present in both sets:

```ts
const PROTOCOL_PRIORITY = ['mls', 'signal', 'sealed_box'];
```

The order is strongest-first, so an overlap of `{sealed_box, signal}` resolves to `signal`,
not to the weaker option the two happen to share. If the loop finds nothing — only possible
when a device advertises a protocol set that excludes the baseline — the function falls back
to `{ protocol: 'sealed_box', ciphersuite: null }`.

For `mls`, and only for `mls`, a ciphersuite is negotiated alongside the protocol:
`selectCiphersuite` returns the first entry of `a.ciphersuites` that also appears in
`b.ciphersuites`, preserving the caller's preference order, or `null` when there is no
overlap.

**Negotiation is per device pair, not per conversation.** The envelope model already
encrypts once per recipient device, so a Signal-capable pair inside a group is not held back
by a third member still running an old client: that pair uses Signal today and the laggard
keeps the sealed box until it upgrades.
`protocolsForRecipients(senderDeviceId, recipientDeviceIds)` is the batch form used by
callers that need the answer for a whole fan-out at once; device ids that do not resolve map
to `BASELINE_PROTOCOL`.

## The per-envelope `protocol` column

`message_envelopes.protocol` is an `e2ee_protocol` enum column,
`NOT NULL DEFAULT 'sealed_box'`, whose values mirror `KNOWN_PROTOCOLS`. It is written by
`insertMessageEnvelopes` (`src/lib/messageFanout.ts`), which is shared by the REST send path
and both socket send paths so the default cannot drift between them.

**Why per envelope rather than per device.** The two columns answer different questions, and
only one of them is stable over time:

- `devices.capabilities.protocols` says what a device can decrypt **right now**. It is
  mutable — that is the entire point of the upgrade path above.
- `message_envelopes.protocol` says what a particular ciphertext **was actually built
  with**. It has to stay true forever.

If the protocol were recorded only on the device, then the moment a device advertised
`signal`, every envelope ever written for it would look like a Signal ciphertext. All of its
sealed-box history would become undecryptable — not because the key material is gone, but
because the reader would pick the wrong construction. Recording it per envelope is what lets
pre-cutover history keep decrypting on the Phase-1 path indefinitely, and it is why the
migration that added the column used a defaulted `NOT NULL`: the default backfills every
pre-existing row with the construction those rows really used.

It is also per envelope rather than per **message** because one message fans out to many
devices, and those devices are not all on the same side of the cutover. The same plaintext
can legitimately be a Signal ciphertext for one recipient device and a sealed box for
another, within a single send.

The column is read back on the paths that hand a ciphertext to a client — the delivery
pipeline (`src/services/deliveryPipeline.ts`) and the sync endpoint (`src/routes/sync.ts`) —
so the recipient selects its decryption path from the data rather than guessing from the
bytes.

## `checkEnvelopeProtocols` — enforcement on the way in

Negotiation tells an honest sender what to use. It does not stop a patched, buggy, or
compromised one from claiming something else, so the server re-derives the answer on every
send. `checkEnvelopeProtocols(senderDeviceId, envelopes)` loads the sender device's
capabilities and every named recipient device's capabilities in two queries, then checks each
envelope for two distinct failures:

| Reason                     | Status | Condition                                                                                                               |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `unsupported_by_recipient` | `400`  | The declared protocol is **not** in the recipient's advertised `protocols`. The ciphertext would be undecryptable.      |
| `downgrade`                | `409`  | The declared protocol is supported, but is not the one `selectProtocol` picks for this pair — both sides can do better. |

Details worth knowing:

- **Envelopes naming a device that does not resolve are skipped**, not rejected. The send
  paths already drop those envelopes before persisting, and failing a whole batch because a
  device was revoked between the client's device-list fetch and its send would turn a routine
  race into a user-visible error.
- **Every violation in the batch is reported**, not just the first, so a client can fix one
  send rather than discovering the problem one device at a time.
- **When a batch contains both kinds, the status is `400`.** Undecryptability is the more
  specific and more serious failure, so it decides the code.
- The check runs **before anything is persisted**, on `POST /messages`
  (`src/routes/messages.ts`) and on the `send_message` socket handler
  (`src/socket/messaging.ts`). Envelopes with no explicit `protocol` default to
  `BASELINE_PROTOCOL` in the schema (`EnvelopeSchema`), so an older client that never sends
  the field is checked as a sealed-box sender — which is exactly what it is.

## The `protocol_mismatch` rejection, and what a client does with it

Over REST the failure is the status code from the table above with a body of:

```jsonc
{
  "error": "Envelope protocol is not supported by the recipient device",
  "violations": [
    {
      "recipientDeviceId": "…",
      "declared": "signal",
      "expected": "sealed_box",
      "reason": "unsupported_by_recipient",
    },
  ],
}
```

Over the socket the same information arrives as an `error` event with
`event: 'protocol_mismatch'`, carrying `code` (`400` or `409`), `message`, and the identical
`violations[]` array. See [`contracts-error-catalog.md`](./contracts-error-catalog.md) for
where this sits among the other socket error events.

**`protocol_mismatch` is not retryable as sent.** Resending the same envelope set produces
the identical rejection. The client should:

1. **Re-fetch the recipient device list.** `GET /conversations/:id/devices` is the one call
   that returns both `capabilities` and the server's own `negotiatedProtocol` per device. The
   most common cause of a mismatch is a stale device list: the peer upgraded, or a new device
   joined, after the sender last looked.
2. **Re-encrypt each envelope with the protocol the server names.** `violations[].expected`
   already says what should have been used for that specific device, so a client can act on
   the response without a second round trip if it trusts its own key state.
3. **Resend the whole message.** Nothing was persisted, so this is a fresh send rather than a
   retry of a partial one. Reuse the same `messageId` — the send paths are idempotent on it,
   see [`concepts-replay-protection.md`](./concepts-replay-protection.md).
4. **Do not fall back to a weaker protocol.** A `409 downgrade` means precisely that the
   client already tried that. Downgrading again in response to a downgrade rejection is a
   retry loop whose only successful outcome is the thing the check exists to prevent.

A `downgrade` violation naming a device the client believes cannot do better is a signal that
the client's cached capability document is stale, not that the server is wrong — the server
read the row a moment ago.

## Why this enables a staged rollout

Together the four pieces give a sealed-box → Signal rollout with no coordinated cutover:

1. **Old clients keep working with no change at all.** They never send `capabilities`, so
   they are read as sealed-box-only. They never send `protocol`, so their envelopes default
   to `sealed_box`. Both defaults are applied server-side; nothing about an old client has to
   know this feature exists.
2. **A new client is useful before anyone else upgrades.** It advertises
   `["sealed_box", "signal"]`. Against an old peer, `selectProtocol` finds only `sealed_box`
   in common and the pair keeps working exactly as before. Against another new peer, the same
   code picks `signal` — with no server config change, no feature flag, and no
   per-conversation gate.
3. **Progress is monotonic per pair, and independent across pairs.** A pair cuts over the
   moment both sides advertise the stronger protocol, and the `downgrade` check stops them
   from silently sliding back. One user's laptop can be on Signal with one contact and on the
   sealed box with another, in the same conversation, at the same time.
4. **History is never re-encrypted.** Every envelope carries the construction that produced
   it, so a cutover changes what is written next and never what was written before. There is
   no migration job to run, and no window during which old messages are unreadable.
5. **The same machinery carries the next protocol.** Adding MLS meant adding a name to
   `KNOWN_PROTOCOLS`, a value to the enum, and an entry at the top of `PROTOCOL_PRIORITY`. The
   negotiation, enforcement, and recording paths did not change.

The cost of all this is one rule for contributors: **a new encryption construction must be
added to `KNOWN_PROTOCOLS`, to the `e2ee_protocol` enum, and to `PROTOCOL_PRIORITY` in the
same change.** A protocol missing from the enum cannot be recorded; a protocol missing from
the priority list can be advertised but will never be selected, which presents as "both
devices support Signal and it is still sending sealed boxes".

## Implementation references

| Concern                                      | File                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability shape, defaults, selection        | [`src/lib/capabilities.ts`](../src/lib/capabilities.ts)                                                                                                                           |
| Enforcement and batch negotiation            | [`src/services/e2eeProtocol.ts`](../src/services/e2eeProtocol.ts)                                                                                                                 |
| `capabilities` and `protocol` columns        | [`src/db/schema.ts`](../src/db/schema.ts)                                                                                                                                         |
| Registration input schema                    | [`src/schemas/auth.schemas.ts`](../src/schemas/auth.schemas.ts)                                                                                                                   |
| Envelope input schema and `protocol` default | [`src/schemas/message.schemas.ts`](../src/schemas/message.schemas.ts)                                                                                                             |
| Writing the per-envelope protocol            | [`src/lib/messageFanout.ts`](../src/lib/messageFanout.ts)                                                                                                                         |
| REST send enforcement                        | [`src/routes/messages.ts`](../src/routes/messages.ts)                                                                                                                             |
| Socket send enforcement                      | [`src/socket/messaging.ts`](../src/socket/messaging.ts)                                                                                                                           |
| Capability read-back endpoints               | [`src/routes/devices.ts`](../src/routes/devices.ts), [`src/routes/userDevices.ts`](../src/routes/userDevices.ts), [`src/routes/conversations.ts`](../src/routes/conversations.ts) |
| Tests                                        | `src/__tests__/e2eeProtocol.test.ts`, `src/__tests__/signalMigration.routes.test.ts`, `src/__tests__/signalInvariants.socket.test.ts`                                             |

## Related documents

- [Phase-1 → Signal migration](./signal-migration.md) — the rollout plan this mechanism
  serves.
- [Error code and response catalog](./contracts-error-catalog.md) — `protocol_mismatch`
  alongside every other error the backend returns.
- [Replay protection and event idempotency](./concepts-replay-protection.md) — why resending
  a rejected message with the same `messageId` is safe.
- [Delivery fan-out and receipts](./concepts-delivery-fanout.md) — how the envelopes this
  document validates reach devices.

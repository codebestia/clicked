# ADR-0006: MLS for groups — one group ciphertext, epochs as the unit of membership

- **Status:** accepted
- **Date:** backfilled 2026-09-23 (decision predates this record)

## Context

DMs use per-device envelopes (ADR-0004). Applying the same model to a group
means encrypting the message separately for every device of every member. In a
30-person group with 3 devices each that is 90 ciphertexts for one message, and
it grows again every time someone links a new device.

It also has no answer for removal. If a member holds a key that decrypts
messages addressed to them and the sender must remember to stop addressing
them, "removed from the group" is a server-side bookkeeping rule rather than a
cryptographic fact — and a removed device that kept its key can still read
anything sent to it before the removal.

Issue #370 fixed the shape: group messages are encrypted once with the group key
and stored as a single `messages.ciphertext`, delivered to every member device.

## Decision

Group conversations run MLS (RFC 9420), with the server as transport and
ordering service only.

- The group's unit of membership is the **epoch**. A device's leaf exists from
  the commit that added it, so it reads epoch `e` when
  `joined_at_epoch <= e < (removed_at_epoch ?? infinity)`
  (`apps/backend/src/lib/mlsVisibility.ts`). Membership is an epoch interval,
  not a flag; a device removed and re-added gets a second row and genuinely
  cannot read the epochs it was absent for.
- One ciphertext per group message, not one per device. The sender includes
  `mlsEpoch`; when it is present the per-device envelope requirement does not
  apply and `envelopes` alongside it is rejected. The sibling-device coverage
  check is skipped, because a group ciphertext already reaches every device in
  the tree.
- The server stores public group state only: `mls_groups` (id, cipher suite,
  current epoch), `mls_group_members` (epoch intervals), `mls_commits`
  (append-only commit log), `mls_welcomes` (Welcome messages held for offline
  devices), `mls_key_packages`. It never holds a group secret or a ratchet key.
- Commits are epoch-serialized. `epoch` must be exactly `current_epoch + 1`; the
  group row is locked for the write, so two simultaneous commits get one winner
  and one `409` with the expected epoch to retry against.
- A message a device cannot decrypt comes back with `ciphertext: null`,
  `unavailable: true` and a reason
  (`mls_no_key_before_join`, `mls_no_key_after_removal`,
  `mls_not_a_group_member`), applied server-side on both read paths.

## Consequences

- Group size no longer multiplies ciphertexts. File sharing follows the same
  rule: the file is encrypted once with a random file key, and the file key
  travels inside the MLS group message, so object storage holds one object
  instead of ninety (`apps/backend/docs/mls-group-files.md`).
- Removal is cryptographic: a removed device holds no key for any later epoch.
  The same property is why a newly linked device cannot read history — there is
  no server-held key to hand it, by design.
- A newly linked device joins late and reads from its join epoch onward; earlier
  messages render as a labelled "unavailable on this device" placeholder. Users
  must be told this, and the API exposes `historyAvailableFromEpoch` so the
  client can render one divider instead of a wall of broken rows.
- The server becomes a sequencing service for commits, with a lock on the group
  row and a conflict path clients must handle by re-deriving and retrying.
- A device that is offline when it is added still gets added, because Welcomes
  are held for it and claimed later.
- Group messaging is only reachable by clients that implement MLS. This is a
  separate code path from the DM envelope path, not a variant of it.
- Groups with no MLS group (plain `dm`, or a group that never adopted MLS) fall
  back to the per-device envelope model; `mls_epoch` is null for those rows.

## Alternatives rejected

- **Per-device envelope fan-out for group content and group files.** The
  explicit rejected alternative: "In a 30-person group with 3 devices each that
  is 90 copies of the same bytes, and it grows again on every new device"
  (`apps/backend/docs/mls-group-files.md`, "Why one ciphertext"). MLS was chosen
  because the group already agrees on epoch secrets, so no server-side key is
  needed at all.
- **Sending `envelopes` together with `mlsEpoch`.** Rejected outright:
  "mixing the two key-distribution models on a single message leaves recipients
  with no unambiguous rule for which ciphertext to decrypt"
  (`apps/backend/docs/mls-group-membership.md:278-283`;
  `apps/backend/src/lib/validateMessagePayload.ts:15-19`).
- **Backfilling history to a newly linked device** (from an existing device
  re-encrypting and re-sending past plaintext). Not done now — it is recorded as
  a separate, deferred feature ("a history/recovery service", issue #372) and is
  the only way the "no history for new device" property would change.
- **Surfacing unreadable messages as an error, or omitting them.** Rejected:
  an error is indistinguishable from tampering and trains users to dismiss a
  real signal; omitting them hides that the conversation happened and puts a
  gap in the timeline. Placeholders keep sender, timestamp and epoch.
- **Checking the epoch window client-side.** Rejected: "the client cannot forget
  to check" — the rule is applied on both server read paths
  (`lib/mlsVisibility.ts`, used by `routes/conversations.ts` and the socket
  `message_history` handler).
- **Sender-keys / a pairwise-ratchet group construction** — a common alternative
  to MLS for groups. There is no record of it being evaluated in this repo, so
  no rejection rationale can be given. Marked unverified.
- **A server-held group key** (server derives or stores group secrets to make
  fan-out easy). Rejected implicitly by the whole design — the server is
  explicitly a transport that never holds group secrets
  (`apps/backend/src/db/schema.ts:316-330`, `docs/threat-model.md`). No review
  thread found; treat as design posture rather than a recorded debate.

## Sources

- schema: `apps/backend/src/db/schema.ts:316-490` (`mlsGroups`,
  `mlsGroupMembers`, `mlsCommits`, `mlsWelcomes`, `mlsKeyPackages`),
  `messages.mlsEpoch`
- epoch rule: `apps/backend/src/lib/mlsVisibility.ts`,
  `apps/backend/src/services/mlsGroups.ts`
- routes: `apps/backend/src/routes/mls.ts`; read paths
  `apps/backend/src/routes/conversations.ts`, `apps/backend/src/socket/messaging.ts`
- docs: `apps/backend/docs/mls-group-membership.md` (canonical),
  `apps/backend/docs/mls-group-files.md`, `apps/backend/docs/mls-key-packages.md`,
  `docs/group-epoch-sync.md` (the separate group-control sequence log)
- tests: `apps/backend/src/__tests__/mls.routes.test.ts`,
  `mlsGroups.service.test.ts`, `mlsVisibility.test.ts`, `mls.history.test.ts`,
  `mlsGroupFiles.test.ts`, `mlsKeyPackages.test.ts`
- discussion: issue #370 (single ciphertext for groups), issue #372 (new-device
  join and the deferred recovery service), PR #418, PR #425 (epoch sync +
  system events), PR #426 (group MLS fan-out), PR #530, PR #531, PR #532

Caveat: the doc names migrations `0001_mls_group_state.sql`,
`0001_group_control_events.sql` and `0004_envelope_protocol.sql`. None of those
files are in this tree — `apps/backend/drizzle/` contains only
`0000_lean_scrambler.sql` (plus `meta/`), where the `mls_*` tables, the
`e2ee_protocol` enum and `group_control_events` all exist. The schema is
verifiable; the individual migration files named in the docs are not.

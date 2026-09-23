# Architecture Decision Records

Decisions this codebase has made, and the ones it made and took back. Each
record states the context, the decision, its consequences, what was rejected,
and where to check it in the code.

These were backfilled from the repository — schema comments, route headers, the
`docs/` set, migration files and the review history — rather than written from
memory. Where the record does not substantiate why an alternative was rejected,
the ADR says so instead of supplying a rationale.

## Records

| ADR                                                          | Decision                                                                        | Status                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------- |
| [0000-template.md](./0000-template.md)                       | Template for new records                                                        | —                                   |
| [0001](./0001-single-devices-table.md)                       | One canonical `devices` table; no second device store                           | accepted (supersedes 0008)          |
| [0002](./0002-message-ordering-by-createdat-id.md)           | Order messages by `(createdAt, id)`, not a per-conversation sequence counter    | accepted (supersedes 0007)          |
| [0003](./0003-ciphertext-only-message-storage.md)            | Ciphertext-only message storage; legacy plaintext archived, not tombstoned       | accepted                            |
| [0004](./0004-per-device-envelopes.md)                       | Per-device envelopes for DMs, not one shared ciphertext                          | accepted                            |
| [0005](./0005-sealed-box-to-signal-migration.md)             | Phase-1 sealed box → Phase-2 Signal, negotiated per device pair, history never rewritten | accepted (migration not yet activated) |
| [0006](./0006-mls-for-groups.md)                             | MLS for groups: one group ciphertext, epochs as the unit of membership           | accepted                            |
| [0007](./0007-per-conversation-sequence-numbers.md)          | Per-conversation monotonic `sequence_number` for chat messages                   | **superseded** by 0002              |
| [0008](./0008-separate-user-devices-table.md)                | A separate `user_devices` table for device identity                              | **superseded** by 0001              |

0007 and 0008 are numbered last because they were backfilled from the decisions
that replaced them, not because they came later. Their subject matter belongs
next to 0002 and 0001 respectively.

## Statuses used

- **accepted** — the rule stands and the code enforces it.
- **superseded** — the decision was made, shipped, and replaced. The record is
  kept because the replacement only makes sense against what it replaced, and
  because remnants of the old decision are still in the tree.
- **proposed** — not used yet; see the template.

## Adding a record

1. Copy `0000-template.md` to `NNNN-short-slug.md`, using the next free number.
2. Fill in context, decision, consequences and the alternatives that were
   actually rejected — with the reason, and a note if the reason is not
   recorded anywhere.
3. Add a row to the table above with its status.
4. If the record replaces another, edit the old one's status to
   `superseded by ADR-NNNN` and link both ways.

Keep records checkable: cite file paths, schema symbols, migration names and
issue/PR numbers, and prefer short over complete. A record nobody can verify is
a liability.

## Further reading

- `apps/backend/docs/signal-migration.md` — the Phase-1 → Signal cutover in full
- `apps/backend/docs/message-encryption-migration.md` — the ciphertext-only cutover in full
- `apps/backend/docs/mls-group-membership.md` — MLS group membership and new-device join
- `apps/backend/docs/api-devices.md` — the device registry surface
- `docs/threat-model.md` — what the server can and cannot see
- `docs/group-epoch-sync.md` — why group control has the sequence counter that chat messages don't

Cross-referenced from [`IMPLEMENTATION_DOCS.md`](../../IMPLEMENTATION_DOCS.md).
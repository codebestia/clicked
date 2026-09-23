# ADR-0008: A separate `user_devices` table for device identity

- **Status:** superseded by [ADR-0001](./0001-single-devices-table.md)
- **Date:** backfilled 2026-09-23 (decision and its reversal both predate this record)

## Context

This record exists because the decision shipped and was then undone. It is kept
so that the `GET /user-devices/:id/public-key` route — which still exists — has
an explanation, instead of looking like an accident.

The first device-identity work needed a place to store an Ed25519 identity
public key per device, plus prekeys and revocation state. The realtime work
needed a list of "devices that can receive a socket delivery" with last-seen
timestamps and push subscriptions. These were treated as separate concerns and
got separate tables.

PR #206 added the `user_devices` device-identity schema; PR #207 added
`GET /devices` listing from it.

## Decision

Device identity lived in `user_devices`; delivery/presence/push device state
lived in `devices`.

## Consequences

- Two tables described the same real-world object with no constraint tying them
  together. A device revoked in one was still a delivery target in the other,
  and neither table could tell the other it was wrong.
- Sibling-device coverage checks (issue #188) resolved against one table while
  the auth layer resolved against the other, so "all of the sender's devices
  have an envelope" could be true of the set the send path knew about and false
  of the set auth would accept a login from.
- Two write paths had to be kept in step for every device lifecycle event
  (register, revoke, logout-everywhere, stale-flag), and nothing enforced that
  they were.

## Alternatives rejected

None recorded at the time. The alternative — one table with the union of the
columns — is what replaced it, and is recorded in ADR-0001.

## Sources

- discussion: PR #206 (added `user_devices`), PR #207 (`GET /devices` from it)
- reversal: `apps/backend/src/routes/devices.ts:1-7` (the merge rationale is in
  the file's header comment), `apps/backend/docs/api-devices.md:14-17`
- remnant: `apps/backend/src/routes/userDevices.ts`, mounted at `/user-devices`
  and documented in `apps/backend/docs/api-devices.md` as a legacy alias that
  exposes a public-key lookup only
- current model: ADR-0001 (one canonical `devices` table)
# ADR-0001: One canonical `devices` table

- **Status:** accepted
- **Date:** backfilled 2026-09-23 (decision predates this record)

## Context

Two device-shaped concerns arrived at different times: auth/prekey identity
(a device has an Ed25519 identity key, publishes prekeys, gets revoked) and
realtime/push plumbing (a device has a socket, a last-seen timestamp, a Web Push
subscription, and is an envelope recipient).

The first pass gave the identity side its own table,
`user_devices` (PR #206), with `GET /devices` listing from it (PR #207). The
second pass needed "which devices should this envelope be fanned out to, and
which of them are online" — answered from a different table. Nothing kept the
two in sync: a device could be revoked in one and still be an envelope
recipient in the other, and a sibling-device coverage check
(`services/messageFanout.ts`, `fetchSiblingDeviceIds`) could pass while the
realtime layer delivered to a device the auth layer considered gone.

## Decision

There is exactly one device registry, `devices`, and every other device-shaped
fact is a column on it or a foreign key into it.

- `devices` carries identity (`identity_public_key`, `registration_id`),
  liveness (`last_seen_at`, `push_enabled`, `revoked_at`, `stale_flagged_at`),
  and capability advertisement (`capabilities`).
- `messages.sender_device_id`, `message_envelopes.recipient_device_id`,
  `push_subscriptions.device_id`, `device_prekeys.device_id`,
  `device_key_history.device_id`, and the `mls_*` tables all FK into `devices`.
- `routes/userDevices.ts` is kept as a legacy alias route exposing only a
  public-key lookup, not a second store.
- Uniqueness is per `(user_id, identity_public_key)` — the same identity key
  re-registering is the same device, not a new row.

## Consequences

- Revocation is one write with one meaning: `revoked_at` on `devices` is
  respected by the auth layer, the envelope fan-out path
  (`isNull(devices.revokedAt)` in `lib/messageFanout.ts`,
  `services/deliveryPipeline.ts`, `services/fanout.ts`,
  `services/pushFilter.ts`) and push at the same time. There is no window
  where the tables disagree.
- `revoked_at` is a timestamp rather than a boolean, so revocation keeps audit
  history and records *when* it happened.
- The table is now on the hot path for auth, messaging, realtime and push. Every
  new device-shaped requirement adds a column to it, and a partial index
  (`devices_user_id_active_idx`) exists so the common "active devices for this
  user" query does not have to scan revoked rows.
- Deleting a device row cascades to prekeys, envelopes and push subscriptions;
  `DELETE /devices/:id` therefore revokes instead of deleting.

## Alternatives rejected

- **A separate `user_devices` table for identity, `devices` for realtime**
  (shipped in PR #206, then merged away). Rejected because the two tables could
  silently diverge: a revoked device would keep receiving envelopes. The
  comment in `routes/devices.ts` records the merge explicitly.
- **A boolean `is_revoked` instead of `revoked_at`.** Rejected in favour of the
  timestamp, which preserves audit history and supports the device-GC staleness
  window. The frontend `Device.isRevoked` type is a leftover of the boolean
  shape and is documented as drift (`apps/web/docs/contracts-response-types.md`,
  DRIFT-2).
- **Deleting revoked device rows** rather than keeping them with `revoked_at`.
  Rejected: it would cascade-delete audit-relevant history and orphan
  envelope/prekey rows.

## Sources

- schema: `apps/backend/src/db/schema.ts:220-270` (`devices`, `devicePrekeys`)
- routes: `apps/backend/src/routes/devices.ts:1-7` (merge rationale),
  `apps/backend/src/routes/userDevices.ts`
- migration: `apps/backend/drizzle/0000_lean_scrambler.sql` (`CREATE TABLE
  "devices"`, `devices_user_identity_idx`, `devices_user_id_active_idx`)
- docs: `apps/backend/docs/api-devices.md:14-18`
- discussion: PR #206 (`user_devices` identity schema, later merged away),
  PR #207 (`GET /devices`); issues #103/#107 are cited by the route comment

Verified by:

```sh
grep -rn "devices" apps/backend/drizzle/0000_lean_scrambler.sql
```

which shows `messages.sender_device_id`,
`message_envelopes.recipient_device_id`, `push_subscriptions.device_id`,
`device_prekeys.device_id` and the `mls_*` tables all referencing
`public.devices(id)`, and by the absence of any other `%device%` table in the
create statements.

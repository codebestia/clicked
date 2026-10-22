# Push notification decision matrix

The question this document answers: **will this user get a push notification for this
message?** The rules are shared by both send paths — `dispatchOfflinePush` (text
messages, `services/pushNotification.ts`) and `sendPushForMessage` (file/image/video/
audio messages, `services/push.ts`) — both call the same filter,
`getEligiblePushRecipients` in `services/pushFilter.ts`, then both hand their eligible
device list to the same `queueCoalescedPush`, so from the coalescing window onward the
two paths are identical.

## Contents

- [Decision table](#decision-table)
- [Online granularity: does one device suppress push to the rest?](#online-granularity-does-one-device-suppress-push-to-the-rest)
- [Coalescing and rate limiting](#coalescing-and-rate-limiting)
- [What the push payload contains](#what-the-push-payload-contains)
- [A real asymmetry between the two paths](#a-real-asymmetry-between-the-two-paths)
- [Tests that pin this behavior](#tests-that-pin-this-behavior)
- [Implementation references](#implementation-references)

## Decision table

`getEligiblePushRecipients` runs these filters in order; a device that fails any one of
them never reaches the coalescing/send step. Each row below is independently sufficient
to suppress a push for a given device — the end result is the intersection of every
row's "eligible" column.

| Filter | Checked against | Device is excluded when | Checked in |
|---|---|---|---|
| Is the sender | `senderId` param | The device's owner is the message's sender | Step 1 (member filter) |
| Conversation muted | `conversationMembers.isMuted` | The device owner has muted this conversation | Step 1 |
| User online (any device) | Redis presence hash, `isOnline()` | The device owner has **any** live socket connection, on any device | Step 2 |
| `devices.pushEnabled` | `devices.pushEnabled` | The device has push disabled | Step 3 |
| Device revoked | `devices.revokedAt` | The device has been revoked (`IS NOT NULL`) | Step 3 |
| Explicit recipient list, if given | `recipientDeviceIds` param | The device isn't in the caller-supplied list (text path only — see [below](#a-real-asymmetry-between-the-two-paths)) | Step 4 |
| Device connected (per-device) | Redis connection registry, `isDeviceConnected()` | The device itself has a live socket, independent of the user-level check above | Step 5 |

If `redis` is unavailable at all (the `options.redis` param is `null`/`undefined`), the
user-online check (step 2) is skipped entirely and every non-muted, non-sender member is
treated as offline — a deliberate best-effort fallback so push still works (if
noisier) when Redis presence tracking is down, rather than failing to push at all.

## Online granularity: does one device suppress push to the rest?

**Yes.** `isOnline(redis, userId)` (`services/presence.ts`) checks
`redis.hlen(presenceHashKey(userId)) > 0` — a single hash keyed by **user**, not by
device, where every currently-connected device of that user has an entry. If the user
has even one live socket connection anywhere, `isOnline` returns `true` for that user,
and step 2 excludes **all** of that user's devices from the candidate set before
`devices.pushEnabled`/`revokedAt` are even checked.

This means: a user reading messages on their laptop receives no push notifications on
their phone for the same conversation, even though the phone itself has no open socket
and would otherwise be a perfectly eligible push target. Push suppression is per-user,
not per-device, at this layer.

Step 5's `isDeviceConnected` check is a separate, genuinely per-device registry lookup
(`services/deviceRevocation.ts`, backed by the same cross-node Redis registry
device-revocation checks use) — it is not redundant with step 2. It exists to catch a
device that is itself connected but whose owner's aggregate presence hash hasn't
reflected that yet (a narrow race, not the common case), and it's the only point in the
pipeline that would ever disagree with step 2 in practice. For the common case — a user
with no connections anywhere — both checks agree and either one alone would suffice.

## Coalescing and rate limiting

Once a device passes every filter above, `queueCoalescedPush(deviceId, conversationId,
messageId)` is called — by both send paths — which layers two more behaviors on top of
the eligibility decision, per device:

1. **Coalescing window (`COALESCE_WINDOW_MS`, 2 seconds)**: a `Map` keyed by
   `` `${deviceId}:${conversationId}` `` tracks a pending push. Every call within the
   window for the same device+conversation increments a `count` and updates
   `latestMessageId` instead of scheduling a new push — a burst of N messages (including
   a mix of text and file messages, since both paths share this map) to the same device
   in the same conversation produces exactly one push, reporting the burst's `count` and
   only the most recent `messageId`.
2. **Per-device rate limit (`RATE_LIMIT_WINDOW_MS`, 30 seconds)**: when the coalescing
   timer fires (`flushPush`), it checks `lastPushSentAt` for that device; if a push was
   sent to it within the last 30 seconds, this flush is dropped entirely — not queued,
   not deferred, just skipped. A device that's receiving pushes faster than once every
   30 seconds will miss some flush cycles outright, not merely have them delayed.

So the full answer to "will this user get a push for this message" has to account for
both layers: a device that's eligible per the table above still might not get **this
specific** push if it's absorbed into a coalesced batch (and reported via that batch's
`count` instead) or dropped by the 30-second rate limit.

## What the push payload contains

```ts
const payload = JSON.stringify({ type: 'new_message', conversationId, messageId, count });
```

**No message content, plaintext or ciphertext, is ever in the push payload.** The client
receiving this payload has `conversationId`, `messageId`, and how many messages were
coalesced into this notification — enough to show a generic "N new messages in
[conversation]" notification and let the user's own client fetch and decrypt the actual
content once they open the app. This is consistent with the server never holding
decryptable plaintext for E2EE conversations in the first place (see
[`concepts-crypto-invariants.md`](./concepts-crypto-invariants.md)) — even if it wanted
to put message content in a push payload, it has no plaintext to put there for a real
E2EE message. (The one exception elsewhere in the codebase, the AI assistant's reply, is
delivered through the same `message_envelope` fan-out as any other message — see
[`concepts-ai-assistant-bridge.md`](./concepts-ai-assistant-bridge.md) — not through push,
so it doesn't change this.)

## A real asymmetry between the two paths

`dispatchOfflinePush` (text) is always called with an explicit `recipientDeviceIds` list
(step 4 of the table), so `getEligiblePushRecipients` intersects the DB-discovered
eligible devices against that caller-supplied set. `sendPushForMessage` (file messages,
in `services/push.ts`) calls `getEligiblePushRecipients` **without**
`recipientDeviceIds` at all, so step 4 is a no-op for that path — it always relies purely
on discovery from `conversationMembers`. In practice both paths are invoked once per
message for "every member's devices," so this rarely produces a different result, but
it is a real difference in the function's call contract between the two callers, not
just a documentation nuance: a future caller of `sendPushForMessage` that wanted to
target a specific device subset (the way `dispatchOfflinePush` can) would find no
parameter to do so.

## Tests that pin this behavior

- `apps/backend/src/__tests__/pushFilter.test.ts` — the eligibility table above:
  sender exclusion, muted conversations, `devices.pushEnabled`, revoked devices, the
  per-device connection check, and the Redis-unavailable fallback.
- `apps/backend/src/__tests__/pushNotification.test.ts` — coalescing window behavior,
  the per-device rate limit, dead-subscription pruning (410/404) and transient-failure
  backoff, and the payload shape.

## Implementation references

- `apps/backend/src/services/pushFilter.ts` — `getEligiblePushRecipients`, the shared decision table
- `apps/backend/src/services/presence.ts` — `isOnline` (per-user presence hash)
- `apps/backend/src/services/deviceRevocation.ts` — `isDeviceConnected` (per-device registry)
- `apps/backend/src/services/pushNotification.ts` — `dispatchOfflinePush`, `queueCoalescedPush`, `flushPush`, `sendWebPush`, backoff/pruning hygiene
- `apps/backend/src/services/push.ts` — `sendPushForMessage`, the file-message path
- `apps/backend/src/__tests__/pushFilter.test.ts`, `apps/backend/src/__tests__/pushNotification.test.ts`

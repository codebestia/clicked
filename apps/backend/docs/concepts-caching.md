# Backend caching reference

The backend caches exactly one thing in Redis: the conversation list a signed-in user sees
when the app opens. That is the query that runs on every cold start and every foreground
resume, it fans out into several joins and two aggregate subqueries, and its result changes
only when something in the conversation actually changes. Everything else the backend puts in
Redis — presence, rate-limit buckets, replay markers, pub/sub fan-out — is coordination state
rather than a cache, and is covered elsewhere.

This document is the reference for that cache: what is stored, under what key, for how long,
every path that invalidates it, what happens when Redis is not there, and the one scoping
hazard the key format has to respect.

## Contents

- [What is cached](#what-is-cached)
- [The cache key](#the-cache-key)
- [Read and write paths](#read-and-write-paths)
- [Invalidation](#invalidation)
- [Degraded behaviour when Redis is unavailable](#degraded-behaviour-when-redis-is-unavailable)
- [The per-device scoping hazard](#the-per-device-scoping-hazard)
- [Other Redis key namespaces (not caches)](#other-redis-key-namespaces-not-caches)
- [Implementation references](#implementation-references)

## What is cached

| Property    | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Key         | `conversations:{userId}` — built by `convCacheKey(userId)` in `src/lib/redis.ts` |
| Value       | The JSON body of `GET /conversations`, as a string (`JSON.stringify(result)`)    |
| TTL         | `CONV_CACHE_TTL` = **30 seconds**, applied with `SETEX`                          |
| Written by  | `GET /conversations` (default view only)                                         |
| Read by     | `GET /conversations` (default view only)                                         |
| Invalidated | `invalidateConversationCaches(userIds)` and one direct `DEL` — see below         |

The payload is the complete response array, one entry per conversation the user belongs to:

```jsonc
[
  {
    "id": "…",
    "type": "dm",
    "name": null,
    "avatarUrl": null,
    "createdAt": "…",
    "messages": [
      /* the single most recent message, with the ciphertext envelope
         addressed to the *requesting device* */
    ],
    "isMuted": false,
    "isArchived": false,
    "messageCount": 42,
    "unreadCount": 3,
  },
]
```

That embedded `messages[0]` is the conversation-list preview, and it is the reason the rest of
this document is more careful than a 30-second cache would normally justify: the preview is
**device-specific**, because the envelope it carries is the one encrypted for the requesting
device and no other device can decrypt it.

The TTL is deliberately short. Thirty seconds is long enough to absorb the burst of list
requests an app makes while starting up and reconnecting, and short enough that any
invalidation this document has missed self-heals within half a minute instead of persisting
until the user acts.

## The cache key

```ts
export function convCacheKey(userId: string): string {
  return `conversations:${userId}`;
}
```

Everything that touches the cache goes through this function rather than formatting the
string inline, so the format has exactly one definition. Two consequences of the current
shape are worth stating explicitly:

- **It is scoped to the user, not to the request.** The archived view is a different result
  set, so it is neither read from nor written to the cache at all — `?archived=true` skips
  both branches rather than using a second key. See
  [the per-device scoping hazard](#the-per-device-scoping-hazard) for the dimension this key
  does _not_ currently carry.
- **It is a plain string key with a TTL, not a hash or a set.** Invalidation is `DEL`, never a
  partial update: no path rewrites part of a cached list. A change invalidates the whole entry
  and the next read rebuilds it from Postgres.

## Read and write paths

Both live in `GET /conversations` (`src/routes/conversations.ts`) and both are guarded twice —
once on `redis` being non-null, and once by a `try`/`catch`:

```ts
// Read — skipped entirely for the archived view
if (!showArchived && redis) {
  try {
    const cached = await redis.get(key);
    if (cached) {
      res.json(JSON.parse(cached) as unknown);
      return;
    }
  } catch {
    // Fall through to the database on any Redis error
  }
}

// … build `result` from Postgres …

// Write — same two conditions
if (!showArchived && redis) {
  try {
    await redis.setex(key, CONV_CACHE_TTL, JSON.stringify(result));
  } catch {
    // Ignore — the response is already computed
  }
}
```

A cache miss, a Redis error, and a Redis that was never configured all converge on the same
path: query Postgres and answer from it. The write is best-effort and happens after the
response body exists, so a failure to cache cannot fail a request.

## Invalidation

`invalidateConversationCaches(userIds)` (`src/lib/conversationCache.ts`) is the single
invalidation helper:

```ts
export async function invalidateConversationCaches(userIds: string[]): Promise<void> {
  if (!redis || userIds.length === 0) return;
  const client = redis;
  await Promise.allSettled([...new Set(userIds)].map((userId) => client.del(convCacheKey(userId))));
}
```

Three properties: it de-duplicates the id list, it deletes in parallel, and it uses
`Promise.allSettled` so one failing `DEL` does not reject the whole call or abandon the
remaining users. Callers pass **every member of the affected conversation**, because a change
to one conversation changes every member's list.

### Every call site

| #   | Trigger (the event a user would describe)                                                                                        | Call site                                             | Users invalidated                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | Members added to a conversation (`POST /conversations/:id/members`)                                                              | `src/routes/conversations.ts:419`                     | All members after the change                                                       |
| 2   | Conversation metadata updated — name, avatar (`PATCH /conversations/:id`)                                                        | `src/routes/conversations.ts:529`                     | All members                                                                        |
| 3   | The last member leaves, so the conversation row is deleted (`DELETE /conversations/:id/leave`)                                   | `src/routes/conversations.ts:872`                     | The departing member                                                               |
| 4   | A member leaves a conversation that still has others (`DELETE /conversations/:id/leave`)                                         | `src/routes/conversations.ts:900`                     | All members, including the one leaving                                             |
| 5   | Per-member settings changed — mute, archive (`PATCH /conversations/:id/settings`)                                                | `src/routes/conversations.ts:715`                     | **Direct `redis.del(convCacheKey(userId))`** — only the caller's own entry changes |
| 6   | A device is added or revoked, emitting a `device_added` / `device_revoked` system message into each of that user's conversations | `src/routes/devices.ts:735` (`emitDeviceChangeEvent`) | All members of every conversation the user belongs to                              |
| 7   | A message is sent over REST (`POST /messages`)                                                                                   | `src/routes/messages.ts:229`                          | All members                                                                        |
| 8   | A message is deleted over REST (`DELETE /messages/:id`)                                                                          | `src/routes/messages.ts:277`                          | All members                                                                        |
| 9   | A message is sent over the socket (`send_message`)                                                                               | `src/socket/messaging.ts:312`                         | All members                                                                        |
| 10  | A message is edited over the socket (`edit_message`)                                                                             | `src/socket/messaging.ts:441`                         | All members                                                                        |
| 11  | A file message is sent over the socket (`send_file_message`)                                                                     | `src/socket/messaging.ts:623`                         | All members                                                                        |
| 12  | A conversation is created over the socket (`create_conversation`)                                                                | `src/socket/messaging.ts:1003`                        | Every member of the new conversation                                               |
| 13  | The assistant replies (`ask_assistant`)                                                                                          | `src/socket/messaging.ts:1225`                        | All members                                                                        |

Case 5 is the one direct `DEL` outside the helper, and it is correct as written: mute and
archive are per-member columns, so no other member's list changes. Every other write path uses
the helper.

The unifying rule, and the one to apply when adding a path: **anything that changes what
`GET /conversations` would return for a user must invalidate that user's key in the same
request.** In practice that means any write to `conversations`, `conversation_members`, or
`messages`, and any change to the device set that produces a system message. The usual shape
is a `findMany` over `conversationMembers` for the affected conversation followed by
`invalidateConversationCaches(members.map((m) => m.userId))`.

A path that forgets to invalidate does not corrupt anything — it produces a list that is stale
for at most the 30-second TTL. That is a real bug (a sent message that does not appear in the
list preview for half a minute reads as data loss to a user) but a self-healing one, which is
why the TTL is short.

## Degraded behaviour when Redis is unavailable

`src/lib/redis.ts` creates the client only when `REDIS_URL` is set, with `lazyConnect: true`
and an `error` listener that deliberately swallows connection errors:

```ts
export let redis: Redis | null = null;

if (process.env['REDIS_URL']) {
  redis = new Redis(process.env['REDIS_URL'], { lazyConnect: true });
  redis.on('error', () => {
    // Graceful degradation: cache misses fall through to DB
  });
}
```

Without the listener, ioredis would emit an unhandled `error` event and crash the process on a
Redis blip. With it, every caching call site sees either `redis === null` or a rejected
promise, and both are already handled.

**The cache is an optimisation, not a correctness dependency.** With Redis down or absent:

- `GET /conversations` reads and writes nothing and answers from Postgres. The response is
  byte-for-byte what the cached version would have been — the cache stores the finished body,
  so there is no second code path that could diverge.
- `invalidateConversationCaches` returns immediately on the `!redis` guard, and per-user `DEL`
  failures are absorbed by `allSettled`. Nothing upstream sees an error.
- No write is ever gated on the cache. No path reads the cache to make a decision; it is only
  ever read to answer a `GET`. Nothing is stored in Redis that is not reconstructible from
  Postgres.

The cost of losing Redis is throughput on one endpoint, plus the effects on the _other_
Redis-backed subsystems listed below — not correctness or data loss here. Local development
without a `REDIS_URL` is a supported configuration, and the test suite runs with `redis` mocked
to `null` for exactly this reason.

## The per-device scoping hazard

`GET /conversations` builds its preview through
`getConversationRelations(req.auth!.deviceId)`, whose message relation filters envelopes to the
requesting device:

```ts
envelopes: {
  where: eq(messageEnvelopes.recipientDeviceId, deviceId),
  limit: 1,
}
```

**The response is therefore device-specific, not merely user-specific.** Each recipient device
gets its own envelope, encrypted for that device alone (see
[`concepts-protocol-negotiation.md`](./concepts-protocol-negotiation.md) for why one message
produces one ciphertext per device). Two devices belonging to the same user get _different_
ciphertext for the same preview message, and neither can decrypt the other's.

That makes the interaction between the payload and the key format the sharpest edge in this
subsystem:

- A key that includes the device (`conversations:{userId}:{deviceId}`) is safe: each device
  gets its own entry, and each entry holds the ciphertext addressed to that device.
- A key that omits the device serves whichever device populated the entry first to every other
  device of the same user for the rest of the TTL. The second device receives an envelope it
  has no key for. The failure does not look like a cache bug: it looks like a decryption
  failure, or a preview stuck on an older message, on one device only, intermittently, for up
  to 30 seconds after every send — the shape of bug that gets attributed to the crypto layer
  and chased for days.

**Today `convCacheKey` is `conversations:{userId}` and does not carry the device.** The
consequence above is a live hazard for a multi-device user, bounded by the 30-second TTL, and
`convCacheKey` is the single place a fix belongs — every read, write, and invalidation already
routes through it. Note that a device-scoped key changes invalidation too:
`invalidateConversationCaches` takes user ids, so it would have to delete every device's entry
for each user (a `SCAN`/`DEL` over `conversations:{userId}:*`, or a per-user set of that user's
device keys), rather than one `DEL` per user.

The general rule this is an instance of: **a cache key must name every input the cached value
depends on.** Here the value depends on the user _and_ the device _and_ the archived flag. The
archived flag is handled by not caching that view at all; the device is the dimension to watch.
The same rule applies to any future per-device response — a sync cursor, a device-filtered
history page — that someone is tempted to cache.

## Other Redis key namespaces (not caches)

For orientation, so these are not mistaken for cache entries and cleared as if they were. Only
the first is invalidated by anything in this document.

| Prefix                 | Purpose                                    | Reference                                                                |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| `conversations:`       | The conversation-list cache described here | this document                                                            |
| `replay:`              | `eventId` replay markers, TTL'd            | [`concepts-replay-protection.md`](./concepts-replay-protection.md)       |
| `rl:`                  | Rate-limit buckets                         | [rate limits](../../../docs/security/rate-limits.md)                     |
| `presence:`            | Device and user presence, socket mappings  | [`concepts-gateway-architecture.md`](./concepts-gateway-architecture.md) |
| Socket.IO adapter keys | Cross-node pub/sub fan-out                 | [`concepts-gateway-architecture.md`](./concepts-gateway-architecture.md) |

Deleting a `conversations:` key is always safe. Deleting keys in the other namespaces is not
equally harmless — dropping `rl:` keys resets live rate-limit budgets, and dropping `presence:`
keys makes online users appear offline until their next heartbeat.

## Implementation references

| Concern                                    | File                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Client, key format, TTL constant           | [`src/lib/redis.ts`](../src/lib/redis.ts)                                                                      |
| Invalidation helper                        | [`src/lib/conversationCache.ts`](../src/lib/conversationCache.ts)                                              |
| Read, write, and the device-scoped preview | [`src/routes/conversations.ts`](../src/routes/conversations.ts)                                                |
| Message-write invalidations                | [`src/routes/messages.ts`](../src/routes/messages.ts), [`src/socket/messaging.ts`](../src/socket/messaging.ts) |
| Device-change invalidation                 | [`src/routes/devices.ts`](../src/routes/devices.ts)                                                            |
| Tests                                      | `src/__tests__/conversations.cache.test.ts`                                                                    |

## Related documents

- [Conversations API](./api-conversations.md) — the endpoint whose response is cached.
- [Replay protection and event idempotency](./concepts-replay-protection.md) — the other
  subsystem that treats Redis as an optimisation and fails open.
- [Gateway architecture](./concepts-gateway-architecture.md) — presence and pub/sub, the rest
  of what Redis carries.
- [Backend testing guide](./testing.md) — mocking `lib/redis.js`, including the `null` form
  that exercises the degraded path.

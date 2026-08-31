# Replay protection and event idempotency

A realtime client retries. It reconnects mid-send, it resumes after a suspend, it fires the
same action twice because a tap registered twice — and a hostile client replays a captured
frame on purpose. The backend answers this in **two independent layers**, at two different
levels of the stack, and confusing them is the usual source of "why did my duplicate still
create a row" questions.

- **Transport level:** every enveloped socket event carries an `eventId`, and
  [`src/services/replay-protection.service.ts`](../src/services/replay-protection.service.ts)
  drops the second and later arrivals of that id from the same device inside a TTL window.
- **Message level:** every message carries a client-generated `messageId`, and the send paths
  refuse to insert a second row for an id that already exists, acknowledging the original
  instead.

This document covers both, and the dispatcher path that ties them together.

## Contents

- [Why both layers exist](#why-both-layers-exist)
- [Layer 1 — transport-level `eventId` dedup](#layer-1--transport-level-eventid-dedup)
  - [The device-scoped key](#the-device-scoped-key)
  - [The TTL](#the-ttl)
  - [Fail-open when Redis is unavailable](#fail-open-when-redis-is-unavailable)
  - [`dispatch_ack`](#dispatch_ack)
- [Layer 2 — message-level `messageId` idempotency](#layer-2--message-level-messageid-idempotency)
- [Every event goes through the dispatcher](#every-event-goes-through-the-dispatcher)
- [Operational notes](#operational-notes)
- [Implementation references](#implementation-references)

## Why both layers exist

They protect different things and neither subsumes the other.

|                     | Transport layer (`eventId`)                                     | Message layer (`messageId`)                                           |
| ------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Scope               | Every socket event type — reads, typing, receipts, joins, sends | Message-creating sends only                                           |
| Identity            | Per delivery attempt of an event                                | Per message, stable across attempts and across transports             |
| Storage             | Redis key with a TTL                                            | The `messages` primary key — permanent                                |
| Window              | `REPLAY_PROTECTION_TTL_SECONDS` (default 5 minutes)             | Forever                                                               |
| Behaviour on repeat | Handler is not run at all; `dispatch_ack { duplicate: true }`   | Handler runs, finds the row, re-acknowledges the original `createdAt` |
| Fails               | Open (allows the event through when Redis is down)              | Closed (the row either exists or it does not)                         |

**The transport layer cannot be the only one.** Its window is finite and its state is in
Redis. A retry after the TTL has expired, a retry from a different device, a retry that
arrives over REST instead of the socket, or any retry at all while Redis is down, gets past
it. If duplicate suppression for messages lived only here, any of those would produce a
second copy of a message in the conversation.

**The message layer cannot be the only one either.** Most events are not message sends.
`message_read`, `typing_start`, `join_room`, `heartbeat` and the rest have no durable id to
be idempotent on, and re-running them on a replayed frame costs real work — extra fan-out,
extra receipts, extra queries — even where the end state happens to be the same. The
transport layer is also the only one that sees a _deliberate_ replay of a captured frame,
because a captured frame replays the whole envelope, `messageId` included; the message layer
would treat that as a retry and cheerfully re-ack it.

The practical rule: **`eventId` is per attempt and must be freshly generated for every
emit; `messageId` is per message and must be reused across retries of the same message.**
Getting these the wrong way round is what produces "my resend was silently ignored"
(reused `eventId`) or "my retry created a duplicate message" (fresh `messageId`).

## Layer 1 — transport-level `eventId` dedup

`isReplay(redis, deviceId, eventId)` performs an atomic check-and-mark:

```ts
const result = await redis.set(key, '1', 'EX', ttl, 'NX');
return result === null; // null → the key already existed → this is a replay
```

`SET … NX` is one round trip and it is atomic, so two frames racing on the same node — or on
two different gateway nodes sharing one Redis — cannot both observe "not seen yet". There is
no read-then-write window to lose.

Return values are stated in the positive: `false` means _not_ a replay, process it; `true`
means drop it. The function also returns `false` — process it — when `deviceId` or `eventId`
is missing or blank, since there is nothing to key on. In practice the envelope schema
requires a non-empty `eventId`, so a blank one is rejected as a malformed envelope before the
replay check is reached.

`markSeen(redis, deviceId, eventId)` exists to mark an id without consuming the check; it is
a testing and debugging affordance, not part of the live path. `isReplay` already marks
atomically.

### The device-scoped key

```
replay:{deviceId}:{eventId}
```

`getReplayProtectionRedisKey()` builds it and is exported so tests and debugging can compute
the same string rather than duplicating the format.

**The `deviceId` component is load-bearing, not decoration.** `eventId` is generated by the
client, and nothing forces two clients to agree on a generator. A user's phone and laptop can
legitimately produce the same id — a counter, a low-entropy uuid, a `test-evt-1` left in a
build. With a global `replay:{eventId}` key, whichever device emitted first would win and the
other device's genuine, first-time event would be silently dropped as a "replay", producing a
handler that never runs and no error anywhere. Scoping the key to the device makes each
device's id space its own: one device's replayed id cannot block another device's legitimate
event.

It also matches the threat being defended. A replay attack is a frame captured from one
device and re-sent; the attacker cannot change the authenticated `deviceId` on the socket,
which is taken from the JWT (`socket.auth.deviceId`), not from the payload. Cross-device
collisions are noise, not attacks.

### The TTL

| Setting        | Value                                                     |
| -------------- | --------------------------------------------------------- |
| Env var        | `REPLAY_PROTECTION_TTL_SECONDS`                           |
| Default        | `300` (5 minutes)                                         |
| Accepted range | `1` … `86400` seconds (1 day)                             |
| Invalid values | Non-numeric, out-of-range, or empty → the default is used |
| Read           | Per call, not cached at import                            |

The TTL is what keeps the key space bounded: entries expire on their own, so there is no
sweeper job and no unbounded growth from a device that sends a million events. It also bounds
the protection — an event replayed after the window is not detected here, which is why the
message layer exists.

The default is tuned against the dispatcher's own freshness check rather than picked
arbitrarily. `SOCKET_EVENT_MAX_AGE_MS` (default `300000`, also 5 minutes) rejects an envelope
whose `timestamp` is older than the window, so a frame old enough to have fallen out of the
replay set is already stale enough to be refused for that reason instead. **If you raise
`SOCKET_EVENT_MAX_AGE_MS`, raise `REPLAY_PROTECTION_TTL_SECONDS` with it**, or you open a gap
in which a frame is accepted as fresh but no longer remembered as seen.

An out-of-range value degrades to the default instead of throwing, in keeping with how the
rest of the backend reads tuning env vars: a typo in the environment must not stop the
gateway from booting.

### Fail-open when Redis is unavailable

`isReplay` returns `false` — process the event — in two cases:

- `redis` is `null`, meaning `REDIS_URL` was never configured, and
- the `SET` throws, which covers a connection loss, a timeout, or a Redis in a failed state.
  The error is logged once per call at `warn` level and the event proceeds.

This is deliberate. Replay protection is a **hardening** layer, not a correctness dependency:
the durable guarantees for messages come from the `messageId` primary key, which is in
Postgres and does not care what Redis is doing. Failing closed would mean that losing Redis
takes the entire realtime surface offline — nobody can send, read, or type — in exchange for
closing a replay window that requires an attacker to already hold a captured, authenticated
frame. Trading total availability for that is the wrong side of the trade for this system.

The consequence to be aware of when reading tests: **with Redis mocked to `null`, the dedup
does nothing.** A test that reuses an `eventId` passes against a `null` Redis and starts
failing the moment someone gives the suite an `ioredis-mock` instance. Generate a fresh
`eventId` per emit regardless of what Redis the test has — see
[`testing.md`](./testing.md#driving-socket-handlers).

## `dispatch_ack`

Every event that reaches the dispatcher gets exactly one `dispatch_ack` back, and the flag
says which layer answered it:

```jsonc
{ "eventId": "…", "duplicate": false } // first occurrence — the handler ran
{ "eventId": "…", "duplicate": true }  // replay — the handler was not run
```

`duplicate: true` is **an acknowledgement, not an error.** The event was already processed,
so the client's intent is satisfied and it should clear the item from its outbox exactly as
it would on `duplicate: false`. Treating it as a failure and retrying produces a loop that
gets the same answer until the TTL expires, at which point the retry is processed for real —
which is the one outcome the client was trying to avoid.

Note what does _not_ produce an ack: a malformed envelope, an unknown event type, a stale
timestamp, and an unauthenticated socket all emit an `error` envelope instead, and a handler
that throws is logged server-side with no ack at all. A client waiting on `dispatch_ack`
therefore needs a timeout, and must treat `error` as terminal for that event.

## Layer 2 — message-level `messageId` idempotency

`messageId` is generated by the client and is the primary key of the `messages` row. Every
send path performs the same check before inserting:

```ts
const existing = await db.query.messages.findFirst({
  where: eq(messages.id, messageId),
  columns: { createdAt: true },
});
if (existing) {
  /* acknowledge the original, insert nothing */
}
```

| Path                         | On an id that already exists                                  |
| ---------------------------- | ------------------------------------------------------------- |
| `POST /messages`             | `200` with `{ messageId, createdAt }` (a fresh send is `201`) |
| `send_message` (socket)      | `message_ack` with the **original** `createdAt`               |
| `edit_message` (socket)      | `message_ack` with the original `createdAt`                   |
| `send_file_message` (socket) | `message_ack` with the original `createdAt`                   |

Three properties matter:

- **It spans transports.** A client that sends over the socket, loses the connection before
  the ack, and retries over REST with the same `messageId` gets the original message back
  rather than a duplicate. The transport layer cannot do this — the REST request has no
  `eventId` at all.
- **It has no window.** The check is against the durable row, so it holds a day later as
  readily as a second later.
- **The distinction between `200` and `201`, and the returned `createdAt`, are the client's
  signal that the retry was absorbed** — the original timestamp is returned, not the retry's,
  so message ordering never shifts because of a retry.

Because the check is `SELECT` then `INSERT` rather than an upsert, two genuinely simultaneous
sends of the same `messageId` can both pass the check; the second insert then fails on the
primary key and the request returns a `500` rather than corrupting anything. That is a
tolerable outcome for a case that requires a client to race itself, and the row count stays
correct either way.

## Every event goes through the dispatcher

The order of operations in `EventDispatcher.listen()` is fixed, and the replay check sits
late in it on purpose — there is no point spending a Redis round trip on a frame that is not
going to be processed anyway:

1. **Authenticated?** Otherwise `error` — the socket must be authenticated before any event.
2. **Valid envelope?** `EventEnvelopeSchema` requires `eventId`, `type`, and a positive
   integer `timestamp`. Otherwise `error`.
3. **Known event type?** Unknown types are discarded with an `error`, so an unrecognised name
   cannot reach a handler.
4. **Fresh timestamp?** Within `SOCKET_EVENT_MAX_AGE_MS` in the past and
   `SOCKET_EVENT_MAX_FUTURE_SKEW_MS` (default `30000`) in the future. Otherwise `error`.
5. **Replay?** `isReplay(redis, socket.auth.deviceId, envelope.eventId)`. If so, emit
   `dispatch_ack { duplicate: true }` and stop.
6. **Dispatch** to the registered handler, then `dispatch_ack { duplicate: false }`.

`dispatcher.register(type, handler)` puts the handler into a map that only step 6 can reach.
**There is no raw `socket.on(type, …)` fallback for registered types** — `listen()` attaches
exactly one listener, for the `dispatch` event — so a handler cannot be reached without
passing every check above. That is why the dedup can be described as covering every event
rather than as something each handler opts into, and it is why a test must drive handlers by
emitting a `dispatch` envelope rather than by triggering a raw event name.

**One handler is not on this path today:** `send_file_message` is still attached with a raw
`socket.on` in `src/socket/messaging.ts`. It therefore gets no envelope validation, no
timestamp freshness check, and no `eventId` dedup; its duplicate suppression comes entirely
from the `messageId` check in layer 2. Anything that moves it onto `dispatcher.register`
inherits all of the above for free, and any _new_ handler must be registered through the
dispatcher.

## Operational notes

- **Keys are ephemeral and safe to drop.** `replay:*` keys carry no data beyond "this id was
  seen", and losing them fails open by construction. A Redis flush costs at most a window in
  which a replayed frame would be accepted; it never loses a message.
- **Sizing.** One key per event per device for the TTL window. At `n` events per second
  across the fleet and a 300-second TTL, the steady-state key count is roughly `300n`, each a
  short string with a one-byte value.
- **A cluster shares the state.** All gateway nodes talk to the same Redis, so a frame
  replayed against a different node than the original is still caught. This is the same
  Redis the gateway uses for pub/sub fan-out and presence — see
  [`concepts-gateway-architecture.md`](./concepts-gateway-architecture.md).
- **Debugging a dropped event.** A replay logs at `debug` with `deviceId`, `eventId`, and
  `type`. If a handler "never ran" and no error came back, check for a `dispatch_ack` with
  `duplicate: true`; the usual cause is a client reusing an `eventId` across retries rather
  than generating a fresh one.

## Implementation references

| Concern                             | File                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `isReplay`, `markSeen`, key and TTL | [`src/services/replay-protection.service.ts`](../src/services/replay-protection.service.ts)                           |
| Dispatch order and `dispatch_ack`   | [`src/socket/dispatcher.ts`](../src/socket/dispatcher.ts)                                                             |
| Envelope schema and event registry  | [`src/lib/eventEnvelope.ts`](../src/lib/eventEnvelope.ts)                                                             |
| Socket send idempotency             | [`src/socket/messaging.ts`](../src/socket/messaging.ts)                                                               |
| REST send idempotency               | [`src/routes/messages.ts`](../src/routes/messages.ts)                                                                 |
| Redis client and degradation        | [`src/lib/redis.ts`](../src/lib/redis.ts)                                                                             |
| Tests                               | `src/services/replay-protection.service.spec.ts`, `src/socket/dispatcher.spec.ts`, `src/__tests__/dispatcher.test.ts` |

## Related documents

- [Gateway architecture](./concepts-gateway-architecture.md) — the socket lifecycle the
  dispatcher sits inside, and what else Redis carries.
- [WebSocket events](./api-websocket-events.md) — every event type, including `dispatch_ack`.
- [Error code and response catalog](./contracts-error-catalog.md) — the `error` envelopes the
  checks above emit, and which are retryable.
- [Backend testing guide](./testing.md) — driving handlers through `dispatch` without
  tripping the dedup.
- [Backend caching reference](./concepts-caching.md) — the other place Redis is treated as an
  optimisation rather than a correctness dependency.

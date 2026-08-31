# Backend testing guide

The backend-specific companion to the cross-app
[testing strategy and conventions](../../../docs/testing.md). That document sets the rules
every suite in the repository follows — no test starts Redis, Postgres, or S3; the approved
substitutes; the runners and commands. This one is the working reference for the backend
suite specifically: the mock set a route test needs, the socket pattern, and the four or five
ways a test in this suite fails confusingly rather than clearly.

Read the cross-app document first if you have not. Everything here assumes it.

The conventions below are not stylistic. Each one exists because the alternative produces a
failure that does not name its cause: `undefined is not a function` from a mock that is missing
one export, a handler that "never ran" because an id was reused, a `429` that only appears when
the file runs in a particular order. Getting them right is mostly a matter of copying the
skeleton and knowing which traps are there.

## Contents

- [Commands and layout](#commands-and-layout)
- [The standard route-test skeleton](#the-standard-route-test-skeleton)
- [Why `await import`, always](#why-await-import-always)
- [Drizzle chain mocking, and its traps](#drizzle-chain-mocking-and-its-traps)
- [Driving socket handlers](#driving-socket-handlers)
- [Service mocks: add one whenever a route gains a dependency](#service-mocks-add-one-whenever-a-route-gains-a-dependency)
- [Resetting shared in-process state](#resetting-shared-in-process-state)
- [Checklist for a new backend test](#checklist-for-a-new-backend-test)

## Commands and layout

```bash
pnpm --filter backend test                    # the whole suite
pnpm --filter backend test -- messages.routes # one file, by substring
pnpm --filter backend test:watch
pnpm --filter backend test:coverage
```

| Fact             | Value                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runner           | Vitest, `environment: 'node'`, `testTimeout: 15000` (`vitest.config.ts`)                                         |
| Collected        | `src/**/*.{test,spec}.ts`; `node_modules` and **`dist`** excluded                                                |
| Where tests live | `src/__tests__/*.test.ts`, plus a few `*.spec.ts` co-located with their module (`src/socket/dispatcher.spec.ts`) |
| Global setup     | `src/__tests__/setup.ts` — sets `JWT_SECRET`, `DATABASE_URL`, and the `OBJECT_STORE_*` placeholders              |
| Lint and format  | `pnpm --filter backend lint`, `pnpm --filter backend format:check` — both cover `src/`, tests included           |

`dist` is excluded deliberately: `pnpm build` emits a compiled copy of every spec, and without
the exclusion each test would run twice, the second time against stale output.

If a new module validates a new required environment variable at import time, add a
placeholder to `src/__tests__/setup.ts`. Do not mock the config module in each test file that
happens to import the new one transitively.

## The standard route-test skeleton

Almost every route test mocks the same five modules. Copy this, delete what the route under
test does not touch, and add service mocks as needed.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── 1. Database ─────────────────────────────────────────────────────────────
// Only the query methods the route actually calls need to exist. Anything the
// route calls that is missing here fails as "not a function", which reads as a
// bug in the route rather than a gap in the mock — so add the method, do not
// change the route.
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock('../db/index.js', () => ({
  db: {
    query: {
      conversationMembers: { findFirst: mockFindFirst, findMany: mockFindMany },
      messages: { findFirst: vi.fn() },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

// ── 2. Schema ───────────────────────────────────────────────────────────────
// Column references become inert sentinels. Their only job is to be
// distinguishable inside an assertion — the mocked operators below never
// interpret them. Every table the router imports must appear here, even one it
// only references in a code path this test does not exercise: the import itself
// is what fails otherwise.
vi.mock('../db/schema.js', () => ({
  conversations: { id: 'id', type: 'type' },
  conversationMembers: { conversationId: 'conversationId', userId: 'userId' },
  messages: { id: 'id', conversationId: 'conversationId', createdAt: 'createdAt' },
  messageEnvelopes: { messageId: 'messageId', recipientDeviceId: 'recipientDeviceId' },
  tokenTransfers: {},
}));

// ── 3. Drizzle operators ────────────────────────────────────────────────────
// Identity-ish stubs, so a test asserts on the shape a call site built rather
// than on generated SQL. Every operator the module under test imports must be
// exported here or the import throws.
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  ne: vi.fn(),
  desc: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
  count: vi.fn(),
  sql: vi.fn(),
}));

// ── 4. Redis ────────────────────────────────────────────────────────────────
// The getter form matters: it lets a test swap the instance (or set it to null)
// between cases without re-registering the mock. `null` exercises the degraded
// path, which is the default choice unless the test is about caching itself.
vi.mock('../lib/redis.js', () => ({
  get redis() {
    return null;
  },
  CONV_CACHE_TTL: 30,
  convCacheKey: (userId: string) => `conversations:${userId}`,
}));

// ── 5. Auth middleware ──────────────────────────────────────────────────────
// Inject `req.auth` rather than minting a real JWT. Include `deviceId`: several
// routes read it, and a missing one surfaces as a confusing 500 or an empty
// result set rather than a 401.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { auth: { userId: string; deviceId: string } }).auth = {
      userId: 'user-1',
      deviceId: 'device-1',
    };
    next();
  },
}));

// ── Import the module under test AFTER the mocks ────────────────────────────
const { conversationsRouter } = await import('../routes/conversations.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/conversations', conversationsRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /conversations', () => {
  it('…', async () => {
    const res = await request(makeApp()).get('/conversations');
    expect(res.status).toBe(200);
  });
});
```

Notes on the pieces that most often go wrong:

- **Mount only the router under test**, not `app.ts`, unless the test is specifically about
  middleware ordering. A `supertest` app built from one router keeps the failure local.
- **Do not mock `../middleware/validate.js`.** Request-body validation is behaviour a route
  test should exercise; mocking it hides a whole class of `400`s the real route returns.
- **Auth tests use the real middleware.** The mock above is for tests that are about something
  else.
- **`vi.clearAllMocks()` in `beforeEach` clears calls and implementations of mock functions
  only.** It does not touch module-level state inside the code under test — see
  [resetting shared in-process state](#resetting-shared-in-process-state).

## Why `await import`, always

`vi.mock` calls are hoisted to the top of the file, but the factories close over `vi.fn()`
handles declared below them. A static `import` of the module under test binds the real `db`
before those handles exist. Every backend suite that mocks the database therefore imports the
subject with a top-level `await import(...)`:

```ts
const { messagesRouter } = await import('../routes/messages.js');
```

The symptom of getting this wrong is a test that tries to open a real Postgres connection and
either hangs to the 15-second timeout or fails inside a driver stack trace with no mention of
your route.

## Drizzle chain mocking, and its traps

The cross-app guide covers the general pattern. These are the specific chains this suite hits.

### `.values()` must be both thenable and expose `.returning()`

Drizzle's insert builder is a thenable. `db.insert(t).values(rows)` is itself awaitable and
executes the statement, **and** `.returning()` can be chained onto it to execute and get the
inserted rows back. Both forms are used in this codebase, sometimes inside a single
transaction: the message insert needs the generated `id` and `createdAt` so it calls
`.returning()`, while the envelope batch insert (`insertMessageEnvelopes`) only cares that the
rows landed and just awaits `.values(...)`.

The two wrong stubs fail in opposite, equally unhelpful ways:

| Stub returns          | What breaks                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ returning }` alone | The awaited `.values(...)` resolves to a plain object and records nothing. **The test passes** while asserting on an insert that never happened. |
| A bare promise        | `.returning is not a function`, thrown from inside the route.                                                                                    |

So a shared insert stub has to satisfy both shapes:

```ts
function insertStub(table: string) {
  return {
    values: (vals: unknown) => ({
      returning: async () => recordInsert(table, vals),
      then: (resolve: (value: unknown) => void) => resolve(recordInsert(table, vals)),
    }),
  };
}
```

`src/__tests__/e2ee.integration.test.ts` is the canonical version. Two cautions:

- **Do not add `then` to a stub whose call sites never await the builder directly.** A thenable
  is awaited implicitly whenever it is returned from an `async` function, which can fire the
  recording side effect a second time.
- **If both forms run against the same stub, make the recorder idempotent** — or assert on call
  counts you have actually verified, rather than assuming one insert equals one recorded row.

### Transactions

A route that writes more than one table wraps the work in `db.transaction`. Mock it as a
function that invokes its callback with an object exposing the same stubbed builders, plus
whatever `query.*` methods the transaction body uses (`insertMessageEnvelopes`, for example,
calls `tx.query.devices.findMany`):

```ts
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
  cb({
    insert: insertStub,
    query: { devices: { findMany: mockDeviceFindMany } },
  }),
);
```

A transaction body that throws must propagate, so do not wrap the callback in a `try`/`catch`
in the mock — the route's own error handling is usually the thing under test.

### Read chains and raw SQL

`db.select().from().where().groupBy()` needs each link to return the next one, innermost first:

```ts
const mockGroupBy = vi.fn().mockResolvedValue([]);
const mockWhere = vi.fn(() => ({ groupBy: mockGroupBy }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
```

`db.execute(sql\`…\`)`is used for the aggregate subqueries (unread counts). Mock it as a plain`vi.fn()`resolving to the row array; the route spreads the result, so resolve to an array and
not to a`{ rows }` object.

When a module uses `sql` as both a tag and a namespace (`sql.join(...)`), the `drizzle-orm`
mock has to provide both:

```ts
const sqlMock = Object.assign(
  vi.fn(() => 'sql'),
  { join: vi.fn(() => 'joined') },
);
```

### The two import-time failures

Both present as an error in a file you did not touch, so recognise them by shape:

- **A table missing from the `db/schema.js` mock** → the router's import of that name is
  `undefined`, and the first use is a `Cannot read properties of undefined` far from the cause.
  Add the table to the mock with the columns the route names.
- **An operator missing from the `drizzle-orm` mock** → an ESM named-export error naming the
  operator (`ne`, `isNull`, `inArray`, `count`, `desc`, `lt`, `gte`, `sql`). Add it as
  `vi.fn()`.

Both happen when a route gains a new query, which is the same trigger as the service-mock rule
below.

## Driving socket handlers

Every client-to-server socket event goes through one enveloped `dispatch` event
(`src/socket/dispatcher.ts`). `dispatcher.register(type, handler)` stores the handler in a map
and `listen()` attaches exactly one `socket.on('dispatch', ...)` listener, which checks
authentication, validates the envelope, rejects unknown types and stale timestamps, and applies
`eventId` replay protection before any handler is reached.

**Grabbing a raw listener no longer works.** A test that reaches into the emitter looking for
a listener registered for `'send_message'` finds nothing, because none is registered. Worse, a
test written that way against an older revision _passed_ — while bypassing envelope validation,
idempotency, and the auth gate, which are exactly the checks those events need to be tested
through. `src/socket/dispatcher.spec.ts` has a test asserting that a raw emit does **not** reach
the handler; treat it as the specification.

Drive handlers by emitting a well-formed envelope:

```ts
let envelopeSeq = 0;

function dispatchEvent(socket: EventEmitter, type: string) {
  return async (payload: unknown) => {
    envelopeSeq += 1;
    // EventEmitter.prototype.emit.call bypasses the fake socket's emit override,
    // so this delivers to the listener instead of being captured as an outbound
    // server -> client emit.
    EventEmitter.prototype.emit.call(socket, 'dispatch', {
      eventId: `test-evt-${envelopeSeq}`,
      type,
      timestamp: Date.now(),
      payload,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
}
```

Preserve all five of these when copying it:

1. **A fresh `eventId` per emit.** Replay protection is keyed by
   `replay:{deviceId}:{eventId}`, so a reused value turns the second and later events into
   no-ops and produces a "the handler never ran" failure with no error attached. The check
   _fails open_ when Redis is `null`, so a suite that mocks Redis away will not catch a reused
   id — and the same test starts failing the day someone gives the suite an `ioredis-mock`
   instance. Generate a fresh id regardless. See
   [`concepts-replay-protection.md`](./concepts-replay-protection.md).
2. **A current `timestamp`.** Envelopes outside `SOCKET_EVENT_MAX_AGE_MS` (5 minutes) in the
   past or `SOCKET_EVENT_MAX_FUTURE_SKEW_MS` (30 seconds) in the future are rejected before the
   handler runs. With `vi.useFakeTimers()`, keep the envelope timestamp inside the window.
3. **Set `socket.auth` first** (`{ userId, deviceId }`). An unauthenticated socket gets an
   `error` envelope back and the handler is never reached.
4. **Await a tick.** The dispatch listener is `async` and `emit` returns synchronously, so
   assert after the `setTimeout` above.
5. **Register through the real registrar** — `registerMessagingHandlers(io, socket)` — rather
   than pulling a handler function out of the module, so whatever the registrar installs stays
   in the path.

Assertions usually read the socket's captured emits. `dispatch_ack` is the dispatcher's own
acknowledgement: `{ eventId, duplicate: false }` on a first occurrence and
`{ eventId, duplicate: true }` on a replay, which is the cleanest way to assert that an event
was processed exactly once.

**The one exception:** `send_file_message` is still attached with a raw
`socket.on('send_file_message', ...)` in `src/socket/messaging.ts`, so it is triggered by
emitting that event name directly. It is the only handler for which that is correct. If it
moves onto the dispatcher, its tests move with it.

Worked examples: `src/__tests__/dispatcher.test.ts` and `src/socket/dispatcher.spec.ts` for the
dispatcher itself, `src/__tests__/askAssistant.test.ts` for a handler driven through
`dispatch`.

## Service mocks: add one whenever a route gains a dependency

Route tests mock the database, but a route also calls services — and an unmocked service runs
for real, which means it reaches for the database _it_ imported, or Redis, or the object store.
The failures are indirect: a timeout, a `500` from a service several frames down, or a passing
test that quietly performed a real side effect.

**When a route or handler gains a new service dependency, every existing test file for that
route needs the new `vi.mock`, in the same change.** This is the single most common way a
change breaks unrelated backend tests, and the error message never names the new import.

Frequently mocked services, with what they stand in for:

| Module                            | Why a route test mocks it                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `../services/pushNotification.js` | Would attempt a real web-push send                                                                |
| `../services/deliveryPipeline.js` | Envelope delivery and per-device fan-out                                                          |
| `../services/deviceDelivery.js`   | Opens a duplicated Redis subscriber connection                                                    |
| `../services/e2eeProtocol.js`     | Queries `devices` for capabilities; mock when the test is not about protocol negotiation          |
| `../services/mlsGroups.js`        | Group epoch state                                                                                 |
| `../services/presence.js`         | Redis presence keys                                                                               |
| `../services/deviceRevocation.js` | Revocation broadcast                                                                              |
| `../services/roomManager.js`      | Socket room membership                                                                            |
| `../services/auditLog.js`         | Writes an audit row on many routes                                                                |
| `../services/fileCleanup.js`      | Soft-delete plus object-store work                                                                |
| `../lib/socket.js`                | `getSocketServer()` — return `null`, or `{ to: () => ({ emit }) }` when the test asserts on emits |

Mock at the seam the route imports, and give the mock the same shape the real export has
(`vi.fn().mockResolvedValue(undefined)` for a fire-and-forget async service). A service mocked
as a synchronous `vi.fn()` where the route awaits it works by accident and stops working the
moment the route checks the result.

When the test _is_ about the service, mock the service's own dependencies instead and exercise
the real thing — `src/__tests__/e2eeProtocol.test.ts` mocks only `db`, `db/schema`, and
`drizzle-orm`, and runs the real `checkEnvelopeProtocols`.

## Resetting shared in-process state

Several modules keep module-level state that survives across tests inside a Vitest worker.
`vi.clearAllMocks()` does not touch it, because it is not a mock — it is the real module's
memory.

Rate limiting is the one that bites most often. `services/rateLimiter.ts` keeps a
`localCounters` map used whenever Redis is unavailable — which, in a suite that mocks `redis`
to `null`, is always. The map is keyed by bucket, window, and subject, and the window comes
from wall-clock time, so several tests in one file hitting the same endpoint as the same
subject are all charged against **one** budget. The symptom is a test that passes alone and
returns `429` when the file runs in order, or a failure that moves when you reorder the file.

```ts
const { resetRateLimitBucket, clearLocalRateLimitCounters } =
  await import('../services/rateLimiter.js');

beforeEach(async () => {
  vi.clearAllMocks();
  clearLocalRateLimitCounters(); // the process-local fallback map
  await resetRateLimitBucket('auth_challenge'); // that bucket's Redis keys too
  await resetRateLimitBucket('auth_verify');
  await resetRateLimitBucket('global_ip');
});
```

`clearLocalRateLimitCounters()` clears only the in-process map. `resetRateLimitBucket(bucket)`
clears the matching local keys **and** scans and deletes the bucket's keys in Redis, real or
`ioredis-mock`. Where a suite shares one `ioredis-mock` instance, `await sharedRedis.flushall()`
in `beforeEach` is the blunter equivalent for the Redis half.

The same shape of leak exists elsewhere. Each affected module exports its own hook — use it
rather than reaching into the module:

| Module                        | State it keeps                                                         | Reset                                                           |
| ----------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| `services/rateLimiter.ts`     | Fallback counters plus Redis buckets                                   | `clearLocalRateLimitCounters()`, `resetRateLimitBucket(bucket)` |
| `services/rateLimit.ts`       | Per-socket repeat-violation counts                                     | `clearViolations(socketId)`                                     |
| `services/prekeyLowSignal.ts` | One-shot alert latches, so a second low-prekey event does not re-alert | `__resetPrekeyLowLatches()`                                     |
| `services/presence.ts`        | Offline-broadcast dedupe set                                           | `__resetOfflineBroadcastsForTesting()`                          |
| `services/heartbeat.ts`       | Per-socket heartbeat timers                                            | `clearHeartbeatTimer(socketId)`                                 |
| `lib/objectStore.ts`          | Memoised S3 client                                                     | `resetObjectStoreForTests()`                                    |

Timers are a second form of leaked state: a test that leaves a `setTimeout` pending (typing
indicators, heartbeats) can fire it during a later test. Clear timers the handler created, or
use `vi.useFakeTimers()` and dispose of them in `afterEach`.

The general rule: **if a module keeps state outside a function so that production behaves
correctly across requests, it needs a test-visible reset, and every suite that touches it calls
that reset in `beforeEach`.** When you add such state, export the reset in the same commit.

## Checklist for a new backend test

1. File in `src/__tests__/` as `*.test.ts` (or co-located `*.spec.ts` for a single module).
2. Mocks declared before the subject; subject imported with `await import(...)`.
3. `db/index.js`, `db/schema.js`, `drizzle-orm`, `lib/redis.js`, `middleware/auth.js` mocked —
   with every table and operator the module imports present.
4. Every service the route calls mocked, unless the service is what is under test.
5. Socket events driven through `dispatch`, with a fresh `eventId` and a current `timestamp`.
6. Shared in-process state reset in `beforeEach`.
7. Assertions on behaviour — status, body, emitted events, rows handed to `insert`/`update` —
   never on generated SQL.
8. No security invariant weakened to make a test pass. The guards in
   `src/__tests__/security.regression.test.ts` have their own CI job; if a change trips them,
   the change is wrong.
9. `pnpm --filter backend test`, `lint`, and `format:check` all clean.

## Related documents

- [Testing strategy and conventions](../../../docs/testing.md) — the cross-app rules this
  document sits under.
- [Replay protection and event idempotency](./concepts-replay-protection.md) — why `eventId`
  must be fresh per emit and `messageId` must not be.
- [Backend caching reference](./concepts-caching.md) — what the `lib/redis.js` mock is standing
  in for, and the degraded path a `null` Redis exercises.
- [Gateway architecture](./concepts-gateway-architecture.md) — the socket lifecycle the
  dispatcher tests model.
- [Database migration workflow](./migrations.md) — why the suite never runs migrations.

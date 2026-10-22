# Message edit and delete semantics

This document describes what `edit_message` and `delete_message` actually do to the
database and to every connected client, and the honest limits of both under the server's
"ciphertext only, per-device" storage model. It is written against the code as it
currently behaves (`apps/backend/src/socket/messaging.ts`), not an idealized design.

## Contents

- [Authorization](#authorization)
- [`edit_message`](#edit_message)
- [`delete_message`](#delete_message)
- [What an offline device sees on reconnect / `/sync`](#what-an-offline-device-sees-on-reconnect--sync)
- [The honest limit of delete under E2EE](#the-honest-limit-of-delete-under-e2ee)
- [Interaction with file GC](#interaction-with-file-gc)
- [Interaction with local search indexes](#interaction-with-local-search-indexes)
- [Implementation references](#implementation-references)

## Authorization

Both handlers apply the same rule: **only the original sender may act on a message.**

- `edit_message` loads the message at `originalMessageId` and rejects with
  `{ event: 'edit_message', message: 'Only the original sender can edit this message' }`
  if `original.senderId !== userId`.
- `delete_message` loads the message at `messageId` and rejects with
  `{ event: 'delete_message', message: 'Message not found or not sender' }` if it
  doesn't exist or `message.senderId !== userId` — the same error for both cases, so a
  client can't distinguish "not found" from "not yours" by the error alone.

Neither handler checks conversation membership separately; ownership of the message
(`senderId`) is the only gate.

## `edit_message`

An edit is **not** an in-place mutation. It inserts a brand-new `messages` row with a
fresh per-device envelope fan-out, and links it back to the message it replaces via
`editsMessageId`:

```ts
const rootMessageId = original.editsMessageId ?? original.id;
// ...
await tx.insert(messages).values({
  id: messageId,
  conversationId,
  senderId: userId,
  senderDeviceId: deviceId,
  contentType: contentType || original.contentType,
  ciphertext: ciphertext || null,
  editsMessageId: rootMessageId,
});
await insertMessageEnvelopes(tx, messageId, envelopes);
```

Two details that matter for anyone reasoning about edit chains:

- **`editsMessageId` always points at the root, not the previous edit.** If a message is
  edited twice, the second edit's `editsMessageId` is the *original* message's id, not the
  first edit's id — `rootMessageId` is resolved by following `original.editsMessageId` one
  hop, not by walking a chain. This means looking up "every version of this message" is a
  single `WHERE editsMessageId = :rootId OR id = :rootId` query, not a recursive one. See
  `routes/conversations.ts`'s comment on `supersededRows` for the read side of this: the
  set of every id referenced by some row's `editsMessageId` is exactly the set of
  non-latest versions, collapsed out of the default message list in one extra query.
- **An edit is validated exactly like a new `send_message`**, not like a lightweight
  patch: it requires non-empty `ciphertext`, runs `checkEnvelopeSizes`, and — the
  requirement called out separately below — full sibling-device envelope coverage. The
  only field it can omit is `contentType`, which falls back to the original message's.

Validation order, all of which can reject before anything is persisted:

1. `findForbiddenSessionStateField` — rejects if the payload contains session/ratchet/
   private-key fields; the server never accepts those, only opaque ciphertext and public
   routing metadata.
2. `originalMessageId` and `messageId` both required.
3. `ciphertext` must be non-empty after trimming.
4. `checkEnvelopeSizes` — per-device envelope size limit.
5. The message at `originalMessageId` must exist and belong to the caller (see
   [Authorization](#authorization)).
6. **Idempotency**: if a message already exists at `messageId`, the handler re-emits
   `message_ack` for it and returns — it does not re-insert or re-validate anything,
   including sibling coverage. A retried edit with the same `messageId` is a no-op past
   this point even if its payload differs from the first attempt.
7. Sibling-device coverage (next section).

### Sibling-device requirement

Before persisting, the handler calls the exact same function `send_message` calls:

```ts
const missingSiblings = await findMissingSiblingDeviceIds(userId, deviceId, envelopes);
if (missingSiblings.length > 0) {
  socket.emit('error', {
    event: 'device_set_mismatch',
    message: `Missing envelopes for ${missingSiblings.length} sibling device(s)`,
    missingDeviceIds: missingSiblings,
  });
  return;
}
```

`findMissingSiblingDeviceIds` (`lib/messageFanout.ts`) checks that the envelope map
covers every one of the *sender's own* other active devices — the same scope
`send_message` enforces (see
[`concepts-delivery-fanout.md`](./concepts-delivery-fanout.md), which also notes this is
narrower than full "every recipient's active devices" coverage: that stronger check,
`fanoutMessage`, exists in `services/fanout.ts` but has no callers on this path either).
A client that edits from one device without re-encrypting for its own other devices gets
rejected with `device_set_mismatch`, identically to a `send_message` with the same gap.

On success: the sender gets `message_ack`, the new message is delivered through the
normal `deliverMessage` fan-out pipeline (so every recipient device gets a fresh
`message_envelope` for the edited content), conversation-list caches for every member
are invalidated, and the conversation room receives:

```ts
io.to(conversationRoom(conversationId)).emit('message_edited', {
  originalMessageId: rootMessageId,
  newMessageId: messageId,
});
```

Note this is a *separate* event from the `new_message`/`message_envelope` the fan-out
pipeline also emits for the new row — a client needs to handle both: the envelope
delivers the new ciphertext to decrypt, and `message_edited` tells every other open
client (including the sender's own other devices, once their envelope arrives) which
earlier message this supersedes.

## `delete_message`

Delete is destructive at the server, by design — it does not keep a tombstone the way
some systems do. Given a `messageId` whose sender matches the caller:

```ts
await db
  .update(messages)
  .set({ deletedAt: new Date(), ciphertext: null })
  .where(eq(messages.id, messageId));

await db.delete(messageEnvelopes).where(eq(messageEnvelopes.messageId, messageId));

if (message.fileId) {
  const { softDeleteFile } = await import('../services/fileCleanup.js');
  await softDeleteFile(message.fileId);
}

io.to(message.conversationId).emit('message_deleted', { messageId });
io.to(conversationRoom(message.conversationId)).emit('message_deleted', { messageId });
```

Three things happen, in this order, none of them reversible:

1. **The `messages` row is kept, but gutted**: `ciphertext` is nulled and `deletedAt` is
   stamped. The row survives (so ids, timestamps, and `editsMessageId` links referencing
   it don't dangle), but the encrypted payload is gone — there is nothing left to decrypt
   even with the right keys.
2. **Every `message_envelopes` row for the message is hard-deleted**, not soft-deleted.
   This is the only one of the three steps with no `deletedAt`-style flag; the per-device
   delivery units are simply gone.
3. **If the message carried a file**, `softDeleteFile` is called — see
   [Interaction with file GC](#interaction-with-file-gc) for exactly what that does and
   doesn't do.

`message_deleted` is then broadcast via two separate `io.to(...).emit(...)` calls: one
to the room literally named by `message.conversationId`, and one to
`conversationRoom(message.conversationId)` (`room:conversation:${id}`) — two genuinely
different Socket.IO room names. Every connected socket joins *both* of these at connect
time (`index.ts`'s connection setup joins each conversation under both its bare id and
its `conversationRoom()`-prefixed form), so **a client receives `message_deleted` twice
per delete** — this is not deduplicated, since they're two independent `.emit()` calls,
not two rooms targeted by one call. The same double-room pattern, and the same resulting
duplicate delivery, is called out for `device_delivery_receipt` in
[`concepts-delivery-fanout.md`](./concepts-delivery-fanout.md#gaps--code-not-wired-into-the-live-path) —
this is a recurring pattern in this file, not unique to delete. A client should
deduplicate on `messageId` rather than assume one `message_deleted` per actual deletion.

There is no equivalent of the edit handler's idempotency check (no "already deleted"
short-circuit) — calling `delete_message` twice for the same id runs the same four steps
twice; the second `UPDATE`/`DELETE`s are no-ops against already-empty state, so this is
harmless but not explicitly guarded.

## What an offline device sees on reconnect / `/sync`

`routes/sync.ts`'s envelope-catch-up endpoint filters with:

```ts
.where(
  and(
    eq(messageEnvelopes.recipientDeviceId, deviceId),
    /* cursor */
    or(isNull(messageEnvelopes.deliveredAt), gt(messageEnvelopes.createdAt, ttlCutoff)),
    isNull(messages.deletedAt),
  ),
)
```

**A deleted message's envelope can never be delivered via `/sync`**, for two independent
reasons that both have to be true for this to matter in practice, but either alone would
block it: `delete_message` already hard-deletes every `messageEnvelopes` row for that
message (so there's nothing left to join against), and even if an envelope somehow
survived, the `isNull(messages.deletedAt)` filter excludes it. A device that was offline
for the entire lifetime of a message — sent, then deleted before that device ever
connected — never learns the message existed at all; it does not receive a
`message_deleted` event for something it never saw, because `/sync` is a REST catch-up
endpoint for missed *envelopes*, not a log of every state-changing socket event that
happened while the device was away.

For an edit, reconnect sees it as what it actually is: **a new, separate message.** The
edited message is a normal row with its own envelope, so `/sync` returns it like any
other undelivered message — with `editsMessageId` pointing at the root. The client is
responsible for recognizing that linkage and replacing the message it's displaying for
`rootMessageId`/`originalMessageId` with the new content; the server does not retroactively
notify a reconnecting device of the `message_edited` room event it missed while offline,
only the new message's envelope.

## The honest limit of delete under E2EE

The server can delete its own copy of the ciphertext and the per-device envelopes. It
**cannot** delete anything from a recipient device that already decrypted the message.
Once a client has received and decrypted a message, the plaintext — and any copy the
client made of it (chat UI state, local database, OS notification history, screenshot,
clipboard, the client's own local search index — see
[below](#interaction-with-local-search-indexes)) — is entirely outside the server's
reach. `delete_message` deleting the server's ciphertext stops *future* delivery to
devices that haven't fetched it yet (via `/sync`, as covered above); it is not a recall
of something already read. Any UI that frames "delete" as removing a message from
everyone's view should be worded to reflect this: it removes the message from devices
that hadn't already received it, and from the sender's and other devices' live view going
forward, but it cannot un-reveal plaintext a recipient has already seen.

## Interaction with file GC

`softDeleteFile` (`services/fileCleanup.ts`), called from `delete_message` when the
deleted message had a `fileId`, is conditional, not unconditional:

```sql
UPDATE files SET deleted_at = now()
WHERE id = :fileId
  AND hard_deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE file_id = :fileId AND deleted_at IS NULL
  )
```

A file is only soft-deleted if **no other non-deleted message still references it** —
`messages.fileId` has no uniqueness constraint, so the same file row can in principle be
attached to more than one message. Deleting one message that references a shared file
does not delete the file out from under another message still using it.

Once a file is soft-deleted (whether via this path or any other), it becomes a candidate
for the hard-delete pass that actually removes the underlying object, subject to
`FILE_HARD_DELETE_GRACE_MS` (default 0ms, so effectively the next tick). See
[`concepts-gc-jobs.md`](./concepts-gc-jobs.md#file-cleanup--servicesfilecleanupts) for
that pass's full retention/scheduling detail. `runHardDeletePass` deletes through
`getObjectStore()`, the same `ObjectStoreLike` interface documented in
[`concepts-local-object-store.md`](./concepts-local-object-store.md) (#330) — so this
soft-delete-then-hard-delete path behaves identically whether the active backend is
production S3 or the dev/test local-disk store.

Editing a message never touches file GC: `edit_message` does not accept or change a
`fileId`, so an edited text message's file association (if the root message ever had one)
is untouched by the edit.

## Interaction with local search indexes

This is a client-side concern, not something the server enforces, and the current web
client has a real gap here: `lib/search/searchClient.ts` exports `removeMessages(ids)`,
intended to drop messages from the local IndexedDB-backed search index, but it has no
callers anywhere in `apps/web/src` — neither the `message_deleted` nor the
`message_edited` socket handler invokes it. `useMessageSearchIndex` indexes whatever
messages it's given (decrypting ciphertext client-side first) but has no logic to react
to either event. In the current client, a deleted message's plaintext can remain
searchable in the local index after the server has discarded its ciphertext, and an
edited message is indexed as an additional, separate entry (its own `id`) rather than
replacing the original's index entry — consistent with the fact that an edit really is a
new message server-side, but worth calling out explicitly since nothing currently
reconciles the two entries into one on the client either.

## Implementation references

- `apps/backend/src/socket/messaging.ts` — `edit_message`, `delete_message` handlers
- `apps/backend/src/lib/messageFanout.ts` — `findMissingSiblingDeviceIds`
- `apps/backend/src/routes/sync.ts` — envelope catch-up endpoint, `isNull(messages.deletedAt)` filter
- `apps/backend/src/routes/conversations.ts` — `supersededRows`, how the message list collapses an edit chain to its tip
- `apps/backend/src/services/fileCleanup.ts` — `softDeleteFile`, `runHardDeletePass`
- `apps/backend/src/db/schema.ts` — `messages.editsMessageId`, `messages.deletedAt`, `messages.fileId`
- `apps/web/src/lib/search/searchClient.ts` — `removeMessages` (unused), `indexMessages`
- `apps/web/src/hooks/useMessageSearchIndex.ts` — client-side indexing hook
- [`concepts-delivery-fanout.md`](./concepts-delivery-fanout.md) — the fan-out pipeline an edit's new envelope goes through, and the sibling-coverage gap this document's sibling check shares
- [`concepts-gc-jobs.md`](./concepts-gc-jobs.md) — file hard-delete pass scheduling and retention
- [`concepts-local-object-store.md`](./concepts-local-object-store.md) — #330, the dev/test storage backend the hard-delete pass also targets

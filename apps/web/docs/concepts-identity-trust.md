# Concepts: identity trust, TOFU, and safety numbers

The server checks that uploaded keys have the shape it expects
(`apps/backend/src/lib/keys.ts`). It does not store, and does not check, "is this still
the identity key this browser trusts." That decision is client-side trust-on-first-use
(TOFU), the same idea as Signal.

Two separate client mechanisms exist today. They do not share a record.

| Mechanism | File | What it decides |
| --- | --- | --- |
| Trusted snapshot | [`apps/web/src/lib/identityTrust.ts`](../src/lib/identityTrust.ts) | Whether `assertDevicesTrusted` will encrypt to the device set the server just returned. |
| Safety-number panel | [`apps/web/src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/[id]/page.tsx) | Whether the UI shows a "Safety number changed" warning for a contact. |

The comment at the top of `identityTrust.ts` says the panel reads and writes the same
record as the encryption pin. The page does not import `identityTrust.ts`. It uses a
different `localStorage` key. Treat the comment as stale relative to the page.

The non-technical companion is
[Devices, safety numbers, and privacy](../../../docs/user-guide/devices-and-privacy.md).
Where that guide says sending pauses until **Mark verified**, the page does not do that.
This document follows the code.

> **Stale when:** `defaultSession` in `apps/web/src/lib/session.ts` is switched from
> `Phase1SessionCrypto` to `LibsignalSessionCrypto`, or the conversation page starts
> calling `trustDevices`. Update the live-path and "what the user is shown" sections in
> that change.

## Trusted snapshot

A snapshot is the device set pinned for one user id:

```ts
interface TrustedDevice {
  id: string;
  identityPublicKey: string;
}

interface TrustedSnapshot {
  devices: TrustedDevice[];
  trustedAt: string; // ISO timestamp
}
```

`devices` is stored sorted by `id`.

| Function | Behaviour |
| --- | --- |
| `getTrustedSnapshot(userId)` | Returns the parsed snapshot, or `null` if the key is missing or the JSON is not `{ devices: array, trustedAt: string }`. A parse error also returns `null`. |
| `trustDevices(userId, devices)` | Writes a new snapshot with `trustedAt` set to now. This is the only way the pin moves forward. |
| `clearTrustedSnapshot(userId)` | Deletes the pin. Nothing in the conversation page calls it. |
| `checkIdentityChange(userId, devices)` | Compares `devices` to the pin. See below. |

`checkIdentityChange` is synchronous. Callers are expected to have already fetched the
live device set (the send path uses `GET /conversations/:id/devices`).

| Result `status` | When | Side effect |
| --- | --- | --- |
| `first-contact` | `getTrustedSnapshot` returned `null` | Calls `trustDevices` with the live set, then returns. `changedDeviceIds` is `[]`. |
| `trusted` | The pin and the live set have the same fingerprint | None. |
| `changed` | The fingerprints differ | Does **not** update the pin. Calls every `onSessionReset` subscriber with the changed device ids, then returns those ids. |

The fingerprint used for the comparison is not the safety number. It is
`id:identityPublicKey` for each device, sorted by `id`, joined with `|`. A change is any
of: a device id whose `identityPublicKey` differs, a device id present in the live set
but not in the pin, or a device id present in the pin but missing from the live set.
Order does not matter.

### Where the snapshot is persisted

`localStorage` key `clicked.identityTrust.${userId}`. The value is
`JSON.stringify` of the snapshot.

If `window.localStorage` is missing (SSR, a Node test, a webview with storage disabled),
reads and writes use an in-memory `Map` for the lifetime of that process. The check
still has something to compare against, instead of treating every call as first contact.
That map dies with the process. It is not a second store a browser user can inspect.

Clearing site data deletes the `localStorage` key. The in-memory map is irrelevant in a
normal browser session because `localStorage` is present, so the next check after a
clear is `first-contact` and the server's current keys are pinned with no prompt.

## When `IdentityKeyChangedError` is raised

`checkIdentityChange` does not throw. It returns `status: 'changed'`.

`IdentityKeyChangedError` is thrown by `assertDevicesTrusted` in
[`apps/web/src/lib/crypto.ts`](../src/lib/crypto.ts). That function groups the device
list by `userId`, calls `checkIdentityChange` for each user, and throws as soon as one
user returns `changed`. The error carries `userId` and `changedDeviceIds`. Its message
is `Identity key changed for user ${userId} — refusing to encrypt until the new safety number is verified`. The throw refuses the whole batch: no device in that call is
encrypted to. `first-contact` and `trusted` do not throw. A first-contact call has
already pinned inside `checkIdentityChange` before `assertDevicesTrusted` returns.

Call sites of `assertDevicesTrusted`:

| Call site | On the live send path? |
| --- | --- |
| `buildEnvelopes` in `crypto.ts` | Yes. `sendEncryptedMessage` and `sendEncryptedFile` (`apps/web/src/lib/fileEncryption.ts`) both go through `buildEnvelopes`. |
| `Phase1SessionCrypto.encryptToDevice` in `session.ts` | Only if something calls `defaultSession.encryptToDevice`. `buildEnvelopes` on the Phase-1 class delegates to `crypto.ts` `buildEnvelopes`, which checks again. |
| `LibsignalSessionCrypto.encryptToDevice` and `buildEnvelopes` | No. `defaultSession` is `new Phase1SessionCrypto()`. This class is not the live default. |

The conversation page calls `sendEncryptedMessage` from `handleSendEncrypted`. A thrown
`IdentityKeyChangedError` lands in that function's `catch`, which calls `console.error`
and then clears the sending flag. The text stays in the input because `setSendText('')`
runs only after a successful send. The page does not import `IdentityKeyChangedError`
and does not open the safety panel because of it.

## What `onSessionReset` subscribers do

`onSessionReset(handler)` registers `handler(deviceIds: string[])` and returns an
unregister function. `checkIdentityChange` calls every handler when the status is
`changed`, and only then. It does not call them on first contact or on a match.

The only registration outside tests is the module-level call in
[`apps/web/src/lib/signalSession.ts`](../src/lib/signalSession.ts). The handler deletes
the in-memory `DeviceSession` for each of those device ids, so a later
`ensureSession` on the Signal path would run X3DH again instead of reusing a session
for the old key. That module is imported by `signalClient.ts`, which
`LibsignalSessionCrypto` loads with a dynamic import. The live `Phase1SessionCrypto`
path does not import it, so this subscriber is not registered during a normal send.
Phase-1 encryption does not keep a ratchet session to tear down. The pin still blocks
the send, because `assertDevicesTrusted` throws whether or not a subscriber ran.

## Safety number

The panel does not compute a fingerprint. For each contact user id it
`GET`s `/users/${userId}/key-fingerprint` with the bearer token and renders the
`formatted` field.

The server builds that value from the user's active (non-revoked) device
`identityPublicKey`s: sort the base64 strings, join with `\n`, SHA-256, then two
30-digit decimal segments from non-overlapping 15-byte halves of the digest, modulo
10^30. `fingerprint` is the 60 digits. `formatted` is the same digits in 12 groups of
5, space-separated. Revoked devices are excluded. The full derivation, including the
error statuses, is [GET /users/:id/key-fingerprint](../../backend/docs/api-users.md#get-usersidkey-fingerprint).
The client does not recompute it, so the digits on screen are whatever that response
contained.

The page stores a verification record separately from the trust pin:

- Key: `clicked.safetyVerification.${userId}`
- Value: `{ fingerprint, verifiedAt }` where `fingerprint` is the raw 60-digit string
  and `verifiedAt` is an ISO timestamp
- `readVerification` returns `null` when `window` is missing, the key is absent, or the
  JSON is the wrong shape. There is no in-memory fallback for this key.

`changed` is true only when a stored verification exists and its `fingerprint` differs
from the response. No stored verification means `changed` is false, including the first
time the number is shown.

### How two users compare them

The number identifies one user's active device identity keys. It is not a pairwise
combination of both users' keys, so the two people in a DM are not shown one shared
number.

The panel lists conversation members other than the signed-in user
(`contacts` in the page). In a DM, user A sees user B's formatted number, and user B
sees user A's. Comparing the two screens against each other compares different users
and will not match even when both responses are honest.

A real comparison is: the 60-digit `fingerprint` (ignore spaces) shown for user B must
match the number computed from B's active identity keys. A can read B's number in this
panel. B's own number is not rendered on B's conversation page, so B cannot confirm it
from this screen. Out of band, they compare the groups of five for the same user id.

**Mark verified** (`verifyContact`) writes `clicked.safetyVerification.${userId}` for
the fingerprint currently on screen and clears `changed` in React state. It does not
call `trustDevices`. Dismissing the warning does not move the encryption pin.

### What the user is shown

| State | Header button | Banner | Card |
| --- | --- | --- | --- |
| Loading | "Safety numbers" (or the changed label if some other contact is already changed) | none for this card | `Loading safety number...` |
| Fetch failed | unchanged by the error | none | `Safety number unavailable` (or the `Error.message`) |
| Number loaded, no stored verification or the stored fingerprint matches | "Safety numbers" | none | the `formatted` digits, button label "Mark verified" |
| Stored fingerprint differs from the response | "Safety number changed" (amber, warning icon). The panel is opened. | "Safety number changed, tap to re-verify." | same sentence, button "Mark verified" |
| `verifiedAt` set and not `changed` | "Safety numbers" | none | a check icon, button label "Verified" |

The same banner and open panel are also set when a socket event arrives whose payload
names a contact in this conversation. The event names listened for are `key_set_changed`,
`key_changed`, `contact_key_changed`, `safety_number_changed`, and `system_event`. The
handler also calls `clearSessionKeys()` and `sessionStore.clear()`. That path is
independent of `checkIdentityChange`. An `IdentityKeyChangedError` from Send does not
switch the button or the banner. The user sees the composer keep their text and the
sending state end. The failure is `console.error` only.

## Limits

- TOFU trusts the first device set seen. `checkIdentityChange` pins it and returns
  `first-contact` with no prompt and no safety-number comparison.
- The pin moves only when something calls `trustDevices`. The safety panel's
  **Mark verified** button is not that call. After a real key change, Send keeps
  throwing `IdentityKeyChangedError` until some other caller re-pins, even if the user
  has marked the new number verified.
- Clearing browser storage deletes `clicked.identityTrust.*` and
  `clicked.safetyVerification.*`. The next encrypt is first contact and pins the keys
  the server returns. The next panel load has no stored fingerprint, so `changed` is
  false. Nothing tells the user that trust was reset.
- A corrupt trust-pin value parses as `null`, which is the same as first contact: the
  live set is pinned silently.
- The safety number is fetched from the server and displayed. This page does not
  recompute it from the device list, so it does not by itself detect a server that
  lies about the fingerprint.

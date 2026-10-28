# Client-Side Data-at-Rest Inventory

> **Purpose:** Comprehensive inventory of every client-side storage location in the web application (`apps/web`): in-memory caches, `localStorage`, `sessionStorage`, `IndexedDB` databases, and the service worker cache. This document details what data is stored, its classification/sensitivity, source modules, and lifecycle behaviors across logout, device revocation, and page unload.
>
> Complements [Frontend IndexedDB Store Schemas](./contracts-indexeddb-schemas.md) (which details IndexedDB internal schemas) and [Auth and Session Contract](./contracts-auth-session.md).

---

## 1. Master Inventory Table

The following table itemizes every client-side storage location across all storage subsystems in the web client.

| Storage Location | Key or Store Name | Contents | Sensitivity | Source Module |
| :--- | :--- | :--- | :--- | :--- |
| **In-Memory** | `cache` (`Map<string, string>`) | Decrypted message plaintext keyed by `messageId`. Kept in memory to avoid repeated decryptions while rendering. | **Plaintext** | [`src/lib/crypto/plaintextCache.ts`](../src/lib/crypto/plaintextCache.ts) |
| **In-Memory** | `sessionKeys` (`Map<string, CryptoKey>`) | AES-GCM 256-bit CryptoKey objects keyed by `senderDeviceId`. Used for inbound/outbound session message encryption/decryption. | **Private Key / Symmetric Key** | [`src/lib/crypto/sessionStore.ts`](../src/lib/crypto/sessionStore.ts) |
| **In-Memory** | `keyCache` (`Map<string, DevicePublicKey>`) | Identity public keys and device metadata fetched from `/user-devices/:id/public-key` keyed by `senderDeviceId`. | **Non-sensitive** (Public key / Metadata) | [`src/lib/crypto/deviceKeys.ts`](../src/lib/crypto/deviceKeys.ts) |
| **In-Memory** | `sessions` (`Map<string, DeviceSession>`) | Signal ratcheting session state per sibling/peer device: `deviceId`, `sendChainKey`, `sendMessageNumber`, `associatedData`, and `pendingInitialMessageHeader`. | **Private Key / Symmetric Key** | [`src/lib/signalSession.ts`](../src/lib/signalSession.ts) |
| **In-Memory** | `docs`, `inverted`, `docLengths` (`Map`) | Web Worker in-memory search index containing fully decrypted message text, token frequencies, and inverted index mappings. | **Plaintext** | [`src/lib/search/searchWorker.ts`](../src/lib/search/searchWorker.ts) |
| **In-Memory** | `memoryFallback` (`Map<string, string>`) | In-memory fallback map for peer identity trust snapshots when `window.localStorage` is unavailable. | **Metadata** (Public key fingerprint) | [`src/lib/identityTrust.ts`](../src/lib/identityTrust.ts) |
| **In-Memory** | `__clickedMemoryDbs` (`Map`) | In-memory simulated database stores when `window.indexedDB` is unavailable in the environment. | **Private Key / Plaintext / Metadata** | [`src/lib/cryptoStore.ts`](../src/lib/cryptoStore.ts), [`src/lib/sessionStore.ts`](../src/lib/sessionStore.ts) |
| **localStorage** | `clicked.e2eeDeviceId` | Client device identifier UUID generated on first use. Used across device identity registration and WebSocket realtime connection. | **Metadata** | [`src/lib/deviceIdentity.ts`](../src/lib/deviceIdentity.ts), [`src/lib/realtime.ts`](../src/lib/realtime.ts) |
| **localStorage** | `clicked.deviceIdentityPublicKey` | SPKI Base64-encoded Ed25519 public key corresponding to the device's signing identity. Note: The corresponding private key is generated as an unpersisted ephemeral CryptoKey in `deviceIdentity.ts` during auth challenge signing. | **Non-sensitive** (Public key) | [`src/lib/deviceIdentity.ts`](../src/lib/deviceIdentity.ts) |
| **localStorage** | `clicked.e2eDeviceId` | Legacy/alternate device identifier stored and read by JWT token claims helper. | **Metadata** | [`src/lib/jwt.ts`](../src/lib/jwt.ts) |
| **localStorage** | `clicked.jwt` | Primary JWT auth token received from `/auth/verify` after wallet signature verification. | **Plaintext** (Session credential) | [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx), [`src/components/auth/AuthProvider.tsx`](../src/components/auth/AuthProvider.tsx) |
| **localStorage** | `clicked_token` | Alias/legacy redundancy copy of the JWT auth token. | **Plaintext** (Session credential) | [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx), [`src/components/auth/AuthProvider.tsx`](../src/components/auth/AuthProvider.tsx) |
| **localStorage** | `auth_token` | Alias/legacy redundancy copy of the JWT auth token; also used as the primary token key by `lib/auth.tsx`. | **Plaintext** (Session credential) | [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx), [`src/lib/auth.tsx`](../src/lib/auth.tsx) |
| **localStorage** | `clicked.identityTrust.${userId}` | TOFU (Trust-On-First-Use) pinned device snapshot for user: JSON `{ devices: [{ id, identityPublicKey }], trustedAt }`. Used to detect key compromise / unauthorized device additions. | **Metadata** (Public key fingerprint) | [`src/lib/identityTrust.ts`](../src/lib/identityTrust.ts) |
| **localStorage** | `clicked.safetyVerification.${userId}` | Safety number manual verification record: JSON `{ fingerprint, verifiedAt }`. | **Metadata** (Verification state) | [`src/app/app/conversations/[id]/page.tsx`](../src/app/app/conversations/[id]/page.tsx) |
| **localStorage** | `clicked.socket.resumeCursor:${userId}` | WebSocket event cursor (UUID/ID string) for redelivery of missed realtime events upon reconnect. | **Metadata** | [`src/lib/realtime.ts`](../src/lib/realtime.ts) |
| **localStorage** | `clicked.socket.syncSequence:${userId}` | WebSocket sequential message counter for replay tracking. | **Metadata** | [`src/lib/realtime.ts`](../src/lib/realtime.ts) |
| **sessionStorage** | `clicked.push.dismissed` | Flag (`'1'`) indicating the user dismissed the push notification prompt banner for the current tab session. | **Non-sensitive** | [`src/components/PushPermissionPrompt.tsx`](../src/components/PushPermissionPrompt.tsx) |
| **IndexedDB** (`clicked_crypto`) | `keys` | Stored identity keypair (key: `"identity_keypair"`). Plaintext JWK representation of ECDH P-256 public and private key material. | **Private Key** (Unencrypted JWK) | [`src/lib/cryptoStore.ts`](../src/lib/cryptoStore.ts) |
| **IndexedDB** (`clicked_crypto`) | `deviceId` | Persistent device ID string (key: `"id"`), generated via timestamp and Math.random. | **Metadata** | [`src/lib/cryptoStore.ts`](../src/lib/cryptoStore.ts) |
| **IndexedDB** (`clicked_crypto`) | `identityKeyPair` | Structured-clone record of native `CryptoKeyPair` objects (key: `"current"`). | **Private Key** (Native CryptoKey) | [`src/lib/cryptoStore.ts`](../src/lib/cryptoStore.ts) |
| **IndexedDB** (`clicked_prekeys`) | `prekeys` | X3DH one-time and signed prekeys. Records include `keyId`, `publicKey` (JWK), `privateKey` (JWK), and `isOneTime` flag. | **Private Key** (Unencrypted JWK) | [`src/lib/prekeyStore.ts`](../src/lib/prekeyStore.ts) |
| **IndexedDB** (`clicked_prekeys`) | `signedPrekey` | Active signed prekey record with ECDSA signature and JWK keypair. | **Private Key** (Unencrypted JWK) | [`src/lib/prekeyStore.ts`](../src/lib/prekeyStore.ts) |
| **IndexedDB** (`clicked_sessions`) | `sessions` | Established X3DH session records keyed by `sessionId` or `peerDeviceId`. Holds unencrypted `sessionKey` JWK (AES-GCM shared secret) and counter metadata. | **Private Key / Symmetric Key** (Unencrypted JWK) | [`src/lib/sessionStore.ts`](../src/lib/sessionStore.ts) |
| **IndexedDB** (`clicked_messages`) | `messages` | Local offline message cache. Contains encrypted message envelopes (`encryptedContent`, `iv`, `conversationId`, `timestamp`). Encrypted via AES-GCM with PBKDF2 key derived from identity key. | **Plaintext** (Application-layer encrypted) | [`src/lib/messageCache.ts`](../src/lib/messageCache.ts) *(historical / inactive)* |
| **IndexedDB** (`clicked-search`) | `messages` | Decrypted message records (`id`, `conversationId`, `senderId`, `content`, `createdAt`) used to build local full-text search index. | **Plaintext** (Decrypted message content) | [`src/lib/search/db.ts`](../src/lib/search/db.ts) |
| **IndexedDB** (`driptide-crypto`) | `double-ratchet-sessions` | Double Ratchet session state: `sessionId`, `rootKey`, `sendChainKey`, `receiveChainKey`, `sendingPrivateKey`, `sendingPublicKey`, `remotePublicKey`. | **Private Key / Symmetric Key** | [`src/lib/crypto/ratchetSession.ts`](../src/lib/crypto/ratchetSession.ts) |
| **Service Worker Cache** | *(None)* | The service worker (`public/sw.js`) registers **no** cache storage and intercepts no `fetch` requests. `caches.open()` is not invoked. | **Non-sensitive** (Empty) | [`public/sw.js`](../../public/sw.js) |

---

## 2. Sensitivity Classification Definitions

- **Private Key / Symmetric Key**: High-value cryptographic secrets. If compromised, an adversary can forge signatures, impersonate the device, or decrypt past/present/future encrypted communications. Includes identity private keys, prekey private keys, ratchet chain keys, and AES-GCM shared secrets.
- **Plaintext**: Unencrypted user content or session authorization tokens. Compromise exposes conversation messages or grants unauthorized API access as the authenticated user.
- **Metadata**: Non-content operational data. Exposes identity public keys, device IDs, peer fingerprints, socket sequence cursors, or timing timestamps. Does not expose message bodies or private keys, but can be leveraged for traffic analysis or tracking.
- **Non-sensitive**: Generic UI state, dismissed banners, or public static metadata that carry no privacy or security risk.

---

## 3. Storage Subsystems Detail

### 3.1 In-Memory Storage

1. **Plaintext Message Cache** ([`src/lib/crypto/plaintextCache.ts`](../src/lib/crypto/plaintextCache.ts)):
   - Stores decrypted message bodies mapped by `messageId`.
   - **Lifecycle:** Ephemeral. Automatically cleared on window unload via `window.addEventListener('beforeunload', clearPlaintextCache)`. Also provides manual `clearPlaintextCache()`.
2. **Session Key Stores** ([`src/lib/crypto/sessionStore.ts`](../src/lib/crypto/sessionStore.ts) & [`src/lib/signalSession.ts`](../src/lib/signalSession.ts)):
   - Store active CryptoKey objects and chain keys in module-level `Map` instances (`sessionKeys`, `sessions`).
   - `signalSession.ts` registers a callback with `identityTrust.ts` (`onSessionReset`) to automatically evict sessions for peer devices whose identity key changed.
   - Provides explicit helpers (`clearSessionKeys()`, `clearAllSessions()`).
3. **Local Search Index** ([`src/lib/search/searchWorker.ts`](../src/lib/search/searchWorker.ts)):
   - The search worker holds inverted index postings, document token lengths, and parsed message documents in memory.
   - Responds to `{ type: 'clear' }` messages to wipe all in-memory index structures.

### 3.2 `localStorage`

- Key-value synchronous storage scoped to the client origin (`https://...`).
- Stores authentication credentials (`clicked.jwt`, `clicked_token`, `auth_token`), device identity information (`clicked.e2eeDeviceId`, `clicked.deviceIdentityPublicKey`, `clicked.e2eDeviceId`), peer trust records (`clicked.identityTrust.${userId}`), manual safety number verification records (`clicked.safetyVerification.${userId}`), and realtime resume cursors (`clicked.socket.resumeCursor:${userId}`, `clicked.socket.syncSequence:${userId}`).
- **Security Concern:** Any script executing in the origin context (including third-party scripts or XSS vulnerabilities) can read all tokens, device IDs, and trust pins.

### 3.3 `sessionStorage`

- Storage scoped to the lifetime of a specific browser tab.
- Contains `clicked.push.dismissed`, recording when the user closes the push permission prompt without enabling notifications.
- Automatically wiped when the browser tab is closed.

### 3.4 IndexedDB Databases

The web application opens several IndexedDB databases:
1. **`clicked_crypto`** (Version 2): Identity keys and device ID. Contains unencrypted ECDH P-256 JWK private keys (`keys` store) and native `CryptoKey` objects (`identityKeyPair` store).
2. **`clicked_prekeys`** (Version 1): X3DH signed and one-time prekey pool. Holds unencrypted private key JWKs.
3. **`clicked_sessions`** (Version 1): Established shared secrets for Phase-1 sealed-box encryption. Holds unencrypted AES-GCM JWKs.
4. **`clicked-search`** (Version 1): Local search database. Stores fully decrypted plaintext messages in store `messages` to allow client-side full-text search.
5. **`driptide-crypto`** (Version 1): Double Ratchet session persistence. Stores root keys, chain keys, and sending private keys in store `double-ratchet-sessions`.
6. **`clicked_messages`** (Version 1, *historical/inactive*): Local encrypted message store using AES-GCM derived via PBKDF2 from identity key material.

### 3.5 Service Worker Cache

- **Service Worker File:** [`public/sw.js`](../../public/sw.js)
- Registered by `hooks/usePushSubscription.ts` for push event notifications.
- **Cache Inventory:** **None.** The service worker does not implement a `fetch` event listener, does not open any cache storage (`caches.open`), and maintains no offline asset cache. All network requests bypass the service worker.

---

## 4. Logout, Device Revocation, and Teardown Behaviors

### 4.1 What Logout (`signOut`) Clears

When `signOut()` is called in [`src/contexts/AuthContext.tsx`](../src/contexts/AuthContext.tsx#L103-L107):
- Removes the 3 JWT storage keys in `localStorage`: `clicked.jwt`, `clicked_token`, `auth_token`.
- Clears React state: `setToken(null)` and `setUser(null)`.

When `clearToken()` is called in [`src/components/auth/AuthProvider.tsx`](../src/components/auth/AuthProvider.tsx#L33-L38):
- Removes the 3 JWT keys in `localStorage`: `clicked_token`, `clicked.jwt`, `auth_token`.
- Clears local React token state: `setTokenState(null)`.

### 4.2 What Device Revocation Clears

When a device is revoked or "Log out other devices" is triggered in [`src/app/app/devices/page.tsx`](../src/app/app/devices/page.tsx#L76-L124):
- The client calls `DELETE /devices/:id` or `POST /devices/logout-everywhere` with the caller's JWT bearer token.
- **Backend action:** The server marks the revoked device records in the database (`is_revoked = true`) or revokes sessions associated with other devices.
- **Local client action:** On the revoking device, the UI updates its local component state (`device.isRevoked = true`).
- **Target device action:** If a revoked device subsequently makes an authenticated API call, the server rejects the request with `401 Unauthorized`. However, **no push signal or automatic local storage purge occurs on the revoked device itself**.

### 4.3 What Happens on Page Unload

- Ephemeral in-memory structures are cleared:
  - `plaintextCache.ts` listens to `beforeunload` and clears its cache.
  - All process memory (`Map` instances, Web Worker state, React state) is discarded by the browser.
- `sessionStorage` persists across reloads in the same tab, but is destroyed when the tab is closed.
- `localStorage` and `IndexedDB` remain intact on disk.

---

## 5. Known Gaps and Persistence Vulnerabilities

The following data items **survive logout and device revocation**, representing known architectural gaps:

| Data Item | Storage Location | Sensitivity | Why It Survives / Impact |
| :--- | :--- | :--- | :--- |
| **Decrypted Search Index** | IndexedDB (`clicked-search`) | **Plaintext** | Never purged on `signOut()`. Plaintext message content from previous conversations remains readable in IndexedDB by anyone with physical access to the browser or via XSS. |
| **Cryptographic Identity Keys** | IndexedDB (`clicked_crypto`) | **Private Key** | The ECDH P-256 identity keypair and device ID survive logout. If another user signs in on the same browser profile, they inherit or share the previous device's identity keys. |
| **Prekey & Session Stores** | IndexedDB (`clicked_prekeys`, `clicked_sessions`, `driptide-crypto`) | **Private Key / Symmetric Key** | Unencrypted private prekeys, ratchet states, and session keys survive logout. |
| **Device ID & Public Key** | `localStorage` (`clicked.e2eeDeviceId`, `clicked.deviceIdentityPublicKey`, `clicked.e2eDeviceId`) | **Metadata / Public Key** | Survives logout. A new sign-in will reuse the existing device ID and Ed25519 public key rather than provisioning a fresh device identity. |
| **Identity Trust Pins** | `localStorage` (`clicked.identityTrust.${userId}`) | **Metadata** | TOFU peer identity pins remain stored after sign out. |
| **Safety Number Verifications** | `localStorage` (`clicked.safetyVerification.${userId}`) | **Metadata** | Manual safety verification records remain stored after sign out. |
| **Realtime Resume Cursors** | `localStorage` (`clicked.socket.resumeCursor:*`, `clicked.socket.syncSequence:*`) | **Metadata** | Socket sync cursors survive sign out. |
| **Revoked Device Data** | All stores on revoked client | **All categories** | Revoking a device on the server does not proactively trigger local data wipe on the revoked client device. All stored messages, IndexedDB stores, and keys remain at rest on the client until manually purged or overwritten. |

---

## 6. Authentication Fallback Token Security Notice

> [!CAUTION]
> **CRITICAL SECURITY REQUIREMENT: `NEXT_PUBLIC_AUTH_TOKEN` MUST NEVER BE SET IN PRODUCTION BUILDS**
>
> In [`src/lib/auth.tsx`](../src/lib/auth.tsx#L23-L25):
> ```ts
> const stored = window.localStorage.getItem('auth_token');
> return stored || process.env.NEXT_PUBLIC_AUTH_TOKEN || null;
> ```
> 
> The environment variable `NEXT_PUBLIC_AUTH_TOKEN` is provided purely as an optional developer fallback during local development and testing. 
> 
> Because Next.js inlines all variables prefixed with `NEXT_PUBLIC_` directly into the public client JavaScript bundles at build time, defining `NEXT_PUBLIC_AUTH_TOKEN` in a production build will **hard-code a static authorization token into client-facing bundles**, allowing any anonymous visitor to impersonate that account and bypass authentication. 
> 
> `NEXT_PUBLIC_AUTH_TOKEN` must be strictly restricted to local `.env.development.local` environments and forbidden in CI/CD production pipelines.

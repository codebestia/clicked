# App routing & conversation UI architecture

This note documents the Next.js App Router structure under [src/app](../src/app), the authenticated shell under [src/app/app](../src/app/app), and how the conversation view composes its message list, input, and safety-number UI. It is written against the routing structure as it exists after the route-consolidation work.

## 1. App Router structure under `src/app`

The web app uses the Next.js App Router. The route tree is rooted at [src/app](../src/app):

- [src/app/layout.tsx](../src/app/layout.tsx) is the root layout. It wraps the whole app in `WalletProvider` → `AuthProvider` → `ToastProvider` and is responsible for global metadata and fonts.
- [src/app/page.tsx](../src/app/page.tsx) serves the public landing page at `/`.
- [src/app/app/layout.tsx](../src/app/app/layout.tsx) is the authenticated app shell at `/app` (see section 2).
- [src/app/app/*](../src/app/app) contains the authenticated child routes (see section 3).
- [src/app/providers.tsx](../src/app/providers.tsx) exposes the `Providers` client component used by tests and smaller entry points that need `AuthProvider` without the full root layout.
- [src/app/globals.css](../src/app/globals.css) holds the global stylesheet.

Because the authenticated area lives under `src/app/app`, every route below it is URL-namespaced under `/app`, and the shell layout at `/app` is what renders the persistent sidebar and wallet chrome.

## 2. The authenticated `app/app/` shell

[src/app/app/layout.tsx](../src/app/app/layout.tsx) is the layout shared by every authenticated page. It is a `'use client'` component that provides:

- The fixed left sidebar with the Clicked logo and the primary navigation items: **Messages** (`/app/messages`), **Treasury** (`/app/treasury`), **Proposals** (`/app/proposals`), and **Devices** (`/app/devices`).
- Active-route highlighting via `usePathname`, plus a fallback so `/app` is treated as the Messages entry.
- Wallet connect/disconnect in the sidebar footer, backed by `useWallet`.
- A service-worker message listener (`sw:sync`) that routes a push-clicked notification to the matching conversation or back to `/app/messages`.
- The global `PushPermissionPrompt`, shown a few seconds after entering the app unless suppressed.

Every page under `src/app/app` renders inside this shell, so the sidebar and wallet chrome persist across the authenticated routes.

## 3. Child routes under `src/app/app`

| Route | File | Purpose |
| --- | --- | --- |
| `/app` | [src/app/app/page.tsx](../src/app/app/page.tsx) | Default authenticated landing view; a demo direct-message thread with inline send and a `MessageSearch` sidebar. |
| `/app/messages` | [src/app/app/messages/page.tsx](../src/app/app/messages/page.tsx) | Alias of `/app`; re-exports `../page` so the Messages nav item and the default route render the same view. |
| `/app/conversations/:id` | [src/app/app/conversations/[id]/page.tsx](../src/app/app/conversations/[id]/page.tsx) | Full conversation view: end-to-end encrypted message list, composer, file sharing, and safety numbers (see section 4). |
| `/app/devices` | [src/app/app/devices/page.tsx](../src/app/app/devices/page.tsx) | Lists the user's linked devices with platform, last-seen, revoke, and logout-everywhere actions. |
| `/app/profile` | [src/app/app/profile/page.tsx](../src/app/app/profile/page.tsx) | Edits username, avatar, wallet linkage, and privacy settings such as presence, read receipts, and message permission. |
| `/app/proposals` | [src/app/app/proposals/page.tsx](../src/app/app/proposals/page.tsx) | Renders example governance proposals with client-side voting; currently a UI-only mock. |
| `/app/search` | [src/app/app/search/page.tsx](../src/app/app/search/page.tsx) | End-to-end encrypted local search over messages this device has decrypted, built on an IndexedDB index and a Web Worker. |
| `/app/treasury` | [src/app/app/treasury/page.tsx](../src/app/app/treasury/page.tsx) | Treasury dashboard with asset balances, proposal list, and the propose-withdrawal flow. |

## 4. The conversation view composition

The conversation page lives at [src/app/app/conversations/[id]/page.tsx](../src/app/app/conversations/[id]/page.tsx). It is a `'use client'` page that pulls together hooks, components, and crypto helpers to render a single encrypted thread.

### Data sources

The page reads the conversation id from the URL via `useParams` and gets the auth token from `useAuth`. On load it fetches three REST resources in parallel:

- `GET /users/me` — the current user, used to color own messages and filter contacts.
- `GET /conversations/:id` — the conversation record (type, name, members).
- `GET /conversations/:id/messages` — the persisted message page.

It opens a socket connection with `useSocket` and joins the room via `emitSocketEnvelope(socket, 'join_room', { conversationId })`.

### Message list

`useInboundPipeline({ socket, token, conversationId })` handles live envelope delivery (`message_envelope`, `device_envelope`, `new_message`) and offline sync, decrypting and exposing sorted `InboundMessage` records. The page merges those decrypted inbound messages with the REST-fetched page in the `allMessages` memo, filling in decrypted plaintext, file payloads, or an `unavailable` marker, and sorts by `createdAt`.

Each message row renders:

- `Avatar` for the sender, `EmptyState` when the thread is empty.
- `TransferCard` when a message parses as a `transfer` payload.
- `EncryptedThumbnail` plus a download button for image/video file messages, or a file attachment button for other file types.
- `UnavailableMessagePlaceholder` for messages that could not be decrypted.
- A plain bubble for text, with system-event labels derived from `systemPayload`.

### Composer and sending

The bottom bar contains a hidden file input, an attach button, a text input, and a Send button. Enter submits text through `sendEncryptedMessage` and then emits `send_message` on the socket. Files go through `fetchConversationDevices`, `generateEncryptedThumbnail`, and `sendEncryptedFile`, then emit `send_file_message`.

### Safety-number UI

Safety numbers are fetched per contact from `GET /users/:userId/key-fingerprint` via `loadSafetyNumber`. State lives in the `safetyByUser` map, and verification is persisted locally under the `clicked.safetyVerification.<userId>` localStorage key. The header shows a fingerprint button (or an amber "Safety number changed" alert) that toggles the safety-number panel; key-change socket events (`key_changed`, `safety_number_changed`, `system_event`, etc.) flag a contact as changed, clear session keys, and force re-verification.

## 5. Where to go next

- [concepts-message-pipeline.md](./concepts-message-pipeline.md) for the end-to-end message pipeline the conversation view plugs into.
- [concepts-e2ee-architecture.md](./concepts-e2ee-architecture.md) for the encryption and session model behind the safety numbers.
- [concepts-local-search.md](./concepts-local-search.md) for the search route's local indexing.
- [concepts-wallet-treasury-ui.md](./concepts-wallet-treasury-ui.md) for the treasury and proposals routes.

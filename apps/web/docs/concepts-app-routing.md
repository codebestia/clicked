# App Routing & Conversation UI Architecture

Source: [`src/app/`](../src/app/), in particular
[`layout.tsx`](../src/app/layout.tsx), [`page.tsx`](../src/app/page.tsx),
[`app/layout.tsx`](../src/app/app/layout.tsx) and
[`app/conversations/[id]/page.tsx`](../src/app/app/conversations/%5Bid%5D/page.tsx).

This describes the routing structure after the route-consolidation work (commit `f6a40ef`,
"retire duplicate conversation route and legacy chat demo"): there is now a single conversation
route, `/app/conversations/[id]`. For auth state see
[`concepts-auth-device-lifecycle.md`](concepts-auth-device-lifecycle.md); for the message
pipeline behind the conversation view see
[`concepts-message-pipeline.md`](concepts-message-pipeline.md) and
[`concepts-e2ee-architecture.md`](concepts-e2ee-architecture.md).

## Next.js App Router in one paragraph

The web app uses the App Router (`src/app/`). Each folder containing a `page.tsx` is a URL
segment; a `layout.tsx` wraps every page beneath it and persists across navigation between those
pages; a folder named `[id]` is a dynamic segment read with `useParams()`. Nearly every page here
is a client component (`'use client'`) because it depends on wallet, auth token or socket state.

## Route tree

```
src/app/
├── layout.tsx                  Root layout (all routes)
├── page.tsx                    /                          Landing page
├── globals.css, favicon.ico
├── providers.tsx               (not mounted — see "Leftovers")
├── routes/conversations.js     (not a route — see "Leftovers")
└── app/                        /app/*  Authenticated shell
    ├── layout.tsx              Sidebar, wallet button, push prompt
    ├── page.tsx                /app                       Demo messages view
    ├── messages/page.tsx       /app/messages              Re-exports /app page
    ├── conversations/[id]/page.tsx  /app/conversations/:id  Real conversation view
    ├── devices/page.tsx        /app/devices
    ├── profile/page.tsx        /app/profile
    ├── proposals/page.tsx      /app/proposals
    ├── search/page.tsx         /app/search
    └── treasury/page.tsx       /app/treasury
```

### Root layout and landing page

- [`app/layout.tsx`](../src/app/layout.tsx) sets metadata and fonts and nests the global
  providers, outermost first: `WalletContext` → `AuthProvider` → `ToastProvider`. Every route,
  including `/app/*`, can therefore call `useWallet()`, `useAuth()` and the toast API.
- [`app/page.tsx`](../src/app/page.tsx) (`/`) is the marketing page, wrapped in
  `<ProtectedRoute mode="unauthenticated">`: a visitor who already has a token is redirected to
  `/app`.

### The `/app` shell

[`app/app/layout.tsx`](../src/app/app/layout.tsx) is the shell shared by every route below. It
renders a fixed left sidebar (nav links for Messages, Treasury, Proposals and Devices, plus a
Connect/Disconnect wallet button using `useWallet()`) and puts the active page in `<main>`. It
also mounts `PushPermissionPrompt` and listens for `sw:sync` messages from the service worker
(see [`concepts-service-worker.md`](concepts-service-worker.md)): a notification click navigates
to `/app/conversations/:id`, or to `/app/messages` if no conversation id was sent.

The shell does **not** wrap its children in `ProtectedRoute mode="authenticated"`. Pages that
need a token handle a missing one themselves (for instance the conversation page shows "Sign in
to view this conversation.").

### Top-level routes under `app/app/`

| Route | Purpose |
|---|---|
| `/app` | Default landing inside the shell; currently a **demo** chat view with hard-coded messages and a local search panel, not wired to the backend. The sidebar highlights "Messages" for this path. |
| `/app/messages` | Alias of `/app` (`export { default } from '../page'`), and the sidebar's "Messages" target. |
| `/app/conversations/[id]` | The real, end-to-end encrypted conversation view for one direct or group conversation. Detailed below. |
| `/app/devices` | Lists the signed-in user's registered devices and lets them be managed/revoked, via `apiFetch` and modals. |
| `/app/profile` | Shows and edits the signed-in user's profile and linked wallets, via `apiFetch`. |
| `/app/proposals` | Community funding proposals list with voting UI; currently driven by local sample state. |
| `/app/search` | Full-page local message search (`MessageSearch` over the on-device index) with an indexed-message count. |
| `/app/treasury` | Group treasury view: fetches withdraw proposals, shows `ProposalCard`s, and opens `ProposeWithdrawalModal`; updates live through `useSocket`. See [`components-treasury-wallet.md`](components-treasury-wallet.md). |

`/app/profile` is routed but has no sidebar entry; it is reached by direct link.

## Conversation view (`/app/conversations/[id]`)

`ConversationPage` is a single client component (~900 lines) that owns data loading, send
handlers, and rendering. It does **not** delegate to the components in `components/messaging/`
(`MessageThread`, `InboundMessageRow`) or `components/chat/` (`ConversationHeader`,
`NewConversationModal`), nor to `ConversationListSidebar`; none of those is imported by any
route. Orient yourself in the page file by these parts.

### Hooks and libraries it pulls together

| Concern | What it uses |
|---|---|
| Route param | `useParams<{ id }>()` gives the conversation id. |
| Auth | `useAuth()` supplies `token` and `loading`; no token → error state. |
| Realtime | `useSocket(token)`; on mount emits `join_room` via `emitSocketEnvelope`. |
| Incoming messages | `useInboundPipeline({ socket, token, conversationId })` receives, decrypts and orders envelopes, returning `messages` with `decrypted` / `unavailable` status. |
| Sending text | `sendEncryptedMessage` from `lib/crypto`, then `socket.emit('send_message')`. |
| Sending files | `fetchConversationDevices`, `generateEncryptedThumbnail`, `sendEncryptedFile`, then `socket.emit('send_file_message')`; download via `downloadAndDecryptFile`. |
| Key-change reset | `clearSessionKeys()` and `sessionStore.clear()` when a key-change socket event arrives. |
| Presentation | `Avatar`, `EmptyState`, `TransferCard`, `EncryptedThumbnail`, `UnavailableMessagePlaceholder`. |

### Data flow

1. **Initial load.** An effect (waits for auth) fetches in parallel `GET /users/me`,
   `GET /conversations/:id` and `GET /conversations/:id/messages` into `currentUser`,
   `conversation` and `messages`.
2. **Merge.** The `allMessages` memo overlays pipeline results on the REST history by message
   id: a decrypted inbound entry supplies `content` (and a parsed `filePayload` for
   `file`/`image`/`video` types), an `unavailable` one marks the row undecryptable, and inbound
   messages not yet in REST history are appended. The result is sorted by `createdAt`.
3. **Derive.** `contacts` (members other than the current user), `title` and
   `hasChangedSafetyNumber` are computed from state.

### Layout and the message list

The component renders a flex row of two panes:

- **Main column (`<section>`)**: a header (avatar, title, member count or primary wallet, and the
  safety-numbers toggle button), an optional amber "Safety number changed" banner, the scrolling
  **message list**, and the **input bar**.
- **Safety panel (`<aside>`)**, shown only while `isSafetyOpen`.

The message list maps `allMessages` and picks one body per message, in this order:
`TransferCard` (token-transfer payload) → `UnavailableMessagePlaceholder` → image/video
`EncryptedThumbnail` + download link → file download button → plain text bubble. System
messages (e.g. membership/key events) render as labelled text. A `bottomRef` element is scrolled
into view whenever the message count changes. An empty list shows `EmptyState`.

### Input bar

A hidden `<input type="file">` triggered by the paperclip button (`handleSendFile`, runs on file
selection), a text input where Enter (without Shift) calls `handleSendEncrypted`, and a Send
button. Both controls are disabled while `sending` is true. Failures are only logged with
`console.error`; no toast is shown.

### Safety-number UI

- **Loading.** For each contact, `loadSafetyNumber(userId)` calls
  `GET /users/:id/key-fingerprint` and stores `{ fingerprint, formatted }` in `safetyByUser`.
- **Verification record.** "Mark verified" (`verifyContact`) saves `{ fingerprint, verifiedAt }`
  to `localStorage` under `clicked.safetyVerification.<userId>`. This is per browser, not
  synced.
- **Change detection.** On load, a stored fingerprint that differs from the server's sets
  `changed = true`, clears `verifiedAt` and opens the panel. The same happens live when the
  socket emits `key_set_changed`, `key_changed`, `contact_key_changed`, `safety_number_changed`
  or `system_event` for a contact in this conversation (via `isRelevantKeyChangeEvent`); that
  handler also wipes cached session keys so the next send renegotiates.
- **Display.** The header button turns amber and relabels itself when any contact has changed;
  the panel lists each contact with the formatted number, a Verified/Mark verified button, and
  loading/error states.

## Leftovers

Two files under `src/app/` are not part of the route tree: [`providers.tsx`](../src/app/providers.tsx)
(an unused `AuthProvider` wrapper importing `../lib/auth`) and
[`routes/conversations.js`](../src/app/routes/conversations.js) (an Express router that looks
like a misplaced backend file; `routes/` has no `page.tsx`, so it serves nothing). Neither
affects routing, and new code should not build on them.

## Adding a route

1. Create `src/app/app/<name>/page.tsx` with `'use client'` if it needs wallet, auth or socket.
2. Add an entry to `navItems` in [`app/app/layout.tsx`](../src/app/app/layout.tsx) if it should
   appear in the sidebar. The active-state check is an exact `pathname === href` match, so nested
   paths do not highlight their parent.
3. Handle the signed-out case in the page (or wrap it in `ProtectedRoute mode="authenticated"`),
   since the shell does not guard children.

# Landing page components

Reference for `apps/web/src/components/landing/`. The public landing page is composed in
[`apps/web/src/app/page.tsx`](../src/app/page.tsx), which mounts these seven components in
order: `Navbar`, `Hero`, `Features`, `HowItWorks`, `TechStack`, `CTA`, `Footer`. The page
also mounts `ToastDemo` between `TechStack` and `CTA`. That component is not part of
`landing/` and is not covered here.

Every component in this folder is presentational. None of them take props. Copy and links
are string literals in the same file as the component (or in a `const` array at the top of
that file). There is no i18n catalog and no shared copy module.

> **Stale when:** a string in the [claims to correct](#claims-that-currently-overstate) table
> is edited or removed. Update that row in the same change.

## Accuracy rule

The landing page makes public claims about the product. A feature or technology named here
must match what is shipped in the current code. Do not describe a phase, a dependency, or a
roadmap item as if it were the live path.

The live message-encryption default is `Phase1SessionCrypto` in
[`apps/web/src/lib/session.ts`](../src/lib/session.ts) (sealed-box: WebCrypto ECDH + HKDF +
AES-256-GCM). `LibsignalSessionCrypto` exists in the same file and is not assigned to
`defaultSession`. The Signal protocol is not the live default. See
[Signal integration](../../../docs/signal-integration.md) for the swap that has not been made.

## Claims that currently overstate

These strings are in the components today. Correct the copy; do not "fix" this list by
softening the description of the code.

| Where | Claim in the component | What the code does |
| --- | --- | --- |
| `TechStack.tsx` `STACK` | `XMTP` under Messaging | Nothing in the app imports or calls XMTP. `XMTP_ENV` is unused ([environment variables](../../../docs/environment-variables.md)). Live encryption is `Phase1SessionCrypto`, not XMTP and not Signal. |
| `Features.tsx` `FEATURES` | "DAO-style Voting" — "One address, one voice — or weighted by contribution." | [`contracts/contracts/proposals/src/lib.rs`](../../../contracts/contracts/proposals/src/lib.rs) `vote` records one unweighted boolean per address (`yes_votes` or `no_votes` increments by 1). There is no contribution weight. |
| `Features.tsx` `FEATURES` | "AI-powered Insights" — "Fraud detection, proposal summarisation, and smart assistants baked into the conversation layer." | `apps/ai_agent` exposes summarise and transfer-risk HTTP APIs. No file under `apps/web/src` except this landing copy calls them. They are not wired into the conversation page. |
| `Features.tsx` `FEATURES` | "Send Tokens in Chat" — "Transfer XLM or any Soroban token inside a conversation." | In-chat transfer receipts render only when a message body parses as a transfer payload (`parseTransferPayload` in the conversation page). The composer has no payment control. Sending is `transferToken()` through Freighter ([token transfer flow](../../../docs/flows/token-transfer.md)), not an arbitrary Soroban token picked in the thread. |
| `Features.tsx` `FEATURES` | "Wallet-to-Wallet Messaging" — "No email, no username — just your public key." | Sign-in is a wallet signature plus a device identity key ([auth and device lifecycle](./concepts-auth-device-lifecycle.md)). Users have an optional `username`. The conversation header prefers `username` over the wallet address. |
| `Hero.tsx` | "decentralized messaging platform" | The client encrypts before upload. Delivery and ciphertext storage are the backend relay, not a decentralized messaging network. |
| `HowItWorks.tsx` `STEPS` step 02 | "Conversations are end-to-end linked to on-chain identities." | Encryption targets device identity public keys held by the backend. A conversation is not an on-chain identity record. |
| `HowItWorks.tsx` `STEPS` step 03 | "Type a transfer command or tap the payment button." | The conversation composer is a text field, an attach button, and Send. There is no transfer-command parser and no payment button on that page. |
| `HowItWorks.tsx` `STEPS` step 04 | "all without leaving the conversation." | Proposals and treasury UI are [`apps/web/src/app/app/treasury/page.tsx`](../src/app/app/treasury/page.tsx), a separate route. |
| `Footer.tsx` | `MIT License` | There is no `LICENSE` file in the repo. `apps/backend/package.json` sets `"license": "ISC"`. The footer string is plain text, not a link to a license. |

Claims that match the current stack closely enough to leave alone: Next.js 16 (`next` 16.2.0
in `apps/web/package.json`), Tailwind CSS v4, Express 5 (`express` ^5.2.1 in
`apps/backend/package.json`), Socket.IO, PostgreSQL, Redis, Soroban, the Stellar SDK,
FastAPI, Weaviate, and Turborepo. "Built on Stellar · Powered by Soroban" and the Freighter
sign-in step match the wallet path.

## Responsive breakpoints and dark mode

Breakpoint and dark-mode rules for the whole web app are in the styling guide
([#346](https://github.com/codebestia/clicked/issues/346)):
[Tailwind and styling conventions](./styling.md#4-responsive-breakpoints) and
[dark mode](./styling.md#7-dark-mode).

Short version, as it applies here:

- Tailwind defaults, mobile-first. This folder uses `sm` (640px) and `lg` (1024px) only.
  It does not use `md`, `xl`, or `2xl`.
- The page is dark-only. Colours are the `:root` tokens in
  [`apps/web/src/app/globals.css`](../src/app/globals.css) (`--background`, `--foreground`,
  `--accent`, `--accent-light`, `--muted`, `--card`, `--border`), read as
  `bg-[var(--token)]` / `text-[var(--token)]`. There is no theme toggle, no
  `prefers-color-scheme` block, and no `dark:` class in this folder. Do not add `dark:`
  variants.

| Component | Breakpoint behaviour |
| --- | --- |
| `Navbar` | Anchor links are `hidden` until `sm:flex`. "Launch App" stays visible at all widths. |
| `Hero` | Headline steps `text-5xl` → `sm:text-6xl` → `lg:text-7xl`. The two buttons stack until `sm:flex-row`. |
| `Features` | Heading `text-3xl` → `sm:text-4xl`. Cards are one column, then `sm:grid-cols-2`, then `lg:grid-cols-3`. |
| `HowItWorks` | Heading `text-3xl` → `sm:text-4xl`. Steps are one column, then `sm:grid-cols-2`, then `lg:grid-cols-4`. The step connector line is `hidden` until `lg:block`. |
| `TechStack` | Heading `text-3xl` → `sm:text-4xl`. Chips wrap with `flex-wrap` at every width. |
| `CTA` | Heading `text-3xl` → `sm:text-4xl`. |
| `Footer` | Column until `sm:flex-row`. |

## Navbar

`apps/web/src/components/landing/Navbar.tsx`

Fixed top bar. Brand wordmark, in-page anchors, and the entry to the app.

**Props:** none.

**Copy and links** (all inline in the JSX):

| Text | href |
| --- | --- |
| `clicked.` | none (not a link) |
| Features | `#features` |
| How it works | `#how-it-works` |
| Tech | `#tech` |
| Launch App | `/app` |

## Hero

`apps/web/src/components/landing/Hero.tsx`

Full-viewport introduction: eyebrow, headline, one paragraph, two actions, and a static
fake thread. The thread is not connected to the messaging API.

**Props:** none. `ChatBubble` is a private function in this file, not exported. Its props
are `align: 'left' | 'right'`, `name: string`, `message: string`, and optional
`highlight?: boolean`. The three bubbles and their names and messages are inline JSX, not
a data array.

**Copy and links:**

| Text | Where |
| --- | --- |
| `Built on Stellar · Powered by Soroban` | eyebrow `<span>` |
| `Chat. Pay. Build together.` | `<h1>` |
| The "decentralized messaging platform…" paragraph | the `<p>` under the heading |
| Launch App | `href="/app"` |
| View on GitHub | `href="https://github.com/codebestia/clicked"` (`target="_blank"`) |
| `builders-dao`, `4 members`, `alice.xlm`, `bob.xlm`, `You`, and the three bubble strings | mock preview only |

## Features

`apps/web/src/components/landing/Features.tsx`

Section `id="features"`. Heading plus six cards.

**Props:** none.

**Copy:** the heading "Everything in one place" and the subtitle under it are inline JSX.
Card icon, title, and description live in the `FEATURES` array at the top of the file.
Edit that array to change a card. Titles today: Wallet-to-Wallet Messaging, Send Tokens in
Chat, Group Treasuries, Community Proposals, DAO-style Voting, AI-powered Insights.

**Links:** none. The section is the target of Navbar's `#features` anchor.

## HowItWorks

`apps/web/src/components/landing/HowItWorks.tsx`

Section `id="how-it-works"`. Four numbered steps.

**Props:** none.

**Copy:** the heading "How it works" and the subtitle are inline JSX. Step number, title,
and description live in the `STEPS` array (`01`–`04`).

**Links:** none. The section is the target of Navbar's `#how-it-works` anchor.

## TechStack

`apps/web/src/components/landing/TechStack.tsx`

Section `id="tech"`. A wrap of technology chips.

**Props:** none.

**Copy:** the heading "Built on proven technology" and the subtitle are inline JSX. Chip
label and category live in the `STACK` array. Chip colours are the `CATEGORY_COLORS` map
in the same file (raw Tailwind palette classes, not the `globals.css` tokens).

**Links:** none. The section is the target of Navbar's `#tech` anchor.

## CTA

`apps/web/src/components/landing/CTA.tsx`

Closing band under the fold.

**Props:** none.

**Copy and links** (inline JSX):

| Text | href |
| --- | --- |
| `Ready to coordinate on-chain?` | none |
| `Connect your Stellar wallet and start building with your community.` | none |
| Launch App | `/app` |

## Footer

`apps/web/src/components/landing/Footer.tsx`

**Props:** none.

**Copy and links** (inline JSX):

| Text | href |
| --- | --- |
| `clicked. — Web3 Social Messaging` | none |
| GitHub | `https://github.com/codebestia/clicked` |
| Stellar | `https://stellar.org` |
| `MIT License` | none (plain text, not a link) |

# AI assistant bridge (`ask_assistant`)

This document traces the full `ask_assistant` request path and states plainly what it
means for the E2EE model: **a server-authored reply is not end-to-end encrypted, and the
message content a user sends the assistant is seen in plaintext by both the backend and
a third-party LLM provider.** This is a deliberate boundary in the current design, not a
bug, but it is easy to miss from reading only the client code, so this document exists to
make it explicit.

## Contents

- [The request path, end to end](#the-request-path-end-to-end)
- [The hardcoded agent URL](#the-hardcoded-agent-url)
- [What plaintext leaves the client, and where it goes](#what-plaintext-leaves-the-client-and-where-it-goes)
- [Failure behavior](#failure-behavior)
- [Implementation references](#implementation-references)

## The request path, end to end

1. **Client emits `ask_assistant`** with `{ conversationId, content }`, where `content`
   is the plaintext the user typed (not ciphertext — see
   [below](#what-plaintext-leaves-the-client-and-where-it-goes) for why that matters).
2. **Trigger check**: the handler (`socket/messaging.ts`) only proceeds if
   `content.trim().startsWith('@assistant')`. Anything else is silently ignored — no
   error is emitted for a message that doesn't start with the trigger, since this handler
   doesn't know whether the client meant to invoke it.
3. **Membership check**: the caller must be a member of `conversationId`
   (`conversationMembers` lookup), or it gets
   `{ event: 'ask_assistant', message: 'Not a member of this conversation' }`.
4. **Rate limit**: `consumeRateLimit('socket_ask_assistant', `user:${userId}`)` — charged
   per user, not per device, because the resource being protected is the downstream AI
   call, which one account could run up from any of its devices. Configured alongside
   every other limit in `config/rateLimits.ts`. On rejection:
   `{ event: 'rate_limited', limitedEvent: 'ask_assistant', limit, retryAfterSeconds }`.
5. **HTTP call to the AI agent**:
   ```ts
   const response = await fetch('http://localhost:8000/chat', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ message: content, conversation_id: conversationId }),
   });
   ```
   `content` — the user's plaintext — is sent verbatim as `message`. See
   [`apps/ai_agent/docs/api-chat.md`](../../ai_agent/docs/api-chat.md) (the AI agent API
   reference, #302) for the full request/response contract, model (`gpt-4o-mini`), system
   prompt, and failure modes of this endpoint.
6. **Ensure the assistant "user" exists**: a fixed, well-known id
   (`ASSISTANT_USER_ID = '00000000-0000-4000-8000-000000000000'`) is upserted into
   `users` (`ON CONFLICT (id) DO NOTHING`) and added to `conversation_members` for this
   conversation if not already present. This is how the assistant's reply gets a
   `senderId` and shows up as a conversation participant like any other user.
7. **Reply persisted and fanned out as a normal message**:
   - `buildBroadcastEnvelopes` (`lib/messageFanout.ts`) resolves every active device of
     every conversation member (the sender's own other devices included — the reply must
     reach all of them, not just the device that asked) and builds one envelope per
     device, **all containing the identical plaintext reply** — a server-authored
     message has no per-recipient key material to vary the envelope by.
   - The message and its envelopes are inserted in one transaction, with
     `ciphertext: data.reply` — the field is named `ciphertext` (matching every other
     message row's schema) but what's actually stored is the AI's plaintext reply,
     unencrypted.
   - `deliverMessage(io, replyMessage, conversationId)` runs the same fan-out pipeline
     every other message goes through (see
     [`concepts-delivery-fanout.md`](./concepts-delivery-fanout.md)) — recipients receive
     it as an ordinary `message_envelope` + `new_message`, indistinguishable at the
     transport level from an end-to-end encrypted message.
   - Conversation-list caches are invalidated for every member.

## The hardcoded agent URL

`http://localhost:8000/chat` is a literal string in `socket/messaging.ts`, not read from
`process.env` or `config/*`. This is the only place in the codebase that addresses the AI
agent this way — contrast with every other external dependency (database, Redis, S3),
which goes through `config/index.ts`.

**What this means for deployment**: the backend and the AI agent (`apps/ai_agent`) must
run on the same host, with the agent bound to port 8000, for `ask_assistant` to work at
all. In any topology where they're on separate hosts or containers — which is how
`docker-compose`-based deployments normally separate services — this call fails with a
connection error every time, and `ask_assistant` silently degrades to
["Failed to get AI reply"](#failure-behavior) for every user. There is no environment
variable to override this today; fixing it means adding one (e.g. `AI_AGENT_URL`) and
reading it here, the same way every other external dependency is configured.

## What plaintext leaves the client, and where it goes

Walking the full path by what crosses a trust boundary:

1. **Client → backend**: the user's full message text (`content`), in plaintext, over
   the `ask_assistant` socket event. This is different from `send_message`, where the
   client sends opaque ciphertext the server never decrypts — `ask_assistant` is not an
   E2EE message send, it's a plaintext RPC the server happens to echo back through the
   messaging pipeline.
2. **Backend → AI agent**: the same plaintext, verbatim, as the `message` field of the
   `/chat` request body — the backend never encrypts, transforms, or redacts it in transit.
3. **AI agent → OpenAI**: per
   [`apps/ai_agent/docs/api-chat.md`](../../ai_agent/docs/api-chat.md) and
   [`apps/ai_agent/docs/concepts-prompts-and-models.md`](../../ai_agent/docs/concepts-prompts-and-models.md),
   the agent forwards the message to OpenAI's `gpt-4o-mini` as part of a chat completion
   call, alongside a fixed system prompt. **The user's message therefore leaves the
   Clicked infrastructure entirely and reaches a third-party API.**
4. **AI agent → backend → every recipient device**: the reply comes back as plaintext
   and is stored and fanned out as plaintext, as described above — every device in the
   conversation, not just the asker's, receives the assistant's reply in a form any of
   them can read without decryption.

**How a client should present this to the user**: any UI affordance for `@assistant`
should make clear, before the message is sent, that this is not a private, encrypted
message the way the rest of the conversation is — it is a request that leaves the
device in plaintext, is seen by the backend, is forwarded to an external AI provider,
and the reply is visible to every member of the conversation and every one of their
devices, exactly as if it had been posted as a message to the whole conversation. A user
who assumes `@assistant` messages carry the same confidentiality as the rest of an E2EE
conversation would be wrong, and the UI should not imply otherwise — e.g. by using the
same compose box and send affordance with no visual distinction.

This document is the privacy-boundary reference (#355) for this specific feature. For
how the AI agent itself handles the data once received (model, prompt, logging, retention
on that side), see the `apps/ai_agent/docs/` set linked above and below.

## Failure behavior

Everything from the HTTP call onward is inside one `try`/`catch`. Any failure —
connection refused (the hardcoded-URL case above), a non-2xx response (`response.ok`
check throws a generic `Error('AI agent error')`), a malformed JSON body, or a database
error during the insert — is caught and reduces to the same single outcome:

```ts
console.error('ask_assistant error:', err);
socket.emit('error', { event: 'ask_assistant', message: 'Failed to get AI reply' });
```

There is no distinction surfaced to the client between "the agent is unreachable,"
"the agent returned an error," "the agent was slow" (the agent enforces its own 30-second
request timeout per `api-chat.md`, but nothing here imposes a client-side timeout of its
own — a hung `fetch` would hang this handler for however long the underlying TCP
connection takes to fail, if ever), and "something else failed after a successful AI
response" (e.g. the database insert). A caller cannot tell from the error alone whether
retrying is likely to help.

## Implementation references

- `apps/backend/src/socket/messaging.ts` — `ask_assistant` handler, `ASSISTANT_USER_ID`
- `apps/backend/src/lib/messageFanout.ts` — `buildBroadcastEnvelopes`
- `apps/backend/src/config/rateLimits.ts` — `socket_ask_assistant` bucket
- `apps/backend/src/services/deliveryPipeline.ts` — `deliverMessage`, the fan-out the reply goes through
- `apps/ai_agent/main.py` — the `/chat` endpoint implementation
- [`apps/ai_agent/docs/api-chat.md`](../../ai_agent/docs/api-chat.md) — AI agent API reference (#302)
- [`apps/ai_agent/docs/concepts-prompts-and-models.md`](../../ai_agent/docs/concepts-prompts-and-models.md) — system prompt and model configuration
- [`concepts-delivery-fanout.md`](./concepts-delivery-fanout.md) — the fan-out pipeline the assistant's reply is delivered through like any other message

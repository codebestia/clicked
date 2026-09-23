# Environment variables

Every environment variable the Clicked services read, what reads it, whether it
is required, what it defaults to when it is missing, and what goes wrong when it
is set to something wrong.

The services are the token/bundle gateway (`apps/backend`), the Next.js client
(`apps/web`) and the Python AI service (`apps/ai_agent`). `.env.example` in the
repository root is the starting point for a local `.env`; it holds backend
variables only, and well over half of the variables the backend actually reads
are not in it — those are documented here too, marked "not in `.env.example`" or
otherwise. The coverage scan whose output accompanies this document checks both
directions: every name in `.env.example` is in a table, and every name in a table
is read by code or declared in an `.env.example` that exists.

## Two kinds of variable

The backend reads its configuration in two different ways, and the difference
matters when something is misconfigured.

**Validated at boot.** `apps/backend/src/config.ts` declares a zod schema
(`EnvSchema`) and `loadEnv()` parses `process.env` against it. `apps/backend/src/index.ts`
calls `loadEnv()` before it starts listening, and on any missing or malformed
value it prints the offending names and calls `process.exit(1)`. The process
never comes up, so the failure is loud and immediate.

**Read lazily.** Everything else is read at the point of use, several of them
per request or per background tick. Most have an in-code default. A missing or
misspelled name is therefore not an error: the default quietly applies and the
service behaves differently from what the operator intended. This is the silent
failure mode to watch for — a typo'd `RATE_LIMIT_*` override, for instance,
just leaves the built-in limit in place with a warning.

## Secrets

These values are credentials and must never be committed, pasted into an issue,
or put in a public CI log:

| Variable | Why |
| --- | --- |
| `JWT_SECRET` | Signs every auth token. Anyone with it can mint a token for any user. |
| `DATABASE_URL` | Usually embeds the Postgres password in the URL. |
| `REDIS_URL` | May embed a Redis password. |
| `OBJECT_STORE_ACCESS_KEY` | S3-compatible access key ID. |
| `OBJECT_STORE_SECRET_KEY` | The matching secret. |
| `VAPID_PRIVATE_KEY` | Signs web-push messages for every subscribed device. |
| `OPENAI_API_KEY` | Billable API credential for the AI service. |

`.env` is git-ignored; only `.env.example` is committed, and it must keep
placeholder or local-only values (the MinIO credentials in it match the
throwaway credentials in `infra/docker-compose.yml` and are not production
secrets). Never copy a real deployment's values into `.env.example`.

`NEXT_PUBLIC_AUTH_TOKEN` is treated separately below: it is not a server secret,
it is a token baked into a public JavaScript bundle.

## Backend: validated at boot

Source of truth: `apps/backend/src/config.ts`. A missing or malformed value in
this table stops the process with exit code 1 and the variable names printed to
stderr.

| Variable | App / reader | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | `apps/backend` — `src/config.ts`, also read directly in `src/db/index.ts` | Yes | none | Unset or empty: boot fails. Wrong host/credentials: boot succeeds, every query fails at runtime. `db/index.ts` has a hardcoded test-database fallback, but the boot check runs first in `index.ts`, so that fallback only matters for scripts that import the DB layer without going through `index.ts`. |
| `REDIS_URL` | `apps/backend` — `src/config.ts`, also `src/lib/redis.ts`, `src/index.ts` | Yes | none | Unset or empty: boot fails. Unreachable: the process still starts; rate limits, replay protection, presence and the Socket.IO multi-node adapter degrade (the adapter logs a warning and the gateway runs single-instance). |
| `JWT_SECRET` | `apps/backend` — `src/config.ts`, also `src/lib/jwt.ts` | Yes | none | Unset or empty: boot fails. Wrong or rotated: every existing token stops verifying and the login flow breaks. Tokens are issued with a 7-day expiry. |
| `PORT` | `apps/backend` — `src/config.ts`, also `src/index.ts`, `src/lib/localObjectStore.ts` | Yes | none | Unset: boot fails, even though `index.ts` contains an `?? 3001` fallback — the boot check runs first, so that fallback is unreachable in the normal start-up path. Non-numeric or non-positive: boot fails. |
| `TOKEN_TRANSFER_CONTRACT_ID` | `apps/backend` — `src/config.ts`, also `src/index.ts` | Yes | none | Unset: boot fails. Wrong contract: the Stellar listener follows a contract that never emits the expected events, so transfers are not picked up. Note `index.ts` treats it as optional when deciding whether to start the listener at all, so this is stricter than the listener code expects. |
| `OBJECT_STORE_ENDPOINT` | `apps/backend` — `src/config.ts`, consumed via `src/lib/objectStore.ts` | Yes | none | Unset: boot fails. Wrong endpoint: in production every presign, upload-confirm and download fails; in dev the S3 client is not used at all. |
| `OBJECT_STORE_BUCKET` | `apps/backend` — same as above | Yes | none | Unset: boot fails. Wrong bucket: uploads and downloads fail against a bucket that does not exist. |
| `OBJECT_STORE_ACCESS_KEY` | `apps/backend` — same as above | Yes | none | Unset: boot fails. Wrong key: S3 requests are rejected; uploads never confirm. |
| `OBJECT_STORE_SECRET_KEY` | `apps/backend` — same as above | Yes | none | Unset: boot fails. Wrong secret: same rejection as above. Secret — see the secrets table. |
| `OBJECT_STORE_REGION` | `apps/backend` — same as above | Yes | none | Unset: boot fails. Wrong region: signing succeeds but requests fail against AWS S3; MinIO and R2 ignore it in practice, which is why a wrong value can hide in local testing. |
| `OBJECT_STORE_FORCE_PATH_STYLE` | `apps/backend` — same as above | Yes | none | Accepts exactly `true`, `false`, `1`, `0`. Anything else (including empty): boot fails. Must be `true` for MinIO, `false` for AWS S3 / Cloudflare R2. Wrong value: all object requests fail. |
| `IDEMPOTENCY_TTL_SECONDS` | `apps/backend` — `src/config.ts` | No | none | Optional and validated as a positive integer when present, but nothing else in the codebase reads it — the value is accepted and then ignored. Set it expecting an effect and nothing happens. |
| `VAPID_PUBLIC_KEY` | `apps/backend` — `src/config.ts`, also read directly in `src/routes/push.ts` | No | none | Unset: push is silently disabled; `GET /push/vapid-public-key` answers `configured: false` and the client skips registering. Wrong key that does not match the private key: the push service rejects deliveries. |
| `VAPID_PRIVATE_KEY` | `apps/backend` — `src/config.ts`, `src/services/pushNotification.ts` | No | none | Unset: push is disabled (both keys must be set before `web-push` is initialised). Secret — see the secrets table. |
| `VAPID_SUBJECT` | `apps/backend` — `src/config.ts`, `src/services/pushNotification.ts` | No | `mailto:admin@clicked.app` | Must be a `mailto:` or URL contact; push services reject a malformed subject. |
| `S3_ENDPOINT` | `apps/backend` — `src/config.ts` only | No | none | Accepted by the schema and read by nothing else. The object store uses the `OBJECT_STORE_*` names. Setting these has no effect. |
| `S3_REGION` | `apps/backend` — `src/config.ts` only | No | none | Same as `S3_ENDPOINT`: accepted, unused. |
| `S3_ACCESS_KEY_ID` | `apps/backend` — `src/config.ts` only | No | none | Same as `S3_ENDPOINT`: accepted, unused. |
| `S3_SECRET_ACCESS_KEY` | `apps/backend` — `src/config.ts` only | No | none | Same as `S3_ENDPOINT`: accepted, unused. |
| `S3_BUCKET` | `apps/backend` — `src/config.ts` only | No | none | Same as `S3_ENDPOINT`: accepted, unused. |
| `S3_FORCE_PATH_STYLE` | `apps/backend` — `src/config.ts` only | No | none | Same as `S3_ENDPOINT`: accepted, unused. |

## Backend: read lazily

These are not checked at start-up. Unless the default column says otherwise, a
missing value falls back to the stated default in silence.

### Deployment, transport and origins

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | `src/app.ts`, `src/lib/objectStore.ts`, `src/lib/storage.ts`, `src/lib/transportSecurity.ts` | No | unset | `production` switches the object store to real S3, hides the `/local-storage` route and silences dev logging; anything else (including unset) keeps the local-disk store and the dev route. Setting `production` on a developer machine makes uploads go to the configured S3 endpoint instead of disk. |
| `APP_ENV` | `src/lib/transportSecurity.ts` | No | `NODE_ENV`, then `development` | Takes precedence over `NODE_ENV` when deciding whether plaintext transport is tolerated. Anything unrecognised is treated as production. Setting `APP_ENV=development` on a public deployment lets plaintext `http://` and `ws://` through. |
| `ENFORCE_TLS` | `src/lib/transportSecurity.ts` | No | enforced everywhere except `APP_ENV`/`NODE_ENV` of `development` or `test` | Overrides the environment-based decision in both directions. `false` on a public deployment accepts plaintext API calls and WebSocket handshakes. |
| `TRUST_PROXY` | `src/lib/transportSecurity.ts` | No | `1` | Number of proxy hops trusted for `X-Forwarded-*`. `0` when the gateway is exposed directly, otherwise a client can forge `X-Forwarded-Proto: https` and be treated as secure. A non-numeric or negative value falls back to `1`. |
| `HSTS_MAX_AGE` | `src/lib/transportSecurity.ts` | No | `31536000` (one year) | Seconds in the `Strict-Transport-Security` header. `0` disables the header entirely. Negative or non-numeric falls back to the default. |
| `HSTS_PRELOAD` | `src/lib/transportSecurity.ts` | No | `true` | Whether the `preload` directive is emitted. `false` keeps the header but drops it from preload consideration. |
| `ALLOWED_ORIGINS` | `src/lib/transportSecurity.ts` (used by the CORS middleware, the origin-policy middleware and the socket handshake) | No | empty | Comma-separated origin allowlist. Empty means "no cross-origin restriction" in dev; outside dev an empty list still requires the caller's origin to start with `https://`. Omitting a real front-end origin breaks the WebSocket handshake and every CORS request from it. |
| `TLS_PINNED_HOSTS` | `src/lib/certificatePinning.ts` | No | empty | Hostnames published in the pinning policy at `GET /security/transport-policy`. Wrong host means clients never pin. |
| `TLS_PINNED_SPKI_SHA256` | `src/lib/certificatePinning.ts` | No | empty | Primary `sha256/<base64-SPKI>` pin. Malformed entries are ignored with a warning. See the next row. |
| `TLS_BACKUP_SPKI_SHA256` | `src/lib/certificatePinning.ts` | No | empty | Backup pin. Pinning is only enforced when both a primary and a backup pin parse, so setting the primary without a backup leaves clients unpinned (deliberate: a backup-less pin set would brick installed apps if the pinned key were lost). |
| `TLS_PIN_MAX_AGE_SECONDS` | `src/lib/certificatePinning.ts` | No | `5184000` (60 days) | Cache lifetime advertised to clients. Zero, negative or non-numeric falls back to the default. |
| `TLS_PIN_REPORT_URI` | `src/lib/certificatePinning.ts` | No | none | Report-URI published with the policy. Unset means clients have nowhere to report pin violations (the field is simply absent). |
| `STELLAR_RPC_URL` | `src/index.ts` (Stellar event listener) | No | none | Not in `.env.example`. Unset: the transfer listener is disabled with a log line, no crash — transfers are silently never observed. Wrong URL: the listener logs connection failures and keeps retrying. |
| `GROUP_TREASURY_CONTRACT_ID` | `src/index.ts`, `src/routes/treasury.ts` | No | none (`treasury.ts` stores `'stub'`) | Not in `.env.example`. Unset: treasury event fetching is skipped and proposals are recorded with the literal contract ID `stub`. Wrong contract: treasury proposals are recorded against a contract that is not the one being watched. |
| `LOG_LEVEL` | `src/lib/logger.ts` | No | `info` | Pino level. An invalid level makes pino throw while the module is imported. |
| `LOCAL_STORAGE_DIR` | `src/lib/localObjectStore.ts` | No | `<cwd>/.local-storage` | Not in `.env.example`. Only used outside production. Wrong directory: files land somewhere unexpected, or uploads fail if the path is not writable. |
| `STORAGE_ENDPOINT` | `src/lib/localObjectStore.ts` | No | `http://localhost:<PORT>/local-storage` | Not in `.env.example`. Base URL baked into local presigned URLs. Wrong value: URLs issued in dev point at an address the client cannot reach. |

### Limits, GC and timing

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `MAX_PAYLOAD_SIZE` | `src/services/rateLimit.ts` | No | `16384` bytes | Largest serialised socket payload accepted. Zero, negative or non-numeric falls back to the default. Too small: legitimate fan-outs are rejected. |
| `MAX_ENVELOPE_SIZE` | `src/services/rateLimit.ts` | No | `4096` bytes | Per-envelope ciphertext cap, on top of the aggregate payload cap. Too small: messages with large attachments are rejected. |
| `FIRST_CONTACT_HOUR_LIMIT` | `src/services/rateLimit.ts` | No | `5` per hour | New-DM starts per user per hour. A non-numeric value parses to `NaN` and the comparison silently never trips (`NaN` is not less than a limit), so the limit effectively disappears. |
| `GROUP_INVITE_HOUR_LIMIT` | `src/services/rateLimit.ts` | No | `10` per hour | Group members added per user per hour. Same `NaN` behaviour as above. |
| `REPLAY_PROTECTION_TTL_SECONDS` | `src/services/replay-protection.service.ts` | No | `300` | How long a socket `eventId` is remembered. Only values between 1 and 86400 are accepted; anything else silently falls back to 300, so a too-large value does not take effect at all. Too short: duplicate events are processed twice. |
| `SOCKET_EVENT_MAX_AGE_MS` | `src/socket/dispatcher.ts` | No | `300000` | Timestamp freshness window for socket envelopes. Parsed once at import time with `parseInt`, so a bad value yields `NaN` and every freshness check fails, dropping all socket events. |
| `SOCKET_EVENT_MAX_FUTURE_SKEW_MS` | `src/socket/dispatcher.ts` | No | `30000` | Tolerance for client clocks running ahead. Same `parseInt`-at-import behaviour: a bad value makes every event look invalid. |
| `SOCKET_BUFFER_THRESHOLD` | `src/services/backpressure.ts` | No | `65536` bytes | Buffered socket bytes at which the connection is force-disconnected. Zero/negative/non-numeric falls back to the default. |
| `SOCKET_SHED_THRESHOLD` | `src/services/backpressure.ts` | No | `32768` bytes | Buffered bytes at which new events stop being sent to a socket. Setting it above `SOCKET_BUFFER_THRESHOLD` makes the shed stage unreachable. |
| `ENVELOPE_TTL_SECONDS` | `src/routes/sync.ts` | No | `604800` (7 days) | Retention window used when `/sync` decides how far back to look. Parsed at import time; a non-numeric value produces `NaN` cutoffs, so the sync window breaks. |
| `SYNC_PAGE_SIZE` | `src/routes/sync.ts` | No | `50` | Maximum envelopes per `/sync` page. Same import-time parse: a bad value breaks paging. |
| `PRESENCE_OFFLINE_GRACE_MS` | `src/services/presence.ts` | No | `5000` | Delay before a `user_offline` broadcast, so a quick reconnect produces no offline/online pair. `0` is accepted and means broadcast immediately. Too large: recipients see stale "online" status. |
| `PREKEY_LOW_THRESHOLD` | `src/services/prekeyLowSignal.ts` | No | `20` | Unconsumed one-time prekeys below which a `prekeys_low` signal is emitted. Only a positive integer takes effect; anything else falls back to 20. |
| `PREKEY_CONSUMED_RETENTION_DAYS` | `src/services/deviceGc.ts` | No | `30` days | How long consumed prekeys and MLS key packages are kept before deletion. Non-numeric/zero falls back to the default. |
| `PREKEY_UNCONSUMED_MAX_AGE_DAYS` | `src/services/deviceGc.ts` | No | `90` days | How long an unclaimed one-time prekey may sit before GC. Too short: prekeys are deleted while a slow client may still need them. |
| `DEVICE_STALE_AFTER_DAYS` | `src/services/deviceGc.ts` | No | `180` days | How long a device must stay revoked before it is flagged stale (flag only, never deleted). |
| `DEVICE_GC_INTERVAL_MS` | `src/services/deviceGc.ts` | No | `3600000` (hourly) | How often the device/key GC pass runs. A value that is not a positive number falls back to the default. |
| `ENVELOPE_DELIVERED_RETENTION_DAYS` | `src/services/envelopeGc.ts` | No | `7` days | How long delivered envelopes are kept. |
| `ENVELOPE_MAX_AGE_DAYS` | `src/services/envelopeGc.ts` | No | `30` days | Ceiling for envelopes regardless of delivery state. Too short: an offline device loses its backlog before it reconnects. |
| `ENVELOPE_GC_INTERVAL_MS` | `src/services/envelopeGc.ts` | No | `1800000` (30 minutes) | How often the envelope GC pass runs. |
| `FILE_GC_INTERVAL_MS` | `src/services/fileCleanup.ts` | No | `300000` (5 minutes) | How often the file cleanup job runs. |
| `FILE_HARD_DELETE_GRACE_MS` | `src/services/fileCleanup.ts` | No | `0` | Grace period after a soft-delete before the stored object is hard-deleted. `0` means delete on the next pass; this is the one timing variable that accepts zero. |
| `PENDING_UPLOAD_TTL_MS` | `src/services/fileCleanup.ts` | No | `86400000` (24 hours) | How long an unconfirmed upload may sit before its slot is reclaimed. Too short: slow clients lose their upload slot. |

### Rate limits

Any bucket in `apps/backend/src/config/rateLimits.ts` can be overridden with
`RATE_LIMIT_<BUCKET_NAME>=<limit>[/<windowSeconds>]`. Buckets are read on every
call, not cached, so a change takes effect without a restart. A malformed value
is ignored with a warning and the built-in default stands.

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `RATE_LIMIT_GLOBAL_IP` | `src/config/rateLimits.ts` | No | 600 / 60s | Catch-all per-IP ceiling. Too low: health-check-adjacent traffic and normal browsing get throttled. |
| `RATE_LIMIT_AUTH_CHALLENGE` | same | No | 10 / 60s | Wallet challenge nonce issuance. Too low: sign-in fails under any concurrency. |
| `RATE_LIMIT_AUTH_VERIFY` | same | No | 5 / 60s | Signature verification attempts. |
| `RATE_LIMIT_DEVICE_LINK_CHALLENGE` | same | No | 10 / 60s | Device-link nonce issuance. |
| `RATE_LIMIT_DEVICE_LINK_VERIFY` | same | No | 5 / 60s | Device-link verification attempts. |
| `RATE_LIMIT_KEY_BUNDLE` | same | No | 30 / 60s | X3DH prekey bundle fetches. Too low: new conversations fail to start. |
| `RATE_LIMIT_KEY_BUNDLE_DAILY` | same | No | 200 / 86400s | Daily bundle quota; bounds one-time prekey drain. |
| `RATE_LIMIT_UPLOAD_SLOT` | same | No | 20 / 60s | Presigned upload-slot requests. |
| `RATE_LIMIT_UPLOAD_BYTES_DAILY` | same | No | 2147483648 (2 GiB) / 86400s | Daily upload volume per user, charged in bytes. |
| `RATE_LIMIT_FILE_DOWNLOAD` | same | No | 120 / 60s | Presigned download URL issuance. |
| `RATE_LIMIT_PUSH_SUBSCRIBE` | same | No | 10 / 60s | Web-push subscription registrations. |
| `RATE_LIMIT_SOCKET_DEFAULT` | same | No | 10 / 1s | Ceiling for any socket event without its own bucket. |
| `RATE_LIMIT_SOCKET_SEND_MESSAGE` | same | No | 30 / 10s | `send_message` and `send_file_message`. |
| `RATE_LIMIT_SOCKET_TYPING` | same | No | 20 / 5s | `typing_start` and `typing_stop`. |
| `RATE_LIMIT_SOCKET_ASK_ASSISTANT` | same | No | 5 / 60s | AI assistant invocations over the socket. |
| `SOCKET_RATE_LIMIT_PER_SEC` | same | No | none | Legacy alias for `RATE_LIMIT_SOCKET_DEFAULT`, honoured only when the `RATE_LIMIT_` form is unset, so existing deployments keep behaving as configured. |
| `RATE_LIMIT_DISABLED` | `src/config/rateLimits.ts` | No | unset (limits on) | Only the literal string `true` disables every limit. For local debugging and load tests only — never set it in production. |

### Messaging

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `XMTP_ENV` | nothing | No | none | Declared in `.env.example` as `dev` but no code in this repository reads it. Setting it has no effect. |

## Frontend (`apps/web`)

Next.js substitutes every `NEXT_PUBLIC_*` value at build time and inlines it into
the JavaScript shipped to browsers. Anything with that prefix is public:
it is visible to anyone who opens the bundle, it cannot be rotated without a
rebuild-and-redeploy, and it must never hold a credential. Use a server route
(the backend's `GET /push/vapid-public-key` is the working example) when a value
has to differ per deployment or stay out of the bundle.

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `src/lib/api.ts`, `src/components/chat/NewConversationModal.tsx` | No | `http://localhost:4000` in `lib/api.ts`; `http://localhost:3001` in `NewConversationModal.tsx` | Base origin for the REST client. Trailing slashes are stripped in `lib/api.ts`. Wrong origin: every REST call fails in the browser. The two files carry different localhost defaults, so a partly-configured deployment can talk to two different backends at once. |
| `NEXT_PUBLIC_SOCKET_URL` | `src/hooks/useSocket.ts`, `src/lib/socket.ts` | No | `http://localhost:3001` | Socket.IO server URL. Takes precedence over `NEXT_PUBLIC_BACKEND_URL` in `useSocket.ts`, but `lib/socket.ts` checks `NEXT_PUBLIC_BACKEND_URL` first — setting only one of the two leaves the other path on its default. Wrong value: realtime delivery fails while REST keeps working. |
| `NEXT_PUBLIC_BACKEND_URL` | same two files | No | `http://localhost:3001` | Alternative name for the same socket URL. See the row above for the precedence difference. |
| `NEXT_PUBLIC_AUTH_TOKEN` | `src/lib/auth.tsx` | No | none | Fallback auth token used when `localStorage` has no `auth_token`. It is a real bearer token inlined into a public bundle: anyone can read it and act as the token's user. Intended as a local-development shortcut only; leaving it set in a production build hands out an account. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | `src/lib/soroban.ts` | No | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint used to build and submit transfers. Wrong or unreachable: the client cannot reach the network (requests are made with `allowHttp: false`, so a plain `http://` value fails). |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `src/lib/soroban.ts` | No | Stellar `Networks.TESTNET` | Passphrase the transaction is signed for. Wrong value: transactions are signed for one network and rejected by the other — the classic symptom is a valid-looking transaction that never confirms. |
| `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT` | `src/lib/soroban.ts` | No | the literal string `REPLACE_WITH_TOKEN_TRANSFER_CONTRACT_ID` | Token-transfer contract the client calls. Left unset, the client silently builds transactions against the placeholder ID from the default — this deploys without error and fails at send time. Must match the backend's `TOKEN_TRANSFER_CONTRACT_ID`; the two are validated independently and can point at different contracts. |
| `NEXT_PUBLIC_NETWORK` | `src/components/chat/TransferCard.tsx` | No | `test` | Used only to build the Stellar Explorer link, not for signing or submission. Wrong value: the link opens the wrong network's explorer page. |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `next.config.ts` | No | empty | Re-exported into the bundle by `next.config.ts`, but no component reads it: the client fetches the key from `GET /push/vapid-public-key` at runtime so the two can never drift. Setting it currently has no effect beyond adding the value to the bundle. |

## AI service (`apps/ai_agent`)

| Variable | Read by | Required | Default | What breaks when it is wrong |
| --- | --- | --- | --- | --- |
| `OPENAI_API_KEY` | `main.py` (`_openai_client()`) | Effectively required | none | Read per request with `os.environ.get`. Unset or empty: `/chat`, `/transfers/analyse` and `/proposals/summarise` answer HTTP 500 with "OPENAI_API_KEY is not configured" instead of a result. Wrong or revoked key: the OpenAI call fails and the request errors. Secret — see the secrets table. |

## In `.env.example` but read by no code

Three names in `.env.example` are not read anywhere in `apps/`, `scripts/` or
`src/`. They are listed here so the file can be trusted as a checklist; either
the code they were meant for is not wired up, or they are left over.

| Variable | Status |
| --- | --- |
| `RPC_URL` | Superseded by `STELLAR_RPC_URL`, which is what `src/index.ts` actually reads. Note that `STELLAR_RPC_URL` is not in `.env.example` at all. |
| `PROPOSALS_CONTRACT_ID` | Not referenced by any code. |
| `XMTP_ENV` | Not referenced by any code; messaging runs over the Socket.IO gateway. |

## Notes on the edges

- `infra/docker-compose.yml` sets `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` and `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` for the containers
  it starts. Those are container-level settings, not variables the application
  reads; the MinIO pair matches the default `OBJECT_STORE_ACCESS_KEY` /
  `OBJECT_STORE_SECRET_KEY` so the local defaults only work against the bundled
  MinIO.
- `scripts/loadtest` is configured through command-line arguments, not
  environment variables.
- Names that appear only in test fixtures (`apps/backend/src/__tests__`,
  `*.spec.ts`, `apps/ai_agent/tests`) are deliberately not documented here — they
  are what the tests set to make a code path reachable, not configuration a
  deployment supplies.

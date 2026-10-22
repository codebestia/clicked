# Scripts and Makefile reference

Every runnable script and Makefile target in this repository, what it does, what it
needs to run, what it changes as a side effect, and whether CI actually invokes it.

## Contents

- [Root `Makefile`](#root-makefile)
- [`scripts/start-web.sh`](#scriptsstart-websh)
- [`scripts/audit-crypto-deps.mjs`](#scriptsaudit-crypto-depsmjs)
- [`scripts/loadtest/`](#scriptsloadtest)
- [`apps/backend/src/scripts/check-ciphertext-invariant.mjs`](#appsbackendsrcscriptscheck-ciphertext-invariantmjs)
- [`contracts/scripts/deploy_*.sh`](#contractsscriptsdeploy_sh)
- [Root `package.json` scripts and per-app equivalents](#root-packagejson-scripts-and-per-app-equivalents)

## Root `Makefile`

| Target | What it runs | Requires | Side effects | CI? |
|---|---|---|---|---|
| `dev` | `docker compose -f infra/docker-compose.yml up -d` then `pnpm dev` | Docker, pnpm, workspace deps installed | Starts Postgres + Redis containers; starts every app's dev server via Turborepo | No — local dev only |
| `migrate` | `pnpm --filter backend db:migrate` (→ `drizzle-kit migrate`) | A reachable `DATABASE_URL` | Applies pending Drizzle migrations to that database | No — see [migrations.md](../apps/backend/docs/migrations.md) for how CI/deploy actually applies migrations |
| `test` | `pnpm --filter backend test` then `cd contracts && cargo test` | Backend test deps + a Rust toolchain with `wasm32-unknown-unknown` | Runs the backend's vitest suite, then every contract's `cargo test` (all three packages, since plain `cargo test` with no `-p` runs the whole workspace) | No — CI's own workflows invoke these tool directly (`backend-ci.yml`, `contracts-ci.yml`), not through this target |
| `lint` | `pnpm lint` (→ `turbo run lint`) | Workspace deps installed | Runs every app's own `lint` script via Turborepo | No — CI invokes each app's lint directly |
| `deploy-contracts` | `bash contracts/scripts/deploy_token_transfer.sh` then `bash contracts/scripts/deploy_group_treasury.sh` | `stellar` CLI, `DEPLOYER_SECRET`, `TOKEN_CONTRACT_ID` (see each script's own prerequisites below) | Deploys and initializes two contracts to the configured network | No |

**A real gap, verified against the actual scripts**: `deploy-contracts` runs only two of
the three deploy scripts. `contracts/scripts/deploy_proposals.sh` exists, has its own
documented prerequisites and usage line, and is never called by this target — deploying
`proposals` requires running that script directly, not `make deploy-contracts`.

None of these targets are referenced by any `.github/workflows/*.yml` file (confirmed via
search) — every CI job invokes the underlying `pnpm`/`cargo`/`stellar` commands directly
rather than going through the Makefile. The Makefile is a local-development convenience
layer, not part of the CI contract.

## `scripts/start-web.sh`

```bash
cd apps/web || exit 1
pnpm run dev
```

A thin wrapper equivalent to `pnpm --filter web dev` from the repo root, or `cd apps/web
&& pnpm dev` directly. Requires pnpm and the web app's dependencies installed. No side
effects beyond starting the Next.js dev server; not invoked by CI.

## `scripts/audit-crypto-deps.mjs`

```bash
node scripts/audit-crypto-deps.mjs
```

Runs `pnpm audit --json`, then filters the results down to advisories affecting a fixed
allow-list of **crypto-relevant** packages — `ioredis`, `jsonwebtoken`, `web-push`,
`@stellar/stellar-sdk`, `drizzle-orm`, `socket.io`, `@socket.io/redis-adapter`, `redis`,
`jose` — and exits non-zero only if one of those specific packages has an advisory.
Advisories against any other dependency (the vast majority of a typical `pnpm audit`
output) do not fail the build.

**How the filter actually decides a match**, since the script's own top comment says it
catches a package "or is a dependency of" one on the list: the filter is

```js
CRYPTO_RELEVANT_PACKAGES.some((pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`))
```

— an exact name match, or a subpath-prefix match (e.g. `socket.io/lib/...` would match
`socket.io`). **This does not walk the actual dependency graph** to catch a
transitively-vulnerable package that isn't itself named with one of these prefixes — a
CVE in, say, a sub-dependency of `ioredis` that `pnpm audit` reports under its own
package name (not `ioredis/...`) would not match this filter and would not fail the
build, despite the comment's "is a dependency of" phrasing suggesting it would.

Requires: `pnpm audit` to be runnable (a `pnpm-lock.yaml` and network access, or a cached
audit database). No side effects — read-only, reports and exits.

**CI**: `.github/workflows/security-ci.yml`'s `dependency-audit` job runs this script
directly on every push to `main` and every pull request.

## `scripts/loadtest/`

Two scripts plus a committed baseline, for WebSocket gateway load/soak testing (#385):

### `seed.ts`

```bash
tsx scripts/loadtest/seed.ts --devices 200 > fixture.json
```

Creates N users (default 200), one device each, a single group conversation containing
all of them, and signs a JWT per device — writing the fixture (`conversationId` plus
each participant's `userId`/`deviceId`/`token`) to stdout as JSON. Requires a reachable
database (it writes real rows via the backend's own Drizzle client and schema) and the
backend's JWT-signing secret configured, since it calls the backend's real `signToken`.
**Side effect: inserts real users, devices, and a conversation into whatever database
`DATABASE_URL` points at** — point this at a disposable test database, not production.

### `run.ts`

```bash
tsx scripts/loadtest/run.ts --fixture fixture.json \
  --nodes http://localhost:3001,http://localhost:3002 \
  [--baseline scripts/loadtest/baseline.json] \
  [--out result.json]
```

Connects every fixture participant as a real `socket.io-client`, split across the
`--nodes` URLs so the run exercises cross-instance fan-out through the Redis adapter,
then runs three phases: fan-out latency (one sender, every other device must receive
`message_envelope`), presence churn (a fraction of devices disconnect/reconnect on an
interval), and a reconnect storm (every device disconnects and reconnects at once).
Samples peak RSS every second. Requires the backend actually running (one or more
instances at the `--nodes` URLs) and the fixture `seed.ts` produced. Prints a JSON result
with p50/p95/p99 latency, peak memory, and error counts; **exits non-zero if any
threshold in the script's `THRESHOLDS` is violated, or if `--baseline` is supplied and
this run regressed beyond the script's regression tolerance** compared to that baseline.

### `baseline.json`

A committed reference result (`deviceCount: 200`, `nodeCount: 2`, p50/p95/p99 latency,
peak RSS) that `run.ts --baseline` compares a new run against.

**CI**: `.github/workflows/loadtest-nightly.yml` runs the full `seed.ts` → `run.ts`
pipeline against two real backend instances (ports 3001/3002, sharing one Redis) on a
nightly schedule (03:00 UTC) and via manual `workflow_dispatch` — it is not a per-PR
gate, by design (per the workflow's own header comment: "this is a soak test, not a
per-PR gate"). The job always passes `--baseline scripts/loadtest/baseline.json`, so a
nightly run that regresses beyond tolerance against this committed file fails the
workflow (visible as a failed scheduled run, not as a status check on any PR).

## `apps/backend/src/scripts/check-ciphertext-invariant.mjs`

```bash
cd apps/backend && node src/scripts/check-ciphertext-invariant.mjs
```

Scans every `.ts`/`.tsx`/`.js`/`.jsx` file under `apps/backend/src` (excluding the script
itself, `src/lib/ciphertextInvariant.ts`, and any `__tests__` directory) for an
object-key pattern matching a fixed list of forbidden field names — `content`, `body`,
`plaintext`, `identityPrivateKey`/`identity_private_key`, `privateKey`/`private_key`,
`sessionKey(s)`/`session_key(s)`, `mlsSecret(s)`/`mls_secret(s)`,
`messageKey(s)`/`message_key(s)`, `ratchetState`/`ratchet_state` — appearing as an
object property key (`` `field`: `` or `'field':` or a bare identifier key followed by
`:`). Exits non-zero and lists every match if any are found.

**This script is not invoked by any CI workflow** (confirmed via search of
`.github/workflows/`). `security-ci.yml`'s `regression` job runs a *different* check
with a similar name and purpose — `pnpm test -- security.regression.test.ts`, a vitest
test, not this script — so the ciphertext-only guard CI actually enforces is the test
file, not this standalone script. Whether this script is meant to be run manually as a
stricter/complementary check, or is a superseded earlier version of the same guard, isn't
stated anywhere in the script or the workflow; it's simply not part of the enforced CI
contract today.

## `contracts/scripts/deploy_*.sh`

Three scripts, one per contract, each following the same shape (`set -euo pipefail`,
testnet-only, requiring the `stellar` CLI and `DEPLOYER_SECRET`):

| Script | Additional required env vars | Deploys |
|---|---|---|
| `deploy_token_transfer.sh` | `TOKEN_CONTRACT_ID` (the SEP-41 token to route transfers through) | `token_transfer` |
| `deploy_group_treasury.sh` | `TOKEN_CONTRACT_ID` (the SEP-41 token the treasury holds) | `group_treasury` |
| `deploy_proposals.sh` | `TREASURY_CONTRACT_ID`, `MIN_VOTES` | `proposals` |

Each reads its contract's compiled wasm from
`target/wasm32-unknown-unknown/release/<contract>.wasm` — see
[`api-deployment-invocation.md`](../contracts/docs/api-deployment-invocation.md#2-building-the-contracts-verified)
for the build step that produces it. None of these three scripts are invoked by any CI
workflow; deployment is a manual, explicit action, not something that happens as a side
effect of merging code. As noted [above](#root-makefile), the root `Makefile`'s
`deploy-contracts` target only wraps two of these three.

## Root `package.json` scripts and per-app equivalents

| Root script | What it does | Per-app equivalent |
|---|---|---|
| `dev` | `turbo run dev` — fans out to every app's own `dev` script in parallel | `apps/web`: `next dev`. `apps/backend`: `tsx watch src/index.ts`. |
| `build` | `turbo run build` | `apps/web`: `next build`. `apps/backend`: `tsc`. |
| `lint` | `turbo run lint` | `apps/web`: `eslint`. `apps/backend`: `eslint src`. |
| `format` / `format:check` | `prettier --write`/`--check` over `**/*.{ts,tsx,md,json}` repo-wide | `apps/backend` has its own narrower `format`/`format:check` (`src/**/*.ts` only); `apps/web` has no separate format script, so the root one is its only formatter entry point. |

**Root-level `devDependencies` worth knowing about**: `express`, `supertest`,
`jsonwebtoken`, and `ioredis` are declared at the repo root, not inside `apps/backend`
(which has its own copies) or `apps/web` (which has neither `express` nor `supertest` as
a real dependency at all). These root-level packages are what let the orphaned
Express-style files described in
[`known-limitations.md`](./known-limitations.md#register) (entry 6: `cacheService.js`,
`routes/conversations.js`, and their test) resolve their imports locally without
actually being part of any real, buildable app — a contributor could run `node` against
one of those files directly and have its `require`/`import` of `express` succeed, which
is part of why they're easy to mistake for live code.

## Implementation references

- `Makefile`
- `scripts/start-web.sh`, `scripts/audit-crypto-deps.mjs`, `scripts/loadtest/seed.ts`, `scripts/loadtest/run.ts`, `scripts/loadtest/baseline.json`
- `apps/backend/src/scripts/check-ciphertext-invariant.mjs`
- `contracts/scripts/deploy_token_transfer.sh`, `deploy_group_treasury.sh`, `deploy_proposals.sh`
- `.github/workflows/security-ci.yml` — the only CI workflow that invokes a script covered in this document directly
- `package.json`, `apps/web/package.json`, `apps/backend/package.json`
- [`known-limitations.md`](./known-limitations.md) — the orphaned files whose imports the root-level `express`/`supertest` devDependencies happen to satisfy

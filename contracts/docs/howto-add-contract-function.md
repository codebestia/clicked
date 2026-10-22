# How-to: add a contract function and expose it in the app

This walks the full path from a new `#[contractimpl]` function to a working UI action,
using `token_transfer` throughout because it's the one contract in this repo that
supports in-place upgrade (see [§6](#6-when-the-backend-listener-must-change) for why
that matters, and what the other two contracts require instead).

## Contents

1. [Worked example 1: a small read-only function](#1-worked-example-1-a-small-read-only-function)
2. [Worked example 2: a small state-changing function](#2-worked-example-2-a-small-state-changing-function)
3. [Write tests](#3-write-tests)
4. [Regenerate `test_snapshots/`](#4-regenerate-test_snapshots)
5. [Rebuild and redeploy](#5-rebuild-and-redeploy)
6. [When the backend listener must change](#6-when-the-backend-listener-must-change)
7. [Frontend: invoking the new function](#7-frontend-invoking-the-new-function)
8. [Checklist](#8-checklist)

## 1. Worked example 1: a small read-only function

Say you want to add a way to check how much of the configured token this contract has
been authorized to move (vs. querying the SEP-41 token directly). A read-only function
takes `&self`-equivalent access via `env` only, touches no mutable storage, and emits no
event:

```rust
// contracts/contracts/token_transfer/src/lib.rs, inside impl TokenTransferContract

/// Returns whether the contract has been initialised (admin + token set).
pub fn is_initialized(env: Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}
```

This mirrors the existing `balance` and `token_contract` functions in the same file —
read `env.storage().instance()`, return a value, no `require_auth()` needed because
nothing is being authorized, no event because no state changed.

## 2. Worked example 2: a small state-changing function

Now something that writes storage and requires authorization — say, an admin-only pause
flag:

```rust
// storage.rs
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    TokenContract,
    Paused, // new
}

// lib.rs, inside impl TokenTransferContract

/// Admin-only: pause or unpause transfers.
pub fn set_paused(env: Env, paused: bool) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized");
    admin.require_auth();
    env.storage().instance().set(&DataKey::Paused, &paused);

    env.events()
        .publish((Symbol::new(&env, "paused_changed"),), paused);
}
```

And — for the function to actually do anything — `transfer` would check it:

```rust
pub fn transfer(env: Env, from: Address, to: Address, amount: i128, memo: Bytes) {
    let paused: bool = env.storage().instance().get(&DataKey::Paused).unwrap_or(false);
    if paused {
        panic!("transfers are paused");
    }
    // ...existing logic unchanged
}
```

This follows the exact pattern `set_token_contract` already uses in the same file:
load the admin, `require_auth()`, write storage. The event is new here, not present on
`set_token_contract` — added because, unlike a config value nobody off-chain currently
reads, a pause toggle is exactly the kind of state change a backend consumer plausibly
wants to react to. Whether to add one is a judgment call per function, not a rule; see
[`contracts-events.md`](./contracts-events.md) for every event this codebase currently
emits and why each one exists.

## 3. Write tests

Add a test in the same contract's `src/test.rs`, following the existing tests for
`transfer`/`set_token_contract` in that file for the mock-auth and test-environment
setup pattern already in use. At minimum, mirror the existing coverage style:

- the happy path (the flag/value is actually read back correctly after being set)
- the `require_auth()` gate (a non-admin caller's attempt panics or is rejected)
- for `set_paused` specifically: that `transfer` actually panics while paused, and
  succeeds again once unpaused

See [`contracts/docs/testing.md`](./testing.md) for the full testing guide — the
mock-auth helpers, how `Env::default()` test environments are constructed, and the
in-repo conventions this codebase's existing contract tests already follow.

## 4. Regenerate `test_snapshots/`

Run the contract's tests:

```bash
cd contracts
cargo test -p token_transfer
```

This both runs your new test and regenerates
`contracts/contracts/token_transfer/test_snapshots/` to reflect the new storage key
(`DataKey::Paused`) and the new event. **Do not hand-edit anything under
`test_snapshots/`** — see
[`testing.md`'s `test_snapshots/` section](./testing.md#the-test_snapshots-directory) for
why these files are generated-but-committed, and why an unexpected diff in one during
review is a signal to look closer, not noise to dismiss.

**The CI check that fails if this is forgotten** is simply `cargo test`'s own pass/fail:
`.github/workflows/contracts-ci.yml` runs `cargo test -p ${{ matrix.package }}` for each
contract. Soroban's test harness itself detects a storage-footprint mismatch against the
committed snapshot and fails the test if the snapshot wasn't regenerated to match new
behavior — there's no separate "check the snapshot is fresh" CI step beyond the test
suite catching it directly. If you add a function but never run `cargo test` locally and
never commit the updated snapshot, CI fails on this contract's test job, not silently.

## 5. Rebuild and redeploy

Build the wasm for this contract (same command CI and the deploy scripts use — see
[`api-deployment-invocation.md`](./api-deployment-invocation.md#2-building-the-contracts-verified)
for the full build reference):

```bash
cargo build -p token_transfer --target wasm32-unknown-unknown --release
```

**This is where `token_transfer` and the other two contracts diverge, and it matters
which one you're changing.** `token_transfer` exposes `upgrade(env, new_wasm_hash)` —
the only in-place upgrade path in this codebase. `group_treasury` and `proposals` expose
no such entrypoint; changing their behavior means deploying an entirely new contract
instance and repointing every consumer at the new contract ID. See
[`concepts-upgrades.md`](./concepts-upgrades.md) for the full mechanism, authorization
model, and the storage-layout compatibility rules an in-place upgrade must respect (you
cannot, for example, repurpose an existing `DataKey` variant's meaning across an
upgrade — only add new ones, as the `Paused` variant above does).

For `token_transfer`, upgrading an already-deployed instance:

1. Install the new wasm to get its hash:
   ```bash
   stellar contract install --wasm target/wasm32-unknown-unknown/release/token_transfer.wasm \
     --network testnet --source <ADMIN_IDENTITY>
   ```
2. Invoke `upgrade` on the existing contract ID with that hash, authorized as the
   contract's admin (the same admin `set_token_contract` and the new `set_paused` above
   both gate on):
   ```bash
   stellar contract invoke --id <EXISTING_CONTRACT_ID> --network testnet \
     --source <ADMIN_IDENTITY> -- upgrade --new_wasm_hash <HASH_FROM_STEP_1>
   ```

The contract ID does not change — every existing reference to it (backend `.env`,
frontend `NEXT_PUBLIC_TOKEN_TRANSFER_CONTRACT`) keeps working against the same address
with the new code live.

## 6. When the backend listener must change

Only relevant if your new function emits an event (`env.events().publish(...)`) that the
backend should react to — a read-only function or a state change nobody off-chain needs
to know about (like `set_token_contract`, which emits nothing) needs no listener change.

`apps/backend/src/services/stellarListener.ts` (#331) polls Soroban RPC `getEvents`
filtered to specific contract IDs and **specific topic strings** — for `token_transfer`,
that filter is currently `topics: [['transfer']]`, matching the contract's
`Symbol::new(&env, "transfer")`. A new event under a different topic, like the
`paused_changed` example above, is invisible to the listener until its topic filter and
decode logic are extended to include it — the listener does not subscribe to "every
event this contract emits," only the ones it's been told to look for.

Adding support means:

1. Add the new topic string to the relevant `topics` filter array in
   `stellarListener.ts`.
2. Add a decode branch for the new event's payload shape (mirroring how the existing
   `transfer` event is decoded into a `StellarTransferEvent`).
3. Decide what the backend does with it — a database write, a WebSocket push to
   affected users, both, or (if it's purely informational) nothing beyond logging.

See [`contracts-events.md`](./contracts-events.md) for the full table of every event
currently emitted across all three contracts and whether each one is actually consumed
by the listener today — several are not, which is itself documented there as a known
gap rather than an oversight to silently "fix" by wiring one up as a side effect of an
unrelated change.

## 7. Frontend: invoking the new function

`apps/web/src/lib/soroban.ts`'s `transferToken` is the existing pattern for a
state-changing call from the browser via Freighter. A new function follows the same
five-step shape:

1. **Build the operation** — `contract.call('<function_name>', ...scValArgs)`, with each
   argument converted via `nativeToScVal` to the matching Soroban type (`i128` for a
   signed 128-bit int, `address` for an `Address`, etc. — match the Rust function
   signature's parameter types exactly, or the call fails at simulation).
2. **Simulate** — `server.simulateTransaction(tx)`, and check
   `SorobanRpc.Api.isSimulationError(simResult)` before proceeding. This is also how you
   discover a read-only function's return value without spending a signature: for
   `is_initialized` above, simulation alone is enough — skip steps 3–5 entirely for a
   read-only call, since there's nothing to sign or submit.
3. **Sign** — `freighter.signTransaction(txXdr, { networkPassphrase })`, after
   `SorobanRpc.assembleTransaction(tx, simResult).build()` incorporates the simulation's
   resource footprint into the transaction.
4. **Submit** — `server.sendTransaction(signedTx)`.
5. **Poll for confirmation** — `server.getTransaction(hash)` in a loop until `SUCCESS` or
   `FAILED`, exactly as `transferToken`'s existing 30-iteration/2-second poll loop does.

For `set_paused`, the only differences from `transferToken` are the function name
(`'set_paused'`) and argument list (a single boolean argument converted via
`nativeToScVal`, instead of the four transfer arguments — check the `stellar-sdk`
version pinned in `apps/web/package.json` for its exact boolean type-hint string, since
this helper's API has shifted across SDK versions) — everything else, including which
identity signs (the
connected Freighter wallet must be the contract's admin, or `require_auth()` on-chain
rejects the call after it's already been submitted and the user has already seen a
signing prompt), is the same shape.

## 8. Checklist

- [ ] Function added to the contract's `lib.rs`, with `require_auth()` if it changes
      state restricted to a specific caller
- [ ] New `DataKey` variant added (never repurpose an existing variant's meaning if the
      contract is upgradeable — see [§5](#5-rebuild-and-redeploy))
- [ ] Event added, if off-chain systems need to react to this change
- [ ] Tests added in `src/test.rs`: happy path, auth gate, and (if applicable) the
      behavior the new state actually gates
- [ ] `cargo test -p <contract>` run locally, `test_snapshots/` diff reviewed and
      committed
- [ ] Wasm rebuilt and, for `token_transfer`, upgraded in place via `upgrade`; for
      `group_treasury`/`proposals`, a new instance deployed and every consumer repointed
- [ ] If a new event topic was added: `stellarListener.ts`'s topic filter and decode
      logic updated, and `contracts-events.md`'s table updated to reflect it
- [ ] Frontend call site added in `apps/web/src/lib/soroban.ts` (or a new function
      following the same pattern), and the UI action that triggers it wired up

## References

- `contracts/contracts/token_transfer/src/lib.rs` — the contract this guide is worked against
- [`contracts/docs/testing.md`](./testing.md) — test conventions and the `test_snapshots/` directory
- [`contracts/docs/concepts-upgrades.md`](./concepts-upgrades.md) — the upgrade mechanism, authorization, and storage-compatibility rules
- [`contracts/docs/api-deployment-invocation.md`](./api-deployment-invocation.md) — build, deploy, and invoke reference for all three contracts
- [`contracts/docs/contracts-events.md`](./contracts-events.md) — every event emitted, topic, payload, and listener-consumption status (#351)
- `apps/backend/src/services/stellarListener.ts` — the backend's chain listener (#331)
- `apps/web/src/lib/soroban.ts` — the frontend's Freighter + Soroban RPC helper

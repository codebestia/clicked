# Proposals Contract — Storage Layout and Treasury Interface

## Overview

The `proposals` contract stores all of its state under four `DataKey` variants,
every one of them in Soroban **instance** storage. This document covers the
`DataKey` enum, the `Proposal` struct, the `ProposalStatus` enum and the
transitions the contract code actually permits, how votes are recorded, the
event structs that live in `storage.rs`, and the typed client the contract uses
to call into `group_treasury`.

Files covered:

- `contracts/contracts/proposals/src/storage.rs` — keys, data structures, event payloads
- `contracts/contracts/proposals/src/treasury_interface.rs` — the treasury interface trait
- `contracts/contracts/proposals/src/treasury_interface_client.rs` — a placeholder file (see [Treasury Cross-Contract Client](#treasury-cross-contract-client))
- `contracts/contracts/proposals/src/lib.rs` — the only code that reads and writes the keys

For the behavioural side (who may vote, when, and why `finalize_proposal`
panics) see `concepts-proposal-lifecycle.md` and `api-proposals.md`; this
document is about what is persisted and how.

## Storage Keys

| Key Name                  | Storage Type | Value Type             | Description                                                                        |
| ------------------------- | ------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `DataKey::Admin`          | Instance     | `Address`              | Reserved admin slot, written once in `initialize`                                   |
| `DataKey::NextProposalId` | Instance     | `u64`                  | Monotonic id counter; also the id handed to the next created proposal               |
| `DataKey::Proposal(u64)`  | Instance     | `Proposal`             | The proposal record, keyed by proposal id                                           |
| `DataKey::Vote(u64, Address)` | Instance     | `bool`             | One entry per `(proposal_id, voter)`; `true` = yes vote, `false` = no vote          |

The enum is declared at `storage.rs:3-9`:

```rust
#[contracttype]
pub enum DataKey {
    Admin,
    NextProposalId,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) -> bool (true = yes, false = no)
}
```

`DataKey` is annotated with `#[contracttype]`, so the variants are encoded as a
`ScVal` vector whose first element is the variant symbol and whose remaining
elements are the variant's own fields. The snapshots confirm this shape: the
`Vote` key literally serialises as `{'vec': [{'symbol': 'Vote'}, {'u64': 0},
{'address': 'C…'}]}` (`test_snapshots/test/create_then_vote_then_pass_then_execute_happy_path.1.json`).
Two consequences worth knowing:

- `Proposal` and `Vote` are keyed by **separate** variants, so `DataKey::Proposal(0)`
  and `DataKey::Vote(0, addr)` never collide even though they share an id.
- `DataKey::Vote(u64, Address)` means each voter costs one storage entry per
  proposal, and the `Address` is part of the ledger key (encoded as a 32- or
  40-byte strkey ScVal, not a hash), so vote entries are larger than a single
  boolean would suggest.

Where each key is written:

| Key                        | Written by                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `DataKey::Admin`           | `initialize` (`lib.rs:46`), guarded by `has` check at `lib.rs:42` |
| `DataKey::NextProposalId`  | Initialised to `0u64` in `initialize` (`lib.rs:47-49`), incremented in `create_proposal` (`lib.rs:96-98`) |
| `DataKey::Proposal(id)`    | `create_proposal` (`lib.rs:93-95`), `vote` (`lib.rs:140-142`), `finalize_proposal` (`lib.rs:176-178`), `finalize_expired_proposal` (`lib.rs:204-206`), `execute_proposal` (`lib.rs:225-227`), `execute_withdraw` (`lib.rs:280-282`) |
| `DataKey::Vote(id, voter)` | `vote` (`lib.rs:133`), preceded by a duplicate check at `lib.rs:130-132` |

Reads: `initialize` reads `Admin` via `has` (`lib.rs:42`); `create_proposal`
reads `NextProposalId` with `unwrap_or(0)` (`lib.rs:73-77`); `vote` reads
`Vote(id, voter)` via `has` (`lib.rs:130`) and `Proposal(id)` via
`load_proposal` (`lib.rs:298-303`); every other entry point goes through
`load_proposal`, which uses `.expect("proposal not found")` — a missing
proposal panics rather than returning `None`.

Note that `initialize` sets `NextProposalId` unconditionally after the guard,
and `create_proposal` does **not** check that `initialize` was ever called: an
uninitialised contract still hands out ids starting from `0`, because
`unwrap_or(0)` swallows the missing counter.

## Storage Types Used

The contract code uses **only instance storage**. Every storage access in
`lib.rs` is `env.storage().instance()` — there is no `persistent()` or
`temporary()` call anywhere in `contracts/contracts/proposals/src/lib.rs`
(verified by `grep -rn "storage()" contracts/contracts/proposals/src/`).

- **Instance storage** (`env.storage().instance()`) holds the whole contract
  state: admin, id counter, proposals and votes. It is scoped to the contract
  instance and is loaded with every invocation of the contract, which is why
  `vote` can write the same `Proposal(id)` entry that `finalize_proposal`
  later rewrites.
- **Persistent storage** (`env.storage().persistent()`) is not used by this
  contract. It appears only in the test module's `mock_token` contract
  (`test.rs:28-53`, `mock_token::Key::Balance(Address)`), which is a test
  fixture, not part of the proposals contract.
- **Temporary storage** (`env.storage().temporary()`) is not used at all.

Putting proposals and votes in instance storage has a direct consequence: the
entire proposal and vote history of the contract sits in a single ledger entry
whose size grows without bound, and every call reads it. There is no pruning of
`Vote` entries (nothing in the code ever removes one) and no way to expire an
individual proposal record.

## The `Proposal` Data Structure

Declared at `storage.rs:22-39`:

```rust
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub status: ProposalStatus,

    // Withdrawal execution parameters.
    pub treasury: Address,
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}
```

| Field         | Type             | Meaning                                                                 | Set where |
| ------------- | ---------------- | ----------------------------------------------------------------------- | --------- |
| `id`          | `u64`            | Proposal id, equal to the `id` component of its `DataKey::Proposal` key | `lib.rs:79` |
| `proposer`    | `Address`        | Creator, authenticated in `create_proposal`                              | `lib.rs:80` |
| `description` | `String`         | Free-form text from the caller                                           | `lib.rs:81` |
| `created_at`  | `u64`            | `env.ledger().timestamp()` at creation                                   | `lib.rs:82` |
| `expires_at`  | `u64`            | Voting deadline; must be `> now` at creation (`lib.rs:66-68`)            | `lib.rs:83` |
| `yes_votes`   | `u32`            | Count of `support == true` votes                                         | `lib.rs:84`, incremented `lib.rs:136` |
| `no_votes`    | `u32`            | Count of `support == false` votes                                        | `lib.rs:85`, incremented `lib.rs:138` |
| `status`      | `ProposalStatus` | Current lifecycle state (see below)                                      | see transition table |
| `treasury`    | `Address`        | The `group_treasury` contract to withdraw from                           | `lib.rs:87` |
| `token`       | `Address`        | SEP-41 token contract to withdraw                                        | `lib.rs:88` |
| `to`          | `Address`        | Withdrawal recipient                                                     | `lib.rs:89` |
| `amount`      | `i128`           | Withdrawal amount; must be `> 0` at creation (`lib.rs:69-71`)            | `lib.rs:90` |

`Proposal` derives `Clone` only — not `Debug` or `PartialEq`, unlike
`ProposalStatus` (`storage.rs:12`). That is why the tests compare
`proposal.status` (`test.rs:172`, `test.rs:348`) rather than whole `Proposal`
values.

The vote counts are `u32` while `amount` is `i128`; there is no overflow guard on
`yes_votes += 1` / `no_votes += 1` (`lib.rs:135-139`), although the release
profile sets `overflow-checks = true` (`contracts/Cargo.toml`), so an overflow
would trap rather than wrap.

## `ProposalStatus` and Permitted Transitions

All six variants, declared at `storage.rs:11-20`:

| Status     | Meaning                                                                            | Reachable? |
| ---------- | ---------------------------------------------------------------------------------- | ---------- |
| `Active`   | Voting open. The only status assigned at creation.                                  | Yes — `lib.rs:86` |
| `Approved` | No code path assigns it. Declared in the enum, referenced only in doc comments and panic strings. | **No — dead variant** |
| `Passed`   | Voting closed, `yes_votes > no_votes`. Executable.                                  | Yes — `lib.rs:171` |
| `Rejected` | Voting closed, `yes_votes <= no_votes` (ties and zero votes included).              | Yes — `lib.rs:173` |
| `Executed` | Funds withdrawn, or the MVP execution marker set.                                   | Yes — `lib.rs:224`, `lib.rs:279` |
| `Expired`  | Voting closed via `finalize_expired_proposal`. No execution path out.               | Yes — `lib.rs:203` |

The transitions the code allows, all evidenced in `lib.rs`:

| From       | To         | Trigger  | Guards in code                                                                                 | Test that pins it |
| ---------- | ---------- | -------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| —          | `Active`   | `create_proposal` | `expires_at > now` (`lib.rs:66`), `amount > 0` (`lib.rs:69`)              | `create_then_vote_then_pass_then_execute_happy_path` |
| `Active`   | `Passed`   | `finalize_proposal` | `status == Active` (`lib.rs:162`), `now >= expires_at` (`lib.rs:166`), `yes_votes > no_votes` (`lib.rs:170`) | `create_then_vote_then_pass_then_execute_happy_path` |
| `Active`   | `Rejected` | `finalize_proposal` | same guards, `yes_votes <= no_votes` (`lib.rs:173`)                        | `finalize_with_more_no_votes_rejects`, `finalize_with_a_tie_rejects`, `finalize_with_zero_votes_rejects` |
| `Active`   | `Expired`  | `finalize_expired_proposal` | `status == Active` (`lib.rs:195`), `now > expires_at` (`lib.rs:199`) | `finalize_expired_success` |
| `Passed`   | `Executed` | `execute_proposal` | `status == Passed` (`lib.rs:221`)                                          | `create_then_vote_then_pass_then_execute_happy_path` |
| `Passed`   | `Executed` | `execute_withdraw` | not `Executed` (`lib.rs:250`), `status == Passed` (`lib.rs:253`), treasury member (`lib.rs:261`), balance `>= amount` (`lib.rs:267`), treasury `withdraw` succeeds (`lib.rs:272`) | `execute_withdraw_reduces_balance` |

Everything else is refused, and the refusals are tested:

- `Active` → `Passed`/`Rejected` before expiry panics `"cannot finalize before expiry"` (`lib.rs:166-168`, test `finalize_before_expiry_panics`).
- Re-finalising a non-`Active` proposal panics `"proposal already finalized"` (`lib.rs:162-164`, test `finalize_twice_panics`). So `Passed`, `Rejected`, `Expired` and `Executed` are all terminal against `finalize_proposal`.
- `finalize_expired_proposal` on anything not `Active` panics `"proposal not Pending"` (`lib.rs:195-197`, test `finalize_expired_when_passed_panics`); on an `Active` proposal that is not yet past expiry it panics `"proposal not expired"` (`lib.rs:199-201`, test `finalize_expired_before_expiry_panics`).
- `execute_proposal` on a non-`Passed` proposal panics `"proposal is not in Passed state"` (`lib.rs:221-223`, tests `execute_when_rejected_panics`, `execute_when_still_active_panics`). `Rejected`, `Expired` and `Executed` therefore cannot reach `Executed` through this path.
- `execute_withdraw` on an `Executed` proposal panics `"proposal already executed"` (`lib.rs:250-252`, test `execute_withdraw_already_executed_panics`); on anything not `Passed` it panics `"proposal not approved"` (`lib.rs:253-255`, test `execute_withdraw_pending_panics`).
- Voting is only accepted in `Active` (`lib.rs:121-123`) and before `expires_at` (`lib.rs:125-127`, tests `vote_after_expiry_panics`, `double_vote_panics`).

Two boundary details the code is explicit about, and worth documenting because
they are asymmetric:

- `finalize_proposal` accepts `now == expires_at` (`now < expires_at` is the
  panic condition, `lib.rs:166`), so the last-second call at exactly the
  deadline succeeds.
- `finalize_expired_proposal` requires `now > expires_at` (`now <= expires_at`
  panics, `lib.rs:199`), so at exactly the deadline it refuses.

At `now == expires_at` both `finalize_proposal` and `finalize_expired_proposal`
are possible inputs, but only the former succeeds: the two expiry paths overlap
on the boundary and `finalize_proposal` wins it.

`Approved` is ambiguous: `lib.rs:237-244` documents `execute_withdraw` as
requiring "proposal must be Approved", the panic string at `lib.rs:254` says
`"proposal not approved"`, yet the check at `lib.rs:253` compares against
`ProposalStatus::Passed`, and `test.rs:430-433` acknowledges the mismatch
outright ("This repo currently uses ProposalStatus::Passed/Rejected for
finalize; Approved is separate"). The code never assigns `Approved`; treat the
word "approved" in those strings as a synonym for `Passed`, not as a state.

## Vote Tracking

Votes are stored twice, deliberately:

1. **Per-voter record** — `DataKey::Vote(proposal_id, voter) -> bool`
   (`storage.rs:8`). Written once per `(proposal, voter)` in `vote`
   (`lib.rs:129-133`). The key is built from the `voter` argument
   (`lib.rs:129`), and the existence check at `lib.rs:130-132` turns a second
   vote into a panic `"voter has already voted"` (test `double_vote_panics`).
   This is the double-vote guard: the ledger entry's presence *is* the
   "already voted" flag, and the stored value is the direction.
2. **Aggregate counters** — `Proposal.yes_votes` / `Proposal.no_votes`
   (`u32`), incremented in the same call (`lib.rs:135-139`) and re-persisted
   with the rest of the proposal (`lib.rs:140-142`). `finalize_proposal` reads
   only these counters (`lib.rs:170-174`) — it never iterates the `Vote` entries,
   so tallying is O(1) and total weight is exactly one vote per address.

Properties that follow from the code, with no test needed:

- Votes are **unweighted** — there is no balance check, no delegation, and no
  abstain option; `support` is a plain `bool`.
- Votes are **not removable**: nothing deletes a `Vote` key, and votes cast
  while the proposal was `Active` stay in storage after it becomes `Passed`,
  `Rejected`, `Expired` or `Executed`.
- Because the voter's `Address` is part of the key, vote entries are per-address
  and there is no per-proposal index of voters, so "who voted on proposal N" can
  only be answered by the emitted events (`vote_cast`, `lib.rs:144-151`), not by
  reading storage.
- `yes_votes + no_votes` equals the number of `Vote` entries for that proposal
  by construction — both are written in the same call and neither is ever
  decremented.

## Events defined in `storage.rs`

These structs are `#[contracttype]` data structures used as event payloads, not
storage keys — none of them appears in `DataKey`.

| Struct                     | Line(s)      | Fields                                                            | Published as |
| -------------------------- | ------------ | ----------------------------------------------------------------- | ------------ |
| `ProposalCreatedEvent`     | `storage.rs:43-54` | `id: u64`, `proposer: Address`, `expires_at: u64`, `treasury: Address`, `token: Address`, `to: Address`, `amount: i128` | `Symbol::new(&env, "proposal_created")` (`lib.rs:100-111`) |
| `VoteCastEvent`            | `storage.rs:56-62` | `id: u64`, `voter: Address`, `support: bool`              | `Symbol::new(&env, "vote_cast")` (`lib.rs:144-151`) |
| `ProposalFinalizedEvent`   | `storage.rs:64-71` | `id: u64`, `status: ProposalStatus`, `yes_votes: u32`, `no_votes: u32` | `Symbol::new(&env, "proposal_finalized")` (`lib.rs:180-188`) |
| `ProposalExpiredEvent`     | `storage.rs:73-77` | `id: u64`                                                  | `Symbol::new(&env, "proposal_expired")` (`lib.rs:208-211`) |
| `ProposalExecutedEvent`    | `storage.rs:79-84` | `id: u64`, `executor: Address`                             | `symbol_short!("executed")` (`lib.rs:229`) — but `symbol_short!("execut")` from `execute_withdraw` (`lib.rs:286`) |

The last row is a live inconsistency: two code paths emit the same event struct
under two different topic symbols, `"executed"` and `"execut"`. An indexer that
filters on one will miss the other. `VoteCastEvent` deliberately does not carry
a timestamp or running tally, so off-chain consumers must recompute totals from
`proposal_finalized`.

## Treasury Cross-Contract Client

### `treasury_interface.rs`

The treasury interface is a Soroban client trait, `treasury_interface.rs:4-9`:

```rust
/// Minimal interface for calling the group treasury contract.
#[contractclient(name = "TreasuryClient")]
pub trait TreasuryInterface {
    fn is_member(env: Env, member: Address) -> bool;
    fn balance(env: Env, token: Address) -> i128;
    fn withdraw(env: Env, to: Address, token: Address, amount: i128);
}
```

`#[contractclient]` is the SDK's "generate a client for someone else's contract
from a shared trait" macro; the `name = "TreasuryClient"` argument is what makes
the generated type importable as `TreasuryClient`. In the hand-written code the
name is used unqualified — `crate::treasury_interface::TreasuryClient::new(&env,
&proposal.treasury)` (`lib.rs:258-259`). Note the module is declared as
`mod treasury_interface;` (`lib.rs:22`), not `pub mod`, so the client type is
private to the crate.

### `treasury_interface_client.rs`

This file is **one line and does nothing**:

```rust
// Intentionally left empty - this file was generated automatically.
```

It is not declared in the module tree — `lib.rs:19-22` declares `mod storage;`,
`mod test;` and `mod treasury_interface;` and nothing else — so it is not
compiled and contains no code to document. The typed cross-contract client is
produced by the `#[contractclient(name = "TreasuryClient")]` attribute on the
trait in `treasury_interface.rs`, not by this file. Anything in the repository
that refers to a "treasury interface client" is referring to that macro-generated
type.

### How the contract ID is resolved and invoked

The resolution is *not* dynamic lookup by name or environment variable. The
contract ID is a value carried in storage:

1. `create_proposal` takes `treasury: Address` as an argument and stores it in
   `Proposal.treasury` (`lib.rs:59`, `lib.rs:87`). It is validated for nothing —
   any address is accepted.
2. `execute_withdraw` loads the proposal (`lib.rs:248`), then constructs the
   client with that stored address:
   `TreasuryClient::new(&env, &proposal.treasury)` (`lib.rs:258-259`).
3. The generated client's constructor (`pub struct TreasuryClient<'a> { env, address, .. }`,
   `pub fn new(env: &Env, address: &Address)`) simply clones the address into the
   struct — see `soroban-sdk-macros-22.0.11/src/derive_client.rs`, `derive_client_type`.
   There is no resolution step to perform: passing the address *is* the
   resolution, and each trait method is compiled into a host cross-contract call
   to that address with the method symbol as the function name.
4. Three calls are then made against the client, in this order, and none of the
   results is optional:

| Call                              | Line(s)               | Result used for                                                  |
| --------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `is_member(&caller)`              | `lib.rs:261-263`      | Access control: `false` → panic `"caller is not a treasury member"` |
| `balance(&proposal.token)`        | `lib.rs:266-269`      | Pre-check: `bal < proposal.amount` → panic `"insufficient funds"` |
| `withdraw(&to, &token, &amount)`  | `lib.rs:272-276`      | The actual transfer                                              |

The address argument types line up with the `group_treasury` implementation:
`is_member` at `group_treasury/src/lib.rs:126`, `balance` at
`group_treasury/src/lib.rs:205`, `withdraw` at `group_treasury/src/lib.rs:175`.
All three take `(env: Env, ...)` with no `#[contractimpl]`-level renaming, so the
on-chain symbols match the trait method names.

Authority: the proposals contract calls `treasury.withdraw` as a **nested**
(non-root) invocation, and `withdraw` calls `require_admin(&env)`
(`group_treasury/src/lib.rs:180`), which requires the *treasury admin's*
authorisation rather than the caller's. This is called out in the test setup
comment at `test.rs:78-81`, which is why the tests use
`env.mock_all_auths_allowing_non_root_auth()`. A real invocation therefore needs
the treasury admin's authorisation to be part of the authorisation tree that the
root call builds — the proposals contract cannot manufacture it on its own.

Client-side signature drift is invisible to the compiler here: `TreasuryClient`
is generated from the local trait, so if `group_treasury` ever changed a
signature the proposals crate would still compile and only fail at run time with
a host-level invocation error. Only the `execute_withdraw_*` tests (which
register the real `group_treasury` as a dev-dependency,
`contracts/contracts/proposals/Cargo.toml`) would catch that.

## TTL and Bump Behaviour

There is **no TTL management in this contract, and none anywhere in the
workspace**. Concretely:

- `grep -rn "extend_ttl\|bump" contracts/contracts/proposals/src/` returns no
  matches (exit status 1).
- The same grep across the whole `contracts/` tree returns no matches either:
  `grep -rn "extend_ttl" contracts/contracts/` → no matches;
  `grep -rn "bump" contracts/contracts/` → no matches.

So there is no `extend_ttl`, no `extend_ttl_threshold`/`extend_ttl_to` pair, no
`bump`, and no threshold/extension constants to document. No constant for TTL
exists in `storage.rs`; `storage.rs` contains only the `#[contracttype]`
declarations shown above.

What the ledger actually looks like is visible in the committed test snapshots.
In `test_snapshots/test/create_then_vote_then_pass_then_execute_happy_path.1.json`
the contract's instance entry (`ledger_key_contract_instance`) for the proposals
contract carries `live_until_ledger_seq = 4095` at `sequence_number = 0`, and the
snapshot's ledger config records the test environment's defaults:

```
min_persistent_entry_ttl: 4096
min_temp_entry_ttl:       16
max_entry_ttl:            6312000
```

Two things follow, and both are properties of the Soroban host rather than of
this repository:

- Because `DataKey::Proposal` and `DataKey::Vote` live in **instance** storage,
  they are stored inside the single contract-instance ledger entry. In XDR that
  entry is encoded with durability `persistent` under the
  `ledger_key_contract_instance` key (visible in the snapshot above), even though
  the SDK API used by the code is `env.storage().instance()`. The two are not in
  conflict: instance storage is a persistent-durability entry reached through a
  dedicated API.
- That entry's TTL is bumped by the host when the contract is invoked; the
  `4095` value is the host's default minimum in the test environment. This
  contract does not extend or configure it.

The practical gap: relying on the host's default instance TTL means the
proposal-and-vote archive is only guaranteed to live as long as whatever the
network's default is. Since all state is in one entry and that entry cannot be
grown selectively, there is no way for this contract to give vote history a
longer life than the contract instance itself. If durability beyond the default
is required, an `extend_ttl` policy has to be added — nothing in the current
code does it, and the test suite does not test it (no test touches TTL APIs;
the timing tests only move `env.ledger().set_timestamp`, `test.rs:60-63`).

## Known Gaps and Ambiguities

Gaps that the source plainly shows:

- **`ProposalStatus::Approved` is unreachable.** Declared at `storage.rs:15`,
  never assigned; see the discussion above. The doc comment at `lib.rs:241` and
  panic string at `lib.rs:254` still use the word.
- **Two topic symbols for one event.** `"executed"` (`lib.rs:229`) vs
  `"execut"` (`lib.rs:286`); `symbol_short!` silently accepts both, so there is
  no compiler warning.
- **`treasury_interface_client.rs` is dead weight.** An empty, uncompiled,
  auto-generated-looking file in a crate whose client actually comes from a
  macro. Deleting it would change nothing functionally, but that is a source
  change and out of scope here.
- **No typed errors.** Every failure is a `panic!` with a string message
  (`"proposal not found"`, `"proposal not approved"`, …); there is no `error.rs`
  and no `#[contracterror]`, so callers cannot match on error codes.
- **No storage-level validation of the treasury address.** `create_proposal`
  accepts any `Address` for `treasury` (`lib.rs:59`, `lib.rs:87`); the failure
  surfaces only later, when `execute_withdraw` invokes it.
- **`Vote` entries are permanent.** No deletion path exists; on a busy contract
  the instance entry grows monotonically.
- **Unguarded counter increments.** `yes_votes += 1` / `no_votes += 1`
  (`lib.rs:136`, `lib.rs:138`) have no checked arithmetic; the workspace release
  profile enables `overflow-checks`, so this traps rather than wraps, but it is
  not handled deliberately.
- **No re-entrancy consideration for the nested call.**
  `execute_withdraw` sets `status = Executed` *after* the treasury `withdraw`
  returns (`lib.rs:272-279`). Within one transaction that is fine, because a
  panic reverts, but the ordering means a treasury that re-entered `vote` or
  `finalize_proposal` on the proposals contract would observe the still-`Passed`
  status.

Where the intent is genuinely ambiguous rather than absent, it is called out
inline above (the `Approved`/`Passed` wording, and the `now == expires_at`
boundary where the two finalisation functions disagree).

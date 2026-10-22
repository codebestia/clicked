# `proposals` Storage Layout & Treasury Client

Source: [`contracts/contracts/proposals/src/storage.rs`](../contracts/proposals/src/storage.rs),
[`contracts/contracts/proposals/src/treasury_interface.rs`](../contracts/proposals/src/treasury_interface.rs),
[`contracts/contracts/proposals/src/treasury_interface_client.rs`](../contracts/proposals/src/treasury_interface_client.rs),
[`contracts/contracts/proposals/src/lib.rs`](../contracts/proposals/src/lib.rs).

For function signatures see [`api-proposals.md`](api-proposals.md); for the lifecycle narrative
see [`concepts-proposal-lifecycle.md`](concepts-proposal-lifecycle.md). For how this contract's
withdrawal path relates to the treasury's own multisig, see
[`concepts-cross-contract-interfaces.md`](concepts-cross-contract-interfaces.md). The sibling
document for the treasury is [`contracts-group-treasury-storage.md`](contracts-group-treasury-storage.md).

## Storage tier: everything is instance storage

Every read and write in `proposals` goes through `env.storage().instance()`. The contract never
calls `.persistent()`, `.temporary()`, `.extend_ttl()` or `bump()` (verified across `lib.rs` and
`storage.rs`).

**TTL / bump behaviour:**

- All keys below share the **single TTL of the contract's instance entry**. There is no per-key
  TTL, no TTL constant, and nothing in this contract extends the TTL — not on `create_proposal`,
  not on `vote`, not on any read.
- Keeping the instance alive is therefore a platform/operator concern (an out-of-band
  `extend` / restore of the contract instance). If the instance entry archives, **every** key
  (admin, id counter, all proposals, all votes) archives together and calls fail until it is
  restored. See [`concepts-state-archival.md`](concepts-state-archival.md).
- Because votes and proposals live in instance storage, the instance entry grows with each
  proposal and each vote. Large numbers of voters make the single entry bigger and every
  invocation costlier; see [`concepts-resource-budget.md`](concepts-resource-budget.md).
- `initialize` cannot be used to revive state: it panics (`"already initialized"`) if
  `DataKey::Admin` is present.

## `DataKey` — storage key inventory

```rust
#[contracttype]
pub enum DataKey {
    Admin,
    NextProposalId,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) -> bool (true = yes, false = no)
}
```

| Key | Value type | Tier | Meaning | Lifecycle |
|---|---|---|---|---|
| `DataKey::Admin` | `Address` | instance | Reserved admin slot. No function currently reads it for authorization. | Set once by `initialize` (requires the admin's auth). Never updated. Its presence is the "already initialized" guard. |
| `DataKey::NextProposalId` | `u64` | instance | Id that will be assigned to the next proposal; equals the count of proposals ever created. | Set to `0` by `initialize`. Read and incremented by `create_proposal` (ids are `0`-based, monotonically increasing, never reused). |
| `DataKey::Proposal(u64)` | `Proposal` | instance | Full record for proposal `id`. | Created by `create_proposal`. Rewritten whole by `vote`, `finalize_proposal`, `finalize_expired_proposal`, `execute_proposal` and `execute_withdraw`. Read by every function through `load_proposal`, which panics with `"proposal not found"` for unknown ids. Never deleted. |
| `DataKey::Vote(u64, Address)` | `bool` | instance | The vote `voter` cast on proposal `proposal_id`: `true` = yes, `false` = no. | Written once by `vote`. Its mere existence (`has`) is the duplicate-vote guard (`"voter has already voted"`). Never changed or cleared. |

There is no index of voters per proposal and no list of proposals: the only way to enumerate is
to walk ids `0..NextProposalId` and look up `Vote(id, address)` for a known address. Only the
yes/no *tallies* are kept on the `Proposal` itself.

## `Proposal`

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

| Field | Type | Set by | Notes |
|---|---|---|---|
| `id` | `u64` | `create_proposal` | Copy of the `NextProposalId` value at creation. |
| `proposer` | `Address` | `create_proposal` | Must authorize the creation call. Not checked against treasury membership. |
| `description` | `String` | `create_proposal` | Free text; stored as given. |
| `created_at` | `u64` | `create_proposal` | Ledger timestamp (unix seconds) at creation. |
| `expires_at` | `u64` | `create_proposal` | Unix seconds; must be strictly greater than the creation time. Voting is allowed while `now < expires_at`. |
| `yes_votes` | `u32` | `vote` | Incremented per `support = true` vote. |
| `no_votes` | `u32` | `vote` | Incremented per `support = false` vote. |
| `status` | `ProposalStatus` | all state-changing calls | See below. Starts as `Active`. |
| `treasury` | `Address` | `create_proposal` | `group_treasury` contract to withdraw from on execution. |
| `token` | `Address` | `create_proposal` | Token contract to withdraw. |
| `to` | `Address` | `create_proposal` | Withdrawal recipient. |
| `amount` | `i128` | `create_proposal` | Must be `> 0`. |

The four withdrawal parameters are fixed at creation. They are never updated, and they are what
`execute_withdraw` hands to the treasury client.

## `ProposalStatus`

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Approved,
    Passed,
    Rejected,
    Executed,
    Expired,
}
```

| Value | Meaning | Reached by |
|---|---|---|
| `Active` | Open for voting; the initial state. | `create_proposal` |
| `Passed` | Voting closed with `yes_votes > no_votes`. The only state from which execution is allowed. | `finalize_proposal` |
| `Rejected` | Voting closed with `yes_votes <= no_votes` (ties reject). Terminal. | `finalize_proposal` |
| `Expired` | Voting window passed and the proposal was closed without a tally. Terminal. | `finalize_expired_proposal` |
| `Executed` | Execution has run. Terminal. | `execute_proposal` or `execute_withdraw` |
| `Approved` | **Declared but never assigned.** No function in `lib.rs` writes it. | — (see note) |

> **Note on `Approved`.** The doc comment on `execute_withdraw` says the proposal "must be
> Approved", but the code checks for `Passed`, and nothing ever sets `Approved`. Treat
> `Approved` as a reserved, currently unreachable value. Clients should not wait for it.

### Transitions

```
                    finalize_proposal                     execute_proposal
                    (now >= expires_at,                   or execute_withdraw
                     yes > no)                            (status == Passed)
   create_proposal ┌────────────────────▶ Passed ──────────────────────────▶ Executed
 ─────────────────▶ Active
                    │ finalize_proposal (now >= expires_at, yes <= no)
                    ├────────────────────▶ Rejected
                    │ finalize_expired_proposal (now > expires_at)
                    └────────────────────▶ Expired
```

| From | To | Function | Guard |
|---|---|---|---|
| (none) | `Active` | `create_proposal` | `expires_at > now`, `amount > 0`, proposer auth |
| `Active` | `Passed` | `finalize_proposal` | `now >= expires_at` and `yes_votes > no_votes` |
| `Active` | `Rejected` | `finalize_proposal` | `now >= expires_at` and `yes_votes <= no_votes` |
| `Active` | `Expired` | `finalize_expired_proposal` | `now > expires_at` |
| `Passed` | `Executed` | `execute_proposal` | executor auth; status must be `Passed` |
| `Passed` | `Executed` | `execute_withdraw` | caller auth; treasury membership, balance, and successful treasury `withdraw` |

Points worth knowing:

- Both `finalize_proposal` and `finalize_expired_proposal` accept only `Active` proposals. For
  any `now > expires_at` **both** are valid, and whichever is called first decides the outcome
  (`Passed`/`Rejected` vs `Expired`). At exactly `now == expires_at` only `finalize_proposal`
  works. Both are callable by anyone and require no auth.
- `vote` is only valid while `status == Active` **and** `now < expires_at`.
- `Rejected`, `Expired` and `Executed` have no outgoing transitions.
- `execute_proposal` only flips the status and emits an event; it moves no funds. Only
  `execute_withdraw` calls the treasury.
- The status check in `execute_withdraw` panics `"proposal already executed"` for `Executed`
  and `"proposal not approved"` for anything other than `Passed`. Because the status is only
  written after the treasury call succeeds, and a panic reverts the whole invocation, a failed
  withdrawal leaves the proposal `Passed` and retryable.

## Vote tracking

1. `vote(voter, proposal_id, support)` calls `voter.require_auth()` and loads the proposal.
2. It requires `Active` status and `now < expires_at`.
3. It builds `DataKey::Vote(proposal_id, voter)` and panics if that key already exists.
4. It stores `support` (`bool`) under that key, bumps `yes_votes` or `no_votes` on the
   `Proposal`, and writes the proposal back.
5. It emits `vote_cast`.

The `Vote` entry is the source of truth for "has this address voted" and for *how* it voted.
The counters on `Proposal` are the source of truth for the tally used by `finalize_proposal`.
Note that **`vote` does not check treasury membership** — any authorized address can vote, and
each address counts once. Membership is only checked at execution time, for the `caller` of
`execute_withdraw`.

## Event payload structs

Also defined in `storage.rs` (not stored, only published):

| Struct | Fields | Published as | By |
|---|---|---|---|
| `ProposalCreatedEvent` | `id`, `proposer`, `expires_at`, `treasury`, `token`, `to`, `amount` | `proposal_created` | `create_proposal` |
| `VoteCastEvent` | `id`, `voter`, `support` | `vote_cast` | `vote` |
| `ProposalFinalizedEvent` | `id`, `status`, `yes_votes`, `no_votes` | `proposal_finalized` | `finalize_proposal` |
| `ProposalExpiredEvent` | `id` | `proposal_expired` | `finalize_expired_proposal` |
| `ProposalExecutedEvent` | `id`, `executor` | `executed` (`execute_proposal`) / `execut` (`execute_withdraw`) | execution |

The two execution paths use different topic symbols (`executed` vs `execut`); see
[`contracts-events.md`](contracts-events.md) for the full event catalogue.

## Typed cross-contract client for `group_treasury`

### What is in the source

- [`treasury_interface.rs`](../contracts/proposals/src/treasury_interface.rs) is the real
  mechanism. It declares a trait annotated with `#[contractclient(name = "TreasuryClient")]`:

  ```rust
  #[contractclient(name = "TreasuryClient")]
  pub trait TreasuryInterface {
      fn is_member(env: Env, member: Address) -> bool;
      fn balance(env: Env, token: Address) -> i128;
      fn withdraw(env: Env, to: Address, token: Address, amount: i128);
  }
  ```

  The `soroban-sdk` macro generates a `TreasuryClient` struct from it. The trait is never
  implemented; it exists only to describe the callee's function names and signatures.
- [`treasury_interface_client.rs`](../contracts/proposals/src/treasury_interface_client.rs) is
  **an empty placeholder** whose entire content is the comment
  `// Intentionally left empty - this file was generated automatically.` It is not declared as a
  module in `lib.rs` (`lib.rs` has `mod treasury_interface;` only), so it is not compiled and
  nothing is imported from it. The client lives in the macro expansion of
  `treasury_interface.rs`, not in this file.

The interface is hand-maintained: it is a minimal subset of `group_treasury`'s public functions
(`is_member`, `balance`, `withdraw`) and is **not** checked against the real contract at compile
time. If `group_treasury` renames or re-types one of these functions, `proposals` still
compiles and the mismatch only surfaces at runtime as a failed invocation.

### How the contract ID is resolved and invoked

There is no registry or lookup. The target contract is whatever `Address` is stored in
`Proposal.treasury`, supplied by the proposer at `create_proposal`. In `execute_withdraw`:

1. `proposal.treasury` is loaded from instance storage.
2. `TreasuryClient::new(&env, &proposal.treasury)` wraps that address. Constructing a client
   does no I/O and does not check that the address is a deployed treasury.
3. Each method call (`is_member`, `balance`, `withdraw`) compiles to
   `env.invoke_contract(&address, &Symbol::new("<fn name>"), args)`. The client converts the
   Rust arguments to `Val`s, invokes the function by name on that contract, and converts the
   return value back (e.g. to `bool` or `i128`). The call is synchronous and runs inside the
   caller's transaction.
4. If the callee panics, errors, or the address is not a contract exporting that function, the
   panic propagates up the host stack and aborts the entire `execute_withdraw` invocation. All
   state changes revert, including the status update, and no event is emitted.

The call sequence in `execute_withdraw(caller, proposal_id)`:

| Step | Call | Check |
|---|---|---|
| 1 | `caller.require_auth()` | Caller authorized the `proposals` call |
| 2 | local | Status is `Passed` (`Executed` panics `"proposal already executed"`) |
| 3 | `TreasuryClient::is_member(caller)` | else `"caller is not a treasury member"` |
| 4 | `TreasuryClient::balance(token)` | `>= amount`, else `"insufficient funds"` |
| 5 | `TreasuryClient::withdraw(to, token, amount)` | Treasury moves funds |
| 6 | local | Status set to `Executed`, stored |
| 7 | event | `execut` / `ProposalExecutedEvent` |

### Authorization of the nested `withdraw` call

`group_treasury::withdraw` is admin-gated: it calls `admin.require_auth()` on the treasury's
stored admin. In step 5 that is a **non-root** invocation (the root is `proposals`'
`execute_withdraw`). The treasury admin's authorization must therefore be present for that
sub-invocation, for example by having the admin sign an authorization entry covering
`treasury.withdraw(to, token, amount)`, or by making the admin a contract that authorizes the
call. The tests use `env.mock_all_auths_allowing_non_root_auth()` for exactly this reason (see
the comment in [`proposals/src/test.rs`](../contracts/proposals/src/test.rs)). Holding a `Passed`
proposal is not by itself sufficient to move treasury funds.

The `Proposal.treasury` address is also not validated against any allow-list, so a proposal can
point at any contract. The membership and balance checks protect against a *real* treasury being
drained, not against a malicious one; voters should verify the `treasury` field before voting.
See [`security-checklist.md`](security-checklist.md).

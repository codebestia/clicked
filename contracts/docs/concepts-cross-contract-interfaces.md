# Cross-Contract Interfaces & the Two Withdrawal Paths

Source:
[`group_treasury/src/token_interface.rs`](../contracts/group_treasury/src/token_interface.rs),
[`token_transfer/src/token_interface.rs`](../contracts/token_transfer/src/token_interface.rs),
[`proposals/src/treasury_interface.rs`](../contracts/proposals/src/treasury_interface.rs),
[`proposals/src/treasury_interface_client.rs`](../contracts/proposals/src/treasury_interface_client.rs),
plus the callers in each contract's `lib.rs`.

The three contracts call each other through small typed clients rather than by importing each
other's crates. This page explains those clients, then resolves a source of confusion: there are
**two independent ways to move treasury funds**, and neither triggers the other.

Related: [`contracts-proposals-storage.md`](contracts-proposals-storage.md) (storage and the
client call sequence in detail), [`concepts-treasury-multisig-model.md`](concepts-treasury-multisig-model.md),
[`concepts-proposal-lifecycle.md`](concepts-proposal-lifecycle.md),
[`concepts-token-transfer-flow.md`](concepts-token-transfer-flow.md).

## The mechanism: `#[contractclient]`

Soroban contracts call one another by contract address, function name and arguments. To avoid
writing raw `invoke_contract` calls, each caller declares a trait describing only the callee
functions it needs and annotates it with `#[contractclient(name = "...")]`. The SDK macro
generates a client struct with one method per trait function:

```rust
let client = TokenClient::new(&env, &token_address);   // no I/O, no validation
client.transfer(&from, &to, &amount);                   // invokes "transfer" on that contract
```

Properties common to all of the interfaces below:

- **The trait is never implemented.** It exists only to generate the client.
- **The address is data, not code.** It comes from storage or arguments. Nothing verifies at
  compile time or at `new()` that the address is the contract you expect.
- **Interfaces are hand-maintained subsets.** They are not derived from the real contract. If
  the callee renames or re-types a function, the caller still compiles and fails at runtime.
- **Calls are synchronous and atomic.** A panic in the callee aborts the whole transaction;
  state changes made earlier in the caller revert too.
- **Return values are typed by the trait.** The client converts the result into the declared
  Rust type.

## Interface inventory

| Interface file | Client | Used by | Calls into | Functions declared |
|---|---|---|---|---|
| `group_treasury/src/token_interface.rs` | `TokenClient` | `group_treasury::deposit`, `withdraw` | An external SEP-41 token contract (address passed per call) | `transfer(from, to, amount)`, `balance(id) -> i128` |
| `token_transfer/src/token_interface.rs` | `TokenClient` | `token_transfer::transfer`, `balance` | The SEP-41 token whose address is stored as `DataKey::TokenContract` | same two functions |
| `proposals/src/treasury_interface.rs` | `TreasuryClient` | `proposals::execute_withdraw` | A `group_treasury` contract (address from `Proposal.treasury`) | `is_member(member) -> bool`, `balance(token) -> i128`, `withdraw(to, token, amount)` |
| `proposals/src/treasury_interface_client.rs` | — | nothing | — | empty placeholder, see below |

### The two `token_interface.rs` files

They are byte-for-byte the same "minimal SEP-41" subset: `transfer` and `balance`. Each crate
gets its own generated `TokenClient`, which is why the file is duplicated rather than shared.
Note the difference in *where the token address comes from*:

- `group_treasury` is multi-token. The token address is an argument to `deposit`, `withdraw` and
  the balance accessors, and the treasury tracks per-token balances itself in
  `DataKey::Balances`.
- `token_transfer` is single-token. The address is fixed at `initialize` and changeable by
  `set_token_contract`, stored in instance storage. It keeps no balances of its own;
  `balance` reads straight from the token.

In both, the token's `transfer(from, ...)` enforces `from`'s authorization. For `deposit` and
`token_transfer::transfer` that is the user, who has signed. For the treasury's `withdraw`, `from`
is the treasury contract itself (`env.current_contract_address()`), which the host authorizes
automatically as the direct caller.

### `treasury_interface.rs` and the empty `treasury_interface_client.rs`

`treasury_interface.rs` is the real definition: it declares `TreasuryInterface` and generates
`TreasuryClient`. `lib.rs` includes it with `mod treasury_interface;` and calls it as
`crate::treasury_interface::TreasuryClient::new(&env, &proposal.treasury)`.

`treasury_interface_client.rs` contains only the comment
`// Intentionally left empty - this file was generated automatically.` It is not declared as a
module, is not compiled, and nothing depends on it. Despite its name and the comment, the client
is **not** hand-written in that file; it exists only as macro output of `treasury_interface.rs`.
The file can be deleted without any effect. The caution is real, though: because the interface is
a hand-maintained subset, `proposals` and `group_treasury` can drift without a compile error.

## Two ways to move treasury funds

`group_treasury` holds the funds. There are three distinct entry points in play, which form two
mechanisms for deciding that a withdrawal should happen.

### Path A — the treasury's own multisig (`propose_withdraw` / `approve_withdraw` / `reject_withdraw`)

1. A **member** calls `propose_withdraw(proposer, to, token, amount, ttl_ledgers)`. The treasury
   checks membership, `amount > 0` and sufficient balance, stores a `WithdrawProposal`, and counts
   the proposer as the first approval.
2. Members call `approve_withdraw` or `reject_withdraw` (one vote each).
3. When `approvals >= threshold`, status becomes `Passed`. When `rejections` reaches the
   blocking minority (`members - threshold + 1`), status becomes `Rejected`.

**This path does not move funds.** There is no function that reads a `Passed` `WithdrawProposal`
and transfers tokens. `Executed` exists in the treasury's `ProposalStatus` but nothing sets it,
and `Expired` is likewise never assigned. A `Passed` proposal is currently a recorded decision only,
which an off-chain actor or the admin can act on. Votes and decisions are on-chain
and verifiable; actually releasing the money still requires `withdraw` (Path C).

### Path B — the `proposals` contract (`execute_withdraw`)

1. **Anyone** calls `proposals::create_proposal(... treasury, token, to, amount)`. This records
   the intended withdrawal in the `proposals` contract's own storage. It is not registered with the
   treasury, and the treasury has no knowledge of it.
2. Authorized addresses vote in `proposals` (no membership check) until `expires_at`.
3. `finalize_proposal` marks it `Passed` if `yes_votes > no_votes`.
4. A caller who is a **treasury member** calls `proposals::execute_withdraw(caller, proposal_id)`.
   `proposals` uses `TreasuryClient` to check `is_member(caller)` and `balance(token)`, then
   calls `treasury.withdraw(to, token, amount)` and marks its own proposal `Executed`.

### Path C — what Path B actually calls: the admin-gated `withdraw`

`group_treasury::withdraw(to, token, amount)` is the only function that transfers funds out. It is
**admin-gated**: it calls `require_admin`, which runs `admin.require_auth()` on the address stored
at `DataKey::Admin`. It checks `amount > 0` and the recorded balance, calls the token's
`transfer`, decrements `Balances`, and emits `withdraw`.

Because `proposals` invokes it as a nested call, the **treasury admin's authorization must
accompany the transaction** (a signed auth entry for that sub-invocation, or an admin that is a
contract able to authorize it). `proposals` being the caller is not sufficient, and `proposals`
is not automatically the admin. The `proposals` tests use
`mock_all_auths_allowing_non_root_auth()` because of this.

### How they relate

```
 Path A  (inside group_treasury)           Path B  (inside proposals)
 propose_withdraw ─▶ approve/reject ─▶     create_proposal ─▶ vote ─▶ finalize_proposal
 Passed / Rejected                         Passed / Rejected / Expired
 (recorded decision, moves nothing)                │
                                                   ▼  execute_withdraw (caller is a member)
                                           TreasuryClient.is_member / balance
                                                   │
                                                   ▼
                      Path C: group_treasury.withdraw  (needs treasury admin auth)
                                         │
                                         ▼
                             TokenClient.transfer(treasury → to)
```

| | Path A: treasury multisig | Path B: `proposals` contract |
|---|---|---|
| Where state lives | `group_treasury` (`DataKey::Proposal(u32)`) | `proposals` (`DataKey::Proposal(u64)`) |
| Who can propose | Treasury members | Any authorized address |
| Who can vote | Treasury members (checked at vote time) | Any authorized address, once each |
| Decision rule | `approvals >= threshold` (fixed at init) | `yes_votes > no_votes` after `expires_at` (no quorum) |
| Early outcome | Passes/rejects as soon as the threshold is reached | Only after `expires_at` |
| Moves funds? | No | Yes, via `withdraw` |
| Needs admin auth? | No | Yes (nested `withdraw`) |
| Cross-contract calls | None | `is_member`, `balance`, `withdraw` on the treasury |
| Proposal ids | `u32`, in the treasury | `u64`, in `proposals` |

The two systems are **parallel, not layered**:

- `proposals` never calls `propose_withdraw`, `approve_withdraw` or `reject_withdraw`.
- A `Passed` proposal in one system has no effect on the other. Passing Path A does not authorize
  Path B, and an `Executed` proposal in `proposals` does not mark anything in the treasury.
- Nothing prevents both from being used for the same withdrawal, or from disagreeing, because
  neither consults the other. The balance the treasury enforces at `withdraw` is the only shared
  safeguard.

### Practical consequences

- **The effective gate is the treasury admin, not either vote.** Both paths ultimately depend on
  the admin address being willing to authorize `withdraw`. Today the on-chain votes are advisory
  with respect to that final authorization. The deployment script or the admin's configuration
  decides how binding they are.
- **Path B's `proposals` vote is weaker than the treasury's.** It has no membership requirement
  on voters, no quorum, and the `treasury` address is user-supplied. Path A is the stronger
  control against outsiders; Path B is the only one that can complete a transfer without the
  admin signing a separate transaction, and only if the admin's authorization is included.
- **Failure is clean.** If `withdraw` panics (no admin auth, insufficient funds), the whole
  `execute_withdraw` reverts and the proposal stays `Passed` so it can be retried.
- **Choose one path per deployment** and document it for your members. If you want Path A's
  threshold to actually bind, the admin must be a contract or process that releases funds only
  for a `Passed` `WithdrawProposal`; this repository does not yet provide one.
- **Drift risk.** Neither `TreasuryInterface` nor either `TokenInterface` is checked against the
  real contract. When changing a function signature in `group_treasury` (`is_member`, `balance`,
  `withdraw`) or the token calls, update the interface file and the cross-contract tests together.

See [`security-checklist.md`](security-checklist.md) for review items that follow from this.

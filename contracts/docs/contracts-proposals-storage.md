# Proposals Contract: Storage Layout & Treasury Interface

This document describes the on-chain storage structures for the `proposals` contract, including the `Proposal` and `ProposalStatus` data types, vote-tracking storage, and the typed cross-contract client used to invoke the `group_treasury` contract.

---

## Table of Contents

- [Storage Keys](#storage-keys)
- [Data Structures](#data-structures)
  - [ProposalStatus](#proposalstatus)
  - [Proposal](#proposal)
  - [Vote Tracking](#vote-tracking)
- [Status Transitions](#status-transitions)
- [Events](#events)
- [Treasury Interface](#treasury-interface)
  - [TreasuryInterface Trait](#treasuryinterface-trait)
  - [Cross-Contract Call Mechanism](#cross-contract-call-mechanism)
- [Storage Type & TTL/Bump Behavior](#storage-type--ttlbump-behavior)

---

## Storage Keys

All persistent contract state is stored via `env.storage().instance()`, which provides key-value storage scoped to the contract instance.

```rust
#[contracttype]
pub enum DataKey {
    Admin,
    NextProposalId,
    Proposal(u64),
    Vote(u64, Address), // (proposal_id, voter) -> bool (true = yes, false = no)
}
```

| Key | Type | Description |
|-----|------|-------------|
| `Admin` | `Address` | The contract administrator. Set once during `initialize()` and never modified. Reserved for future admin-only governance hooks. |
| `NextProposalId` | `u64` | Monotonically incrementing counter. Each new proposal consumes the current value and increments it by 1. |
| `Proposal(u64)` | `Proposal` | Stores the full `Proposal` struct for the given proposal ID. |
| `Vote(u64, Address)` | `bool` | Maps `(proposal_id, voter_address)` to a boolean indicating their vote: `true` = yes, `false` = no. Exists only while the vote is active; checked for existence to enforce one-vote-per-address. |

---

## Data Structures

### ProposalStatus

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

| Variant | Description |
|---------|-------------|
| `Active` | Initial status when a proposal is created. Voting is permitted only in this state. |
| `Approved` | Reserved for proposals that have passed a quorum or governance check (currently unused in code; see note below). |
| `Passed` | Set by `finalize_proposal()` when `yes_votes > no_votes` after the voting window closes. A prerequisite for `execute_proposal()` and `execute_withdraw()`. |
| `Rejected` | Set by `finalize_proposal()` when `yes_votes <= no_votes` (including ties and zero votes) after the voting window closes. |
| `Executed` | Set by `execute_proposal()` or `execute_withdraw()` after a `Passed` proposal is executed. Terminal state. |
| `Expired` | Set by `finalize_expired_proposal()` when an `Active` proposal is explicitly expired after its voting window closes without finalization. Terminal state. |

> **Note:** `Approved` is defined in the enum but is not assigned by any code path in the current implementation. It is reserved for future use where proposals might be approved through an alternative governance mechanism (e.g., quorum-based approval) before being finalized. The `execute_withdraw()` function uses `Passed` as the check, not `Approved`, even though the acceptance criteria comments reference "Approved".

### Proposal

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

| Field | Type | Description |
|-------|------|-------------|
| `id` | `u64` | Unique proposal identifier. Assigned from `NextProposalId` and auto-incremented. |
| `proposer` | `Address` | The account that created the proposal. Required to authorize creation. |
| `description` | `String` | Human-readable proposal description. |
| `created_at` | `u64` | Unix timestamp when the proposal was created. Set to `env.ledger().timestamp()` at creation time. |
| `expires_at` | `u64` | Unix timestamp when the voting window closes. Must be strictly greater than `created_at`. |
| `yes_votes` | `u32` | Running tally of "yes" votes. Incremented by `vote()` when `support = true`. |
| `no_votes` | `u32` | Running tally of "no" votes. Incremented by `vote()` when `support = false`. |
| `status` | `ProposalStatus` | Current status of the proposal. See [Status Transitions](#status-transitions). |
| `treasury` | `Address` | Address of the group treasury contract to call for `execute_withdraw()`. |
| `token` | `Address` | Address of the token contract to withdraw from the treasury. |
| `to` | `Address` | Destination address for the withdrawal. |
| `amount` | `i128` | Amount to withdraw (must be positive). |

### Vote Tracking

Votes are stored as individual entries keyed by `(proposal_id, voter_address)`:

```rust
DataKey::Vote(proposal_id, voter_address) -> bool  // true = yes, false = no
```

**Key behaviors:**

- **One vote per address:** The contract checks `env.storage().instance().has(&vote_key)` before allowing a vote. If the key already exists, the transaction panics with `"voter has already voted"`.
- **Voting window enforcement:** Voting is only permitted while `env.ledger().timestamp() < proposal.expires_at`. Attempting to vote after expiry panics with `"voting window has closed"`.
- **Status check:** Voting is only permitted when `proposal.status == Active`. Voting on a finalized or expired proposal panics with `"proposal is not active"`.
- **No vote deletion:** Votes are never removed from storage; they persist for the lifetime of the contract instance. The vote count is tracked on the `Proposal` struct for efficient tallying, and individual vote records are retained for auditability.

---

## Status Transitions

```
                    ┌─────────────────────┐
                    │                     │
                    ▼                     │
    create_proposal()                    │
                    │                     │
                    ▼                     │
              ┌──────────┐               │
              │  Active   │──────────────┘
              └──────────┘
               │       │       │
               │       │       ▼
               │       │  finalize_expired_proposal()
               │       │       │
               │       │       ▼
               │       │  ┌─────────┐
               │       │  │ Expired │
               │       │  └─────────┘
               │       │
               │       ▼
               │  finalize_proposal()
               │       │
               │       ├── yes > no ──────────┐
               │       │                       ▼
               │       │                 ┌──────────┐
               │       │                 │  Passed   │
               │       │                 └──────────┘
               │       │                       │
               │       │       ┌───────────────┤
               │       │       │               │
               │       │       ▼               ▼
               │       │  execute_proposal()  execute_withdraw()
               │       │       │               │
               │       │       ▼               ▼
               │       │  ┌──────────┐    ┌──────────┐
               │       │  │ Executed │    │ Executed │
               │       │  └──────────┘    └──────────┘
               │       │
               │       ├── yes <= no ──────────┐
               │       │                       ▼
               │       │                 ┌──────────┐
               │       │                 │ Rejected  │
               │       │                 └──────────┘
               │       │
```

**Transition rules:**

| From | To | Trigger | Condition |
|------|----|---------|-----------|
| `Active` | `Passed` | `finalize_proposal()` | `yes_votes > no_votes` AND `now >= expires_at` |
| `Active` | `Rejected` | `finalize_proposal()` | `yes_votes <= no_votes` AND `now >= expires_at` |
| `Active` | `Expired` | `finalize_expired_proposal()` | `now > expires_at` (explicit expiry) |
| `Passed` | `Executed` | `execute_proposal()` | Requires `executor` authorization |
| `Passed` | `Executed` | `execute_withdraw()` | Requires `caller` to be a treasury member; treasury must have sufficient balance |

**Guard rules (panics):**

| Operation | Condition | Error Message |
|-----------|-----------|---------------|
| `finalize_proposal()` | `status != Active` | `"proposal already finalized"` |
| `finalize_proposal()` | `now < expires_at` | `"cannot finalize before expiry"` |
| `finalize_expired_proposal()` | `status != Active` | `"proposal not Pending"` |
| `finalize_expired_proposal()` | `now <= expires_at` | `"proposal not expired"` |
| `execute_proposal()` | `status != Passed` | `"proposal is not in Passed state"` |
| `execute_withdraw()` | `status == Executed` | `"proposal already executed"` |
| `execute_withdraw()` | `status != Passed` | `"proposal not approved"` |
| `vote()` | `status != Active` | `"proposal is not active"` |
| `vote()` | `now >= expires_at` | `"voting window has closed"` |
| `vote()` | Vote key exists | `"voter has already voted"` |
| `create_proposal()` | `expires_at <= now` | `"expires_at must be in the future"` |
| `create_proposal()` | `amount <= 0` | `"amount must be positive"` |

---

## Events

All events are published via `env.events().publish()` and are indexed by the Soroban event log.

| Event | Symbol | Payload | Emitted By |
|-------|--------|---------|------------|
| `ProposalCreatedEvent` | `"proposal_created"` | `{ id, proposer, expires_at, treasury, token, to, amount }` | `create_proposal()` |
| `VoteCastEvent` | `"vote_cast"` | `{ id, voter, support }` | `vote()` |
| `ProposalFinalizedEvent` | `"proposal_finalized"` | `{ id, status, yes_votes, no_votes }` | `finalize_proposal()` |
| `ProposalExpiredEvent` | `"proposal_expired"` | `{ id }` | `finalize_expired_proposal()` |
| `ProposalExecutedEvent` | `"executed"` | `{ id, executor }` | `execute_proposal()` |
| `ProposalExecutedEvent` | `"execut"` | `{ id, executor }` | `execute_withdraw()` |

> **Note:** `execute_withdraw()` uses the symbol `"execut"` (truncated from `"executed"`) for the `ProposalExecutedEvent`, while `execute_proposal()` uses `"executed"`. This is likely an oversight but is the current behavior.

---

## Treasury Interface

### TreasuryInterface Trait

```rust
// treasury_interface.rs
use soroban_sdk::{contractclient, Address, Env};

#[contractclient(name = "TreasuryClient")]
pub trait TreasuryInterface {
    fn is_member(env: Env, member: Address) -> bool;
    fn balance(env: Env, token: Address) -> i128;
    fn withdraw(env: Env, to: Address, token: Address, amount: i128);
}
```

| Method | Signature | Description |
|--------|-----------|-------------|
| `is_member` | `(env: Env, member: Address) -> bool` | Returns `true` if `member` is a registered member of the treasury. Used by `execute_withdraw()` to verify the caller has permission to initiate a withdrawal. |
| `balance` | `(env: Env, token: Address) -> i128` | Returns the treasury's balance for the given `token`. Used by `execute_withdraw()` to verify sufficient funds before attempting withdrawal. |
| `withdraw` | `(env: Env, to: Address, token: Address, amount: i128)` | Executes a token transfer from the treasury to `to` for the specified `amount`. Called only after member and balance checks pass. |

### Cross-Contract Call Mechanism

The `treasury_interface_client.rs` file is auto-generated by the Soroban SDK at build time based on the `#[contractclient(name = "TreasuryClient")]` attribute on `TreasuryInterface`. The file is intentionally left empty (`// Intentionally left empty - this file was generated automatically.`) because the Soroban SDK's `soroban-sdk` proc macros generate the actual client implementation during compilation.

**How it works:**

1. **Trait definition:** `TreasuryInterface` is defined in `treasury_interface.rs` with the `#[contractclient(name = "TreasuryClient")]` attribute. This tells the Soroban SDK to generate a `TreasuryClient` struct.

2. **Client generation:** At build time, the SDK generates a `TreasuryClient` struct that:
   - Stores a contract address (`Address`) reference
   - Wraps each trait method to serialize arguments, perform a cross-contract `invoke` call to the target contract, and deserialize the return value
   - Handles Soroban host object management (passing `Address` and other types as host objects)

3. **Contract resolution:** The client is instantiated with a contract address:
   ```rust
   let treasury_client = TreasuryClient::new(&env, &proposal.treasury);
   ```
   The `proposal.treasury` field stores the `Address` of the group treasury contract. This address is set at proposal creation time and stored in the `Proposal` struct.

4. **Cross-contract invocation:** Each method call on the client (e.g., `treasury_client.is_member(&caller)`) performs:
   - Serialization of arguments into Soroban host objects
   - A cross-contract `invoke` to the treasury contract at the stored address
   - Deserialization of the return value
   - Propagation of authorization requirements (the treasury contract may require `require_auth()` on certain operations)

5. **Usage in `execute_withdraw()`:**
   ```rust
   // 1. Create client targeting the treasury contract
   let treasury_client = TreasuryClient::new(&env, &proposal.treasury);
   
   // 2. Verify caller is a treasury member
   if !treasury_client.is_member(&caller) {
       panic!("caller is not a treasury member");
   }
   
   // 3. Verify sufficient balance
   let bal = treasury_client.balance(&proposal.token);
   if bal < proposal.amount {
       panic!("insufficient funds");
   }
   
   // 4. Execute withdrawal
   treasury_client.withdraw(&proposal.to, &proposal.token, &proposal.amount);
   ```

   The treasury address is **immutable** once the proposal is created. There is no mechanism to change the treasury target after proposal creation.

---

## Storage Type & TTL/Bump Behavior

### Storage Namespace

All proposal contract data is stored under `env.storage().instance()`:

```rust
env.storage().instance().set(&key, &value);  // write
env.storage().instance().get(&key);           // read
env.storage().instance().has(&key);           // existence check
```

**`instance()` storage** in Soroban is **persistent key-value storage** scoped to the contract instance. Data persists across transactions for the lifetime of the contract instance and is not subject to TTL expiration by default.

### TTL/Bump Behavior

| Storage | TTL | Bump Behavior |
|---------|-----|---------------|
| `env.storage().instance()` | **No TTL** — data persists indefinitely for the contract instance lifetime | No bump required; data is permanent until explicitly deleted or the contract instance is removed |
| `env.storage().persistent()` | **Has TTL** — data expires after a configurable number of ledgers unless bumped | Used in mock token (test code only); not used by proposals contract |
| `env.storage().temporary()` | **Short-lived** — data expires after a short TTL and is automatically cleaned up | Not used by proposals contract |

**The proposals contract exclusively uses `instance()` storage**, meaning:

- **All proposal data, vote records, admin address, and the next proposal ID counter persist indefinitely.**
- **No TTL management or bumping is required** — data will not expire as long as the contract instance exists.
- **Storage costs are permanent** — each `Proposal` and `Vote` entry consumes storage that is never reclaimed (no cleanup mechanism exists in the current implementation).
- **Vote records accumulate** — each `Vote(proposal_id, address)` entry persists forever, even after the proposal is finalized. For a high-volume contract, this could lead to significant storage costs over time.

### Storage Cost Considerations

Given the permanent nature of `instance()` storage:

- **Proposal structs** are stored per-proposal and are never deleted.
- **Vote records** are stored per-voter-per-proposal and are never deleted.
- **The `NextProposalId` counter** is incremented but never reset.
- The `Admin` address is stored once and never changes.

For a production deployment, consider whether a storage cleanup mechanism (e.g., deleting old proposals and votes after a retention period) is needed to manage long-term storage costs on the Soroban network.
